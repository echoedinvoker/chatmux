import { Database } from "bun:sqlite";
import { listChats, getMessages, searchMessages, getStatus, getEventsSince, getHeadSeq, resolveChatInternalId, type ChatRow, type MessageRow, type SearchResult } from "../storage/query.js";
import type { SafetyRail } from "../safety.js";
import type { JsonlEvent } from "../storage/jsonl.js";
import { isInFlight } from "../backfill-on-demand.js";

interface ChatOutput {
  id: string;
  type: string;
  name: string | null;
  platform: string;
  last_message: { text: string | null; timestamp: number; sender: string | null } | null;
  message_count: number;
}

interface ListChatsResult {
  chats: ChatOutput[];
  total: number;
  limit: number;
  offset: number;
}

// last_message 一律讀 row.last_message_at（最後一則落地訊息），不是 last_activity_at。
// 時間戳與 last_message_text／lastSender 都必須來自同一則 message；改讀 activity 會
// 讓 adapter 自報的動靜時間配上一則更舊的訊息文字，即 F21 的原始症狀。
function formatChat(row: ChatRow, db: Database): ChatOutput {
  const compositeId = `${row.platform}:${row.platform_id}`;

  let lastMessage: ChatOutput["last_message"] = null;
  if (row.last_message_at != null) {
    const lastSender = db.query<{ display_name: string } | null, [number]>(
      `SELECT c.display_name FROM messages m
       JOIN contacts c ON c.id = m.sender_id
       WHERE m.chat_id = ? ORDER BY m.timestamp DESC LIMIT 1`
    ).get(row.id);

    lastMessage = {
      text: row.last_message_text,
      timestamp: row.last_message_at,
      sender: lastSender?.display_name ?? null,
    };
  }

  return {
    id: compositeId,
    type: row.type,
    name: row.name,
    platform: row.platform,
    last_message: lastMessage,
    message_count: row.message_count,
  };
}

export function handleListChats(
  db: Database,
  params: { platform?: string; search?: string; limit?: number; offset?: number },
): ListChatsResult {
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  const rows = listChats(db, { platform: params.platform, search: params.search, limit, offset });

  const totalRow = (() => {
    let sql = "SELECT COUNT(*) as count FROM chats WHERE 1=1";
    const p: unknown[] = [];
    if (params.platform) { sql += " AND platform = ?"; p.push(params.platform); }
    if (params.search) { sql += " AND name LIKE '%' || ? || '%'"; p.push(params.search); }
    return db.query<{ count: number }, unknown[]>(sql).get(...p)!;
  })();

  return {
    chats: rows.map(r => formatChat(r, db)),
    total: totalRow.count,
    limit,
    offset,
  };
}

interface MessageOutput {
  id: string;
  chat_id: string;
  sender: { id: string; display_name: string };
  timestamp: number;
  content: {
    type: string;
    text: string | null;
    /** Present only on stickers. */
    sticker_id?: string;
    /** Present only on stickers, and only where the platform has sticker packs. */
    package_id?: string;
  };
  /** Non-null once the message has been edited in place. */
  edited_at: number | null;
  /** Non-null once retracted; content is cleared, so this is how a reader tells a
   *  withdrawn message from an empty one. */
  retracted_at: number | null;
}

export type HistoryState = "complete" | "partial" | "backfilling" | "unavailable" | "unknown";

interface ReadMessagesResult {
  messages: MessageOutput[];
  has_more: boolean;
  oldest_timestamp: number | null;
  newest_timestamp: number | null;
  history: { state: HistoryState; reason?: string };
}

const HISTORY_STATE_BY_BACKFILL_STATE: Record<string, HistoryState> = {
  exhausted: "complete",
  partial: "partial",
  unavailable: "unavailable",
  unknown: "unknown",
};

function readHistory(db: Database, chatId: string, internalId: number | null): ReadMessagesResult["history"] {
  if (isInFlight(chatId)) return { state: "backfilling" };
  if (internalId == null) return { state: "unknown" };

  const row = db
    .query<{ backfill_state: string | null }, [number]>(
      "SELECT backfill_state FROM chats WHERE id = ?"
    )
    .get(internalId);

  const state = HISTORY_STATE_BY_BACKFILL_STATE[row?.backfill_state ?? "unknown"] ?? "unknown";
  return state === "unavailable"
    ? { state, reason: "platform_no_history" }
    : { state };
}

