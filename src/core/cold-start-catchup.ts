import { Database } from "bun:sqlite";
import {
  buildCatchupBackfillParams,
  getNewestMessageAnchor,
  type BackfillParams,
  type MessageAnchor,
} from "./storage/query.js";

export const PER_CHAT_BATCH = 50;
export const GLOBAL_TARGET = 500;
/** Per-chat ceiling so one loud room cannot eat the whole global budget. */
export const MAX_CATCHUP_BATCHES = 3;

/**
 * How a chat's catch-up ended. These are deliberately NOT collapsed into one bucket:
 * `gap-stalled` is paging being broken (a bug), `gap-not-closed` is the budget running out
 * (a capacity problem), `no-older-available` is the platform refusing to go further back
 * (a retention limit), and `not-in-message-boxes` is the platform never being asked properly.
 * One observation with several causes is exactly the trap this project exists to remove.
 *
 * `no-older-available` and `gap-not-closed` both mean the gap is still open; only the second
 * is worth spending more budget on. Neither may be reported to the user as "this is
 * everything" — that claim belongs to on-demand's `exhausted` and is not ours to make.
 */
export type CatchupOutcome =
  | "joined"
  | "no-newer"
  | "gap-not-closed"
  | "gap-stalled"
  | "no-older-available"
  | "not-in-message-boxes"
  | "failed";

export interface CatchupResult {
  chatPlatformId: string;
  outcome: CatchupOutcome;
  reason?: string;
  batches: number;
  landed: number;
}

export interface CatchupDeps {
  db: Database;
  sendRequest: (platform: string, method: string, params: unknown) => Promise<unknown>;
  ingest: (platform: string, event: unknown, source: string) => unknown;
  now?: () => number;
  log?: (msg: string, ...rest: unknown[]) => void;
}

interface ChatRow {
  platform_id: string;
  last_activity_at: number | null;
  last_message_at: number | null;
}

function buildAnchoredParams(
  chatPlatformId: string,
  anchor: MessageAnchor,
  count: number,
): BackfillParams {
  return {
    chat_id: chatPlatformId,
    before_timestamp: anchor.timestamp,
    before_message_id: anchor.platform_message_id,
    count,
  };
}

/** The chat looks like it has a hole: the platform reported activity we have no message for. */
function hasGapSignal(chat: ChatRow): boolean {
  return chat.last_activity_at != null
    && chat.last_message_at != null
    && chat.last_activity_at > chat.last_message_at;
}

/**
 * Cold start catch-up: pull what arrived while the daemon was down.
 *
 * Batch 1 deliberately omits `before_message_id` so the adapter falls back to the platform's
 * newest message; batch 2+ MUST carry a real anchor, otherwise every round re-requests the same
 * newest batch and the loop makes no progress at all (see docs/adapter-protocol.md).
 */
