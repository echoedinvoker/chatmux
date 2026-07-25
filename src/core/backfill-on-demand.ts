import { Database } from "bun:sqlite";
import {
  buildBackfillParams,
  getOldestMessageAnchor,
  resolveChatInternalId,
} from "./storage/query.js";

export type BackfillState = "unknown" | "partial" | "exhausted" | "unavailable";

export const PARTIAL_COOLDOWN_MS = 30_000;
export const UNAVAILABLE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/**
 * A backfill pushes to subscribers, subscribers re-read, and a re-read is a trigger —
 * so without this window the loop feeds itself for as long as the chat stays open.
 * It sits in front of the per-state cooldowns, which makes 60s the real floor for
 * `partial` retries.
 */
export const RECENTLY_BACKFILLED_TTL_MS = 60_000;
export const MAX_CONCURRENT_BACKFILLS = 2;
export const ON_DEMAND_BATCH = 50;

const inFlight = new Set<string>();
const recentlyBackfilled = new Map<string, number>();

export function isInFlight(chatId: string): boolean {
  return inFlight.has(chatId);
}

export function markInFlight(chatId: string): void {
  inFlight.add(chatId);
}

export function clearInFlight(chatId: string): void {
  inFlight.delete(chatId);
}

/** Test-only: the module owns its in-flight and cooldown state, so tests must reset it. */
export function __resetBackfillState(): void {
  inFlight.clear();
  recentlyBackfilled.clear();
}

interface ChatRef {
  internalId: number;
  platform: string;
  platformId: string;
  state: BackfillState;
  attemptedAt: number | null;
}

function loadChat(db: Database, chatId: string): ChatRef | null {
  const internalId = resolveChatInternalId(db, chatId);
  if (internalId == null) return null;

  const row = db
    .query<
      {
        platform: string;
        platform_id: string;
        backfill_state: string | null;
        backfill_attempted_at: number | null;
      },
      [number]
    >(
      "SELECT platform, platform_id, backfill_state, backfill_attempted_at FROM chats WHERE id = ?"
    )
    .get(internalId)!;

  return {
    internalId,
    platform: row.platform,
    platformId: row.platform_id,
    state: (row.backfill_state as BackfillState | null) ?? "unknown",
    attemptedAt: row.backfill_attempted_at,
  };
}

export function needsBackfill(db: Database, chatId: string, now: number = Date.now()): boolean {
  if (inFlight.has(chatId)) return false;
  if (inFlight.size >= MAX_CONCURRENT_BACKFILLS) return false;

  const recent = recentlyBackfilled.get(chatId);
  if (recent != null && now - recent < RECENTLY_BACKFILLED_TTL_MS) return false;

  const chat = loadChat(db, chatId);
  if (!chat) return false;

  switch (chat.state) {
    case "exhausted":
      return false;
    case "unavailable":
      return chat.attemptedAt == null || now - chat.attemptedAt >= UNAVAILABLE_COOLDOWN_MS;
    case "partial":
      return chat.attemptedAt == null || now - chat.attemptedAt >= PARTIAL_COOLDOWN_MS;
    default:
      return true;
  }
}

export interface BackfillDeps {
  db: Database;
  sendRequest: (platform: string, method: string, params: unknown) => Promise<unknown>;
  ingest: (platform: string, event: unknown, source: string) => unknown;
  notify: (chatId: string) => void;
  now?: () => number;
  log?: (msg: string, ...rest: unknown[]) => void;
}

/**
 * Fetch one batch of older history for a chat and record how far it got.
 *
 * Deliberately one batch per call: a chat left open would otherwise page backwards
 * forever in the background. Walking further back is the user opening it again.
 */
export async function backfillChat(deps: BackfillDeps, chatId: string): Promise<void> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((msg: string, ...rest: unknown[]) => console.error(msg, ...rest));

  const chat = loadChat(db, chatId);
  if (!chat) return;
  if (inFlight.has(chatId) || inFlight.size >= MAX_CONCURRENT_BACKFILLS) return;

  inFlight.add(chatId);
  const before = getOldestMessageAnchor(db, chat.platform, chat.platformId);

  try {
    const params = buildBackfillParams(db, chat.platform, chat.platformId, ON_DEMAND_BATCH);
    const result = (await deps.sendRequest(chat.platform, "backfill", params)) as {
      events?: unknown[];
      has_more?: boolean;
    };

    const events = result?.events ?? [];
    for (const event of events) {
      deps.ingest(chat.platform, event, "backfill");
    }

    const after = getOldestMessageAnchor(db, chat.platform, chat.platformId);
    const progressed = after?.platform_message_id !== before?.platform_message_id;

    let state: BackfillState;
    if (!progressed) {
      // Nothing older arrived. With an anchor that means the chat bottoms out here;
      // without one the platform declined to hand over any history at all.
      state = before ? "exhausted" : "unavailable";
    } else {
      state = result?.has_more ? "partial" : "exhausted";
    }

    db.prepare(
      "UPDATE chats SET backfill_state = ?, backfill_attempted_at = ?, backfill_oldest_id = ? WHERE id = ?"
    ).run(state, now(), after?.platform_message_id ?? null, chat.internalId);

    log(
      `[daemon] [${chat.platform}] on-demand backfill ${chatId}: ${events.length} msgs, state=${state}`
    );

    recentlyBackfilled.set(chatId, now());

    // A state change with zero landed messages still has to reach the consumer:
    // `unavailable` is by definition the empty case, and a banner stuck on
    // "backfilling…" is exactly the dishonest screen this feature exists to remove.
    if (progressed || state !== chat.state) {
      deps.notify(chatId);
    }
  } catch (err) {
    // A transient failure must never be recorded as `unavailable` — that claim reaches
    // the user's screen. Only the attempt timestamp moves, so the cooldown still applies.
    db.prepare("UPDATE chats SET backfill_attempted_at = ? WHERE id = ?").run(now(), chat.internalId);
    recentlyBackfilled.set(chatId, now());
    log(`[daemon] [${chat.platform}] on-demand backfill ${chatId} failed:`, err);
  } finally {
    inFlight.delete(chatId);
  }
}