function formatMessage(row: MessageRow, db: Database): MessageOutput {
  const chatRow = db.query<{ platform: string; platform_id: string }, [number]>(
    "SELECT platform, platform_id FROM chats WHERE id = ?"
  ).get(row.chat_id)!;

  let sender = { id: "", display_name: "Unknown" };
  if (row.sender_id != null) {
    const contact = db.query<{ platform: string; platform_id: string; display_name: string }, [number]>(
      "SELECT platform, platform_id, display_name FROM contacts WHERE id = ?"
    ).get(row.sender_id);
    if (contact) {
      sender = {
        id: `${contact.platform}:${contact.platform_id}`,
        display_name: contact.display_name,
      };
    }
  }

  return {
    id: `${row.platform}:${row.platform_message_id}`,
    chat_id: `${chatRow.platform}:${chatRow.platform_id}`,
    sender,
    timestamp: row.timestamp,
    content: {
      type: row.content_type,
      text: row.content_text,
      // Spread conditionally: a text message must not carry a `sticker_id: null` key. The
      // consumer renders `[sticker:${package_id ?? "?"}/${sticker_id ?? "?"}]`, so a
      // present-but-empty key reads the same as a missing sticker ID.
      ...(row.content_sticker_id ? { sticker_id: row.content_sticker_id } : {}),
      ...(row.content_sticker_package_id
        ? { package_id: row.content_sticker_package_id }
        : {}),
      // Same conditional spread, same reason: the query has always selected this column
      // and then dropped it on the floor, so a consumer could not tell a sticker with a
      // public URL from one without. Only ever a URL needing no auth — see
      // docs/adapter-protocol.md §event.
      ...(row.content_media_url ? { media_url: row.content_media_url } : {}),
    },
    edited_at: row.edited_at ?? null,
    retracted_at: row.retracted_at ?? null,
  };
}

export function handleReadMessages(
  db: Database,
  params: { chat_id: string; limit?: number; before?: number; after?: number },
): ReadMessagesResult {
  const limit = params.limit ?? 20;
  const internalId = resolveChatInternalId(db, params.chat_id);
  if (internalId == null) {
    return {
      messages: [],
      has_more: false,
      oldest_timestamp: null,
      newest_timestamp: null,
      history: readHistory(db, params.chat_id, null),
    };
  }

  const rows = getMessages(db, internalId, {
    before: params.before,
    after: params.after,
    limit: limit + 1,
  });

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const messages = trimmed.map(r => formatMessage(r, db));

  let oldest: number | null = null;
  let newest: number | null = null;
  if (messages.length > 0) {
    const timestamps = messages.map(m => m.timestamp);
    oldest = Math.min(...timestamps);
    newest = Math.max(...timestamps);
  }

  return {
    messages,
    has_more: hasMore,
    oldest_timestamp: oldest,
    newest_timestamp: newest,
    history: readHistory(db, params.chat_id, internalId),
  };
}

/**
 * Cursors are OPAQUE. Consumers must echo the token back verbatim and never parse,
 * compare or do arithmetic on it. The prefix exists to make that contract visible at
 * a glance and to let the encoding change without breaking any consumer.
 *
 * Internally it wraps `messages.seq`. NEVER #4 forbids auto-increment IDs in external
 * APIs because they must not be used as message *identity* — a message is addressed
 * as `platform:platform_message_id`. A cursor is a *position* in the write log, not
 * an identity, and opacity keeps consumers from conflating the two.
 */
const CURSOR_PREFIX = "evt:";

export function encodeCursor(seq: number): string {
  return `${CURSOR_PREFIX}${seq}`;
}

/** Returns null when the token was not issued by this core. */
export function decodeCursor(cursor: string): number | null {
  if (!cursor.startsWith(CURSOR_PREFIX)) return null;
  const raw = cursor.slice(CURSOR_PREFIX.length);
  if (raw.length === 0) return null;
  const seq = Number(raw);
  if (!Number.isInteger(seq) || seq < 0) return null;
  return seq;
}

interface EventOutput {
  cursor: string;
  type: string;
  message: MessageOutput;
}

interface ReadEventsResult {
  events: EventOutput[];
  next_cursor: string;
  head_cursor: string;
  has_more: boolean;
}

interface ReadEventsError {
  error: string;
  detail: string;
}