export async function catchUpAdapter(
  deps: CatchupDeps,
  platform: string,
): Promise<CatchupResult[]> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((msg: string, ...rest: unknown[]) => console.error(msg, ...rest));

  const record = (result: CatchupResult): CatchupResult => {
    db.prepare(
      "UPDATE chats SET catchup_state = ?, catchup_checked_at = ? WHERE platform = ? AND platform_id = ?"
    ).run(
      result.reason ? `${result.outcome}:${result.reason}` : result.outcome,
      now(),
      platform,
      result.chatPlatformId,
    );
    return result;
  };

  const chats = db.query<ChatRow, [string]>(
    `SELECT platform_id, last_activity_at, last_message_at
     FROM chats WHERE platform = ?
     ORDER BY (last_activity_at IS NOT NULL AND last_message_at IS NOT NULL
               AND last_activity_at > last_message_at) DESC,
              last_activity_at DESC NULLS LAST`
  ).all(platform);

  const results: CatchupResult[] = [];
  let totalBackfilled = 0;

  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i]!;

    if (totalBackfilled >= GLOBAL_TARGET) {
      // Not a bare break: a hole we never got round to must still be visible, or "never
      // attempted" reads as "no hole" in the gap query and K1 misjudges (誠實性約束 #2).
      for (const remaining of chats.slice(i)) {
        if (!hasGapSignal(remaining)) continue;
        results.push(record({
          chatPlatformId: remaining.platform_id,
          outcome: "gap-not-closed",
          reason: "budget-exhausted",
          batches: 0,
          landed: 0,
        }));
      }
      break;
    }

    const newestKnown = getNewestMessageAnchor(db, platform, chat.platform_id);
    // No known message means there is nothing to join back to. Fetching the whole history is
    // the on-demand path's job, not catch-up's (誠實性約束 #1).
    if (!newestKnown) continue;

    results.push(record(await catchUpChat()));

    async function catchUpChat(): Promise<CatchupResult> {
      let cursorAnchor: MessageAnchor | null = null;
      let batches = 0;
      let landed = 0;

      const done = (outcome: CatchupOutcome, reason?: string): CatchupResult => ({
        chatPlatformId: chat.platform_id,
        outcome,
        reason,
        batches,
        landed,
      });

      for (;;) {
        const params = cursorAnchor
          ? buildAnchoredParams(chat.platform_id, cursorAnchor, PER_CHAT_BATCH)
          : buildCatchupBackfillParams(chat.platform_id, PER_CHAT_BATCH);

        let events: { platform_message_id: string; timestamp: number }[];
        try {
          const result = (await deps.sendRequest(platform, "backfill", params)) as {
            events?: { platform_message_id: string; timestamp: number }[];
          };
          events = result?.events ?? [];
        } catch (err) {
          log(`[daemon] [${platform}] catch-up ${chat.platform_id} failed:`, err);
          return done("failed");
        }

        for (const event of events) {
          deps.ingest(platform, event, "backfill");
        }
        batches++;
        landed += events.length;
        // events.length, not landed rows: GLOBAL_TARGET is a request quota against the
        // upstream platform. Counting only new rows would ask the platform for more under
        // the same budget.
        totalBackfilled += events.length;

        if (events.length === 0) {
          // An empty first batch is NOT "the platform has nothing". Chats absent from
          // getMessageBoxes answer empty because we never asked properly — the "fake platform
          // limit" trap F4 already fixed once (誠實性約束 #3).
          return cursorAnchor === null
            ? done("not-in-message-boxes")
            : done("no-newer");
        }

        const oldest = events.reduce((a, b) => (b.timestamp < a.timestamp ? b : a));

        if (oldest.timestamp <= newestKnown!.timestamp) return done("joined");

        if (cursorAnchor && oldest.platform_message_id === cursorAnchor.platform_message_id) {
          // Paging is not advancing — but for two different reasons, and collapsing them would
          // disguise a retention limit as a broken loop.
          //
          // LINE's getPreviousMessages(endMessageId) is INCLUSIVE of the anchor, so a message
          // box holding nothing older answers with the anchor alone. That is the platform
          // declining to go further back, not a bug. An adapter that returns a whole batch yet
          // still nothing older than the anchor is misusing the boundary, and that IS a bug.
          //
          // Measured 2026-07-29: five LINE chats hit this branch, and every one of them had
          // exactly one event in the second batch.
          return events.length === 1
            ? done("no-older-available")
            : done("gap-stalled");
        }

        if (batches >= MAX_CATCHUP_BATCHES) return done("gap-not-closed", "max-batches");
        if (totalBackfilled >= GLOBAL_TARGET) return done("gap-not-closed", "budget-exhausted");

        cursorAnchor = { platform_message_id: oldest.platform_message_id, timestamp: oldest.timestamp };
      }
    }
  }

  for (const r of results) {
    log(
      `[daemon] [${platform}] catch-up ${r.chatPlatformId}: ${r.landed} msgs in ${r.batches} batch(es), ` +
      `outcome=${r.outcome}${r.reason ? `(${r.reason})` : ""}`
    );
  }
  log(`[daemon] [${platform}] cold start complete. ${totalBackfilled} messages backfilled.`);

  return results;
}