/**
 * The push-consumer primitive: "what happened after this position?"
 *
 * Omitting `since` returns the current head with no events — that is how a fresh
 * consumer starts tailing without replaying the entire history.
 *
 * `head_cursor` lets a consumer detect that its stored cursor is ahead of the log
 * (SQLite rebuilt or truncated) and reset instead of stalling forever.
 *
 * A message that is edited or retracted re-enters the sequence at the tail, so a
 * consumer parked anywhere behind still receives the change. It arrives as the row's
 * current state, not as a diff: replaying from cursor 0 yields one `edit` event for a
 * message whose original text the consumer never saw. Consumers applying end state are
 * served correctly; anything reconstructing edit history should read the JSONL log.
 */
function eventTypeOf(row: MessageRow): string {
  // Not mutually exclusive — a message can be edited and then retracted.
  if (row.retracted_at != null) return "unsend";
  if (row.edited_at != null) return "edit";
  return "message";
}

export function handleReadEvents(
  db: Database,
  params: { since?: string; limit?: number },
): ReadEventsResult | ReadEventsError {
  const limit = params.limit ?? 100;
  const head = getHeadSeq(db);

  if (params.since == null) {
    return {
      events: [],
      next_cursor: encodeCursor(head),
      head_cursor: encodeCursor(head),
      has_more: false,
    };
  }

  const since = decodeCursor(params.since);
  if (since == null) {
    return {
      error: "invalid_cursor",
      detail: `not a cursor issued by this core: ${params.since}`,
    };
  }

  const rows = getEventsSince(db, since, limit + 1);
  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;

  return {
    events: trimmed.map(r => ({
      cursor: encodeCursor(r.seq),
      type: eventTypeOf(r),
      message: formatMessage(r, db),
    })),
    // Hold position when nothing new, so an idle consumer keeps a valid cursor.
    next_cursor: encodeCursor(trimmed.length > 0 ? trimmed[trimmed.length - 1]!.seq : since),
    head_cursor: encodeCursor(head),
    has_more: hasMore,
  };
}

interface SearchResultOutput {
  message: MessageOutput;
  snippet: string | null;
  chat_name: string | null;
}

interface SearchMessagesResult {
  results: SearchResultOutput[];
  total: number;
  limit: number;
  offset: number;
}

export function handleSearchMessages(
  db: Database,
  params: { query: string; chat_id?: string; platform?: string; limit?: number; offset?: number },
): SearchMessagesResult {
  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;

  let rows = searchMessages(db, params.query, { limit: 1000 });

  if (params.chat_id) {
    const internalId = resolveChatInternalId(db, params.chat_id);
    if (internalId == null) {
      return { results: [], total: 0, limit, offset };
    }
    rows = rows.filter(r => r.chat_id === internalId);
  }

  if (params.platform) {
    rows = rows.filter(r => r.platform === params.platform);
  }

  const total = rows.length;
  const paged = rows.slice(offset, offset + limit);

  const results: SearchResultOutput[] = paged.map(r => {
    const chatRow = db.query<{ platform: string; platform_id: string; name: string | null }, [number]>(
      "SELECT platform, platform_id, name FROM chats WHERE id = ?"
    ).get(r.chat_id)!;

    return {
      message: formatMessage(r as unknown as MessageRow, db),
      snippet: r.snippet,
      chat_name: chatRow.name,
    };
  });

  return { results, total, limit, offset };
}

// sender 身分在 daemon 的 selfByPlatform、chat.type 在 DB —— 兩者 tools.ts 都拿不到，
// 所以 draft 是 JsonlEvent 的窄化版本，由 daemon 端補完再交給 landEvent。
export type OutgoingDraft = Omit<JsonlEvent, "chat" | "sender" | "received_at"> & {
  chat: { platform_id: string };
};

export interface SendDeps {
  safetyRail: SafetyRail;
  sendToAdapter: (method: string, params: unknown) => Promise<unknown>;
  isAdapterConnected: () => boolean;
  recordOutgoing?: (draft: OutgoingDraft) => void;
}

interface SendResult {
  success: boolean;
  message_id?: string;
  timestamp?: number;
  error?: string;
  detail?: string;
}

export async function handleSendMessage(
  deps: SendDeps,
  params: { chat_id: string; text: string },
): Promise<SendResult> {
  if (!deps.isAdapterConnected() || deps.safetyRail.killSwitch.isKilled) {
    const [platform] = params.chat_id.split(":");
    return {
      success: false,
      error: "adapter_unavailable",
      detail: `${platform ?? "Unknown"} adapter is not connected`,
    };
  }

  await deps.safetyRail.rateLimiter.acquire();

  try {
    const [, ...platformIdParts] = params.chat_id.split(":");
    const rawPlatformId = platformIdParts.join(":");

    const result = await deps.sendToAdapter("send_message", {
      chat_id: rawPlatformId,
      content: { type: "text", text: params.text },
    }) as { message_id?: string; timestamp?: number };

    deps.safetyRail.recordSuccess();

    // 落地失敗不可讓 send 回報失敗——訊息已經送到平台了，回 success:false 會讓 consumer 重送。
    if (deps.recordOutgoing) {
      if (!result.message_id) {
        // 不可捏造 sentinel id：platform_message_id 是 SQLite UNIQUE 與去重鍵。
        console.error("[tools] send succeeded but adapter returned no message_id; not landing");
      } else {
        try {
          const [platform] = params.chat_id.split(":");
          deps.recordOutgoing({
            type: "message",
            platform: platform ?? "",
            platform_message_id: result.message_id,
            chat: { platform_id: rawPlatformId },
            timestamp: result.timestamp ?? Date.now(),
            content: { type: "text", text: params.text },
            raw: { outgoing: true },
            source: "live",
          });
        } catch (err) {
          console.error("[tools] recordOutgoing failed:", err);
        }
      }
    }

    return {
      success: true,
      message_id: result.message_id,
      timestamp: result.timestamp,
    };
  } catch (err) {
    await deps.safetyRail.recordError(err);
    return {
      success: false,
      error: "send_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

interface StatusAdapterInfo {
  state: string;
  uptime_seconds?: number;
  rate_limit?: { remaining: number; resets_in_seconds: number };
}

interface StatusInput {
  adapters: Record<string, StatusAdapterInfo>;
  dbSizeMb?: number;
  jsonlSizeMb?: number;
}

interface StatusOutput {
  adapters: Record<string, StatusAdapterInfo>;
  storage: {
    message_count: number;
    chat_count: number;
    contact_count: number;
    oldest_message: number | null;
    newest_message: number | null;
    db_size_mb: number;
    jsonl_size_mb: number;
    /** Opaque head cursor — where a consumer would start tailing from now. */
    cursor: string;
  };
}

export function handleGetStatus(db: Database, input: StatusInput): StatusOutput {
  const stats = getStatus(db);

  return {
    adapters: input.adapters,
    storage: {
      message_count: stats.message_count,
      chat_count: stats.chat_count,
      contact_count: stats.contact_count,
      oldest_message: stats.oldest_message_at,
      newest_message: stats.newest_message_at,
      db_size_mb: input.dbSizeMb ?? 0,
      jsonl_size_mb: input.jsonlSizeMb ?? 0,
      cursor: encodeCursor(getHeadSeq(db)),
    },
  };
}

/**
 * F23 探針：dev-only、唯讀。
 *
 * on-demand backfill 的 anchor 是該室**最舊**訊息（buildHistoryBackfillParams →
 * getOldestMessageAnchor），所以它往更舊分頁，抓不到 F23 缺的那則「比最後落地
 * 訊息更新」的訊息。此探針刻意**不帶 before_message_id**，讓 adapter fallback 到
 * box.lastDeliveredMessageId → 回該室最新 N 則。
 *
 * 唯讀：events 原樣回傳，不 ingest（Phase 1 全程不寫 DB）。
 */
export interface ProbeDeps {
  db: Database;
  sendRequest: (platform: string, method: string, params: unknown) => Promise<unknown>;
}

export async function handleProbeLatest(
  deps: ProbeDeps,
  params: { chat_id: string; count: number },
): Promise<{ events: unknown[] }> {
  const [platform, ...rest] = params.chat_id.split(":");
  const platformId = rest.join(":");

  const result = await deps.sendRequest(platform, "backfill", {
    chat_id: platformId,
    before_timestamp: Date.now(),
    count: params.count,
    // before_message_id 刻意缺席 → adapter 走 box.lastDeliveredMessageId fallback
  }) as { events: unknown[] };

  return { events: result.events };
}

/** The slice of MediaCache this tool needs — kept narrow so tests can pass a stub. */
export interface MediaResolver {
  fetchMedia: (key: {
    platform: string;
    messageId: string;
    chatId: string;
    raw: unknown;
    contentType: "image" | "sticker" | "video" | "audio" | "file";
    stickerId?: string;
    publicUrl?: string;
  }) => Promise<unknown>;
}

/**
 * Turns a stored message into a local file path a consumer can open.
 *
 * The consumer never sees a URL, a header or a key: which of the three fetch paths applies
 * is decided here and inside the adapter (docs/adapter-protocol.md §get_media).
 */
const MEDIA_CONTENT_TYPES = new Set(["image", "sticker", "video", "audio", "file"]);

export async function handleGetMedia(
  db: Database,
  cache: MediaResolver,
  params: { message_id: string; chat_id?: string },
): Promise<unknown> {
  const [platform, ...rest] = params.message_id.split(":");
  const platformMessageId = rest.join(":");

  // A message id is unique only within a chat (docs/storage-schema.md §message identity),
  // so this can legitimately return several rows on Telegram: one id, several dialogs.
  const rows = db
    .query<
      {
        raw: string | null;
        content_type: string;
        content_media_url: string | null;
        content_sticker_id: string | null;
        chat_platform_id: string;
      },
      [string, string]
    >(
      `SELECT m.raw AS raw, m.content_type, m.content_media_url, m.content_sticker_id,
              c.platform_id AS chat_platform_id
         FROM messages m JOIN chats c ON c.id = m.chat_id
        WHERE m.platform = ? AND m.platform_message_id = ?`,
    )
    .all(platform, platformMessageId);

  const row = pickRow(rows, platform, platformMessageId, params.chat_id);

  // A message core does not store is not an error the consumer can act on — it is simply
  // media that cannot be produced. Same shape as every other dead end.
  //
  // Refusing an ambiguous id lands here too, and that is the point: this returns before
  // the cache is touched, so an id we cannot place can never be remembered as permanently
  // unavailable. Being wrong once beats being wrong forever.
  if (!row) return { unavailable: "no_adapter" };

  let raw: unknown = null;
  if (row.raw) {
    try {
      raw = JSON.parse(row.raw);
    } catch {
      // An unparseable raw costs the adapter its context, not the whole request: the obs
      // path only needs the message id, so let it try.
    }
  }

  return await cache.fetchMedia({
    platform,
    messageId: platformMessageId,
    chatId: row.chat_platform_id,
    raw,
    contentType: row.content_type as "image" | "sticker" | "video" | "audio" | "file",
    ...(row.content_sticker_id ? { stickerId: row.content_sticker_id } : {}),
    ...(row.content_media_url ? { publicUrl: row.content_media_url } : {}),
  });
}

type MediaRow = {
  raw: string | null;
  content_type: string;
  content_media_url: string | null;
  content_sticker_id: string | null;
  chat_platform_id: string;
};

/**
 * Decides which of several same-id rows the caller meant, or refuses.
 *
 * A caller that names the chat always gets that chat or nothing. A caller that does not
 * gets an answer only while one is unmistakable: a single row, or a single row carrying
 * media among text siblings. Anything less certain is refused, because the alternative —
 * guessing — is what taught the cache to record another chat's message as gone forever.
 */
function pickRow(
  rows: MediaRow[],
  platform: string,
  platformMessageId: string,
  chatId?: string,
): MediaRow | undefined {
  if (chatId) {
    // Same shape read_messages accepts, so a consumer can pass its own chat id straight through.
    const [, ...chatParts] = chatId.split(":");
    const chatPlatformId = chatParts.join(":");
    return rows.find((r) => r.chat_platform_id === chatPlatformId);
  }

  if (rows.length <= 1) return rows[0];

  const mediaRows = rows.filter((r) => MEDIA_CONTENT_TYPES.has(r.content_type));
  if (mediaRows.length === 1) {
    console.error(
      `[tools] get_media ${platform}:${platformMessageId} matched ${rows.length} chats with no chat_id; ` +
        `using the only media row (chat ${mediaRows[0]!.chat_platform_id}). Pass chat_id to be sure.`,
    );
    return mediaRows[0];
  }

  console.error(
    `[tools] get_media ${platform}:${platformMessageId} is ambiguous: ${rows.length} chats, ` +
      `${mediaRows.length} of them media. Refusing rather than guessing — pass chat_id.`,
  );
  return undefined;
}
