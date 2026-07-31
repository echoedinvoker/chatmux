import { Database } from "bun:sqlite";

export interface SearchResult {
  id: number;
  platform: string;
  platform_message_id: string;
  chat_id: number;
  sender_id: number | null;
  timestamp: number;
  content_type: string;
  content_text: string | null;
  snippet: string | null;
  edited_at: number | null;
  retracted_at: number | null;
}

export interface MessageRow {
  id: number;
  platform: string;
  platform_message_id: string;
  chat_id: number;
  sender_id: number | null;
  timestamp: number;
  content_type: string;
  content_text: string | null;
  content_media_url: string | null;
  content_sticker_id: string | null;
  content_sticker_package_id: string | null;
  source: string;
  seq: number;
  edited_at: number | null;
  retracted_at: number | null;
}

export interface ChatRow {
  id: number;
  platform: string;
  platform_id: string;
  type: string;
  name: string | null;
  last_message_at: number | null;
  last_activity_at: number | null;
  last_message_text: string | null;
  message_count: number;
}

export interface StatusResult {
  message_count: number;
  chat_count: number;
  contact_count: number;
  oldest_message_at: number | null;
  newest_message_at: number | null;
}

export interface SearchFilter {
  chatId?: number;
  platform?: string;
}

/**
 * The WHERE fragment both search branches — and the count — share.
 *
 * Kept in one place on purpose: the filter has to appear in the LIKE query, the FTS query
 * and the count query, and three copies of the same predicate is three things that drift.
 * Everything is prefixed `m.` so the fragment drops into either branch unchanged.
 */
function searchFilterSql(opts?: SearchFilter): {
  extra: string;
  args: (string | number)[];
} {
  const conds: string[] = [];
  const args: (string | number)[] = [];
  if (opts?.chatId != null) {
    conds.push("m.chat_id = ?");
    args.push(opts.chatId);
  }
  if (opts?.platform) {
    conds.push("m.platform = ?");
    args.push(opts.platform);
  }
  return { extra: conds.length ? ` AND ${conds.join(" AND ")}` : "", args };
}

/**
 * Full-text search, filtered in SQL.
 *
 * `chatId` / `platform` are pushed into the WHERE clause rather than applied to the result.
 * Filtering afterwards means the LIMIT is spent on rows the caller did not ask for, and a
 * chat-scoped search silently loses every match older than the cut — exactly the case
 * "find that thing someone said" is made of.
 */
export function searchMessages(
  db: Database,
  query: string,
  opts?: { limit?: number; offset?: number } & SearchFilter
): SearchResult[] {
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;
  const { extra, args } = searchFilterSql(opts);

  if (query.length < 3) {
    return db
      .query<SearchResult, (string | number)[]>(
        `SELECT m.id, m.platform, m.platform_message_id, m.chat_id, m.sender_id,
                m.timestamp, m.content_type, m.content_text, m.content_text AS snippet,
                m.edited_at, m.retracted_at
         FROM messages m
         WHERE m.content_text LIKE '%' || ? || '%'${extra}
         ORDER BY m.timestamp DESC
         LIMIT ? OFFSET ?`
      )
      .all(query, ...args, limit, offset);
  }

  return db
    .query<SearchResult, (string | number)[]>(
      `SELECT m.id, m.platform, m.platform_message_id, m.chat_id, m.sender_id,
              m.timestamp, m.content_type, m.content_text,
              m.edited_at, m.retracted_at,
              snippet(messages_fts, 0, '<b>', '</b>', '...', 32) AS snippet
       FROM messages_fts fts
       JOIN messages m ON m.id = fts.rowid
       WHERE messages_fts MATCH ?${extra}
       ORDER BY m.timestamp DESC
       LIMIT ? OFFSET ?`
    )
    .all(query, ...args, limit, offset);
}

/**
 * How many messages the same query matches, ignoring pagination.
 *
 * Deriving the total from `searchMessages(...).length` would report the page size — or the
 * cap — as if it were the answer, so "3 / 3 hits" is shown for a query with 1200.
 * Shares `searchFilterSql` with the search itself; a second copy of the predicate would let
 * the count and the results disagree about what was searched.
 */
export function countSearchMessages(
  db: Database,
  query: string,
  opts?: SearchFilter
): number {
  const { extra, args } = searchFilterSql(opts);

  const sql =
    query.length < 3
      ? `SELECT COUNT(*) AS n
         FROM messages m
         WHERE m.content_text LIKE '%' || ? || '%'${extra}`
      : `SELECT COUNT(*) AS n
         FROM messages_fts fts
         JOIN messages m ON m.id = fts.rowid
         WHERE messages_fts MATCH ?${extra}`;

  return (
    db.query<{ n: number }, (string | number)[]>(sql).get(query, ...args)?.n ?? 0
  );
}

export function getMessages(
  db: Database,
  chatId: number,
  opts?: { before?: number; after?: number; limit?: number }
): MessageRow[] {
  const limit = opts?.limit ?? 50;

  if (opts?.before != null) {
    return db
      .query<MessageRow, [number, number, number]>(
        `SELECT id, platform, platform_message_id, chat_id, sender_id,
                timestamp, content_type, content_text, content_media_url,
              content_sticker_id, content_sticker_package_id, source,
                seq, edited_at, retracted_at
         FROM messages
         WHERE chat_id = ? AND timestamp < ?
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(chatId, opts.before, limit);
  }

  if (opts?.after != null) {
    return db
      .query<MessageRow, [number, number, number]>(
        `SELECT id, platform, platform_message_id, chat_id, sender_id,
                timestamp, content_type, content_text, content_media_url,
              content_sticker_id, content_sticker_package_id, source,
                seq, edited_at, retracted_at
         FROM messages
         WHERE chat_id = ? AND timestamp > ?
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(chatId, opts.after, limit);
  }

  return db
    .query<MessageRow, [number, number]>(
      `SELECT id, platform, platform_message_id, chat_id, sender_id,
              timestamp, content_type, content_text, content_media_url,
              content_sticker_id, content_sticker_package_id, source,
                seq, edited_at, retracted_at
       FROM messages
       WHERE chat_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(chatId, limit);
}

/**
 * Events in core-accept order, ascending, for cursor-based resumption.
 *
 * Ordered by `seq`, not by message timestamp: backfill can insert a message older than
 * everything already stored, and a consumer resuming from a cursor must still receive it.
 * That is the property `getMessages({ after })` cannot provide, because `after` is a
 * timestamp.
 *
 * `seq` rather than `id` because editing or retracting a stored message leaves its id
 * untouched — a consumer parked past that id would never learn the message changed. Every
 * change moves the row's seq to the tail instead.
 */
export function getEventsSince(
  db: Database,
  since: number,
  limit: number
): MessageRow[] {
  return db
    .query<MessageRow, [number, number]>(
      `SELECT id, platform, platform_message_id, chat_id, sender_id,
              timestamp, content_type, content_text, content_media_url,
              content_sticker_id, content_sticker_package_id, source,
                seq, edited_at, retracted_at
       FROM messages
       WHERE seq > ?
       ORDER BY seq ASC
       LIMIT ?`
    )
    .all(since, limit);
}

/** Highest sequence core has accepted. 0 when no events are stored yet. */
export function getHeadSeq(db: Database): number {
  return (
    db.query<{ seq: number | null }, []>("SELECT MAX(seq) as seq FROM messages").get()!
      .seq ?? 0
  );
}

export function listChats(
  db: Database,
  opts?: { platform?: string; search?: string; limit?: number; offset?: number }
): ChatRow[] {
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  let sql = `
    SELECT c.id, c.platform, c.platform_id, c.type, c.name, c.last_message_at, c.last_activity_at,
           (SELECT m.content_text FROM messages m WHERE m.chat_id = c.id ORDER BY m.timestamp DESC LIMIT 1) AS last_message_text,
           (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count
    FROM chats c
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (opts?.platform) {
    sql += " AND c.platform = ?";
    params.push(opts.platform);
  }
  if (opts?.search) {
    sql += " AND c.name LIKE '%' || ? || '%'";
    params.push(opts.search);
  }

  sql += " ORDER BY c.last_activity_at DESC NULLS LAST LIMIT ? OFFSET ?";
  params.push(limit, offset);

  return db.query<ChatRow, unknown[]>(sql).all(...params);
}

export function getStatus(db: Database): StatusResult {
  const msgStats = db
    .query<
      { count: number; oldest: number | null; newest: number | null },
      []
    >(
      "SELECT COUNT(*) as count, MIN(timestamp) as oldest, MAX(timestamp) as newest FROM messages"
    )
    .get()!;

  const chatCount = db
    .query<{ count: number }, []>("SELECT COUNT(*) as count FROM chats")
    .get()!.count;

  const contactCount = db
    .query<{ count: number }, []>("SELECT COUNT(*) as count FROM contacts")
    .get()!.count;

  return {
    message_count: msgStats.count,
    chat_count: chatCount,
    contact_count: contactCount,
    oldest_message_at: msgStats.oldest,
    newest_message_at: msgStats.newest,
  };
}

export interface MessageAnchor {
  platform_message_id: string;
  timestamp: number;
}

export interface BackfillParams {
  chat_id: string;
  before_timestamp: number;
  before_message_id?: string;
  count: number;
}

export function getOldestMessageAnchor(
  db: Database,
  platform: string,
  chatPlatformId: string
): MessageAnchor | null {
  return db
    .query<MessageAnchor, [string, string]>(
      `SELECT m.platform_message_id, m.timestamp
       FROM messages m
       JOIN chats c ON c.id = m.chat_id
       WHERE c.platform = ? AND c.platform_id = ?
       ORDER BY m.timestamp ASC, m.seq ASC
       LIMIT 1`
    )
    .get(platform, chatPlatformId) ?? null;
}

export function getNewestMessageAnchor(
  db: Database,
  platform: string,
  chatPlatformId: string
): MessageAnchor | null {
  return db
    .query<MessageAnchor, [string, string]>(
      `SELECT m.platform_message_id, m.timestamp
       FROM messages m
       JOIN chats c ON c.id = m.chat_id
       WHERE c.platform = ? AND c.platform_id = ?
       ORDER BY m.timestamp DESC, m.seq DESC
       LIMIT 1`
    )
    .get(platform, chatPlatformId) ?? null;
}

/**
 * 這則訊息是否已經在 DB 裡。
 *
 * ⚠️ 三個欄位逐一對齊 `UNIQUE(platform, chat_id, platform_message_id)`，一個都不能少。
 * 省略 chat 的話，Telegram 跨室重複的 message id（`migrateMessageUniqueKey` 註解記載的正是
 * 這個坑）會讓 B 室已有的 id 把 A 室的**新**訊息判成「已存在」——在 JSONL 這一層那是
 * 靜默資料遺失，truth source 從此沒有那一則。
 *
 * chat 還不存在（JOIN 不到）⇒ 回 false ⇒ 照常落地。
 */
export function hasMessage(
  db: Database,
  platform: string,
  chatPlatformId: string,
  platformMessageId: string
): boolean {
  const row = db
    .query<{ one: number }, [string, string, string]>(
      `SELECT 1 AS one
       FROM messages m
       JOIN chats c ON c.id = m.chat_id
       WHERE m.platform = ? AND c.platform_id = ? AND m.platform_message_id = ?
         AND c.platform = m.platform
       LIMIT 1`
    )
    .get(platform, chatPlatformId, platformMessageId);
  return row !== null;
}

/**
 * On-demand history paging (F4): anchor on the OLDEST known message and walk backwards.
 */
export function buildHistoryBackfillParams(
  db: Database,
  platform: string,
  chatPlatformId: string,
  count: number
): BackfillParams {
  const anchor = getOldestMessageAnchor(db, platform, chatPlatformId);
  if (!anchor) {
    return { chat_id: chatPlatformId, before_timestamp: Date.now(), count };
  }
  return {
    chat_id: chatPlatformId,
    before_timestamp: anchor.timestamp,
    before_message_id: anchor.platform_message_id,
    count,
  };
}

/**
 * Cold start catch-up (F26), batch 1: deliberately omit before_message_id so the adapter
 * falls back to the platform's latest message. before_timestamp is ignored by the adapter
 * in this branch (see docs/adapter-protocol.md) — it is present only to satisfy the schema.
 */
export function buildCatchupBackfillParams(
  chatPlatformId: string,
  count: number
): BackfillParams {
  return { chat_id: chatPlatformId, before_timestamp: Date.now(), count };
}

/**
 * Split a composite chat id ("line:c123") into its platform and platform_id and
 * resolve the internal row id. Lives here rather than in mcp/tools.ts so that both
 * the MCP layer and backfill-on-demand can use it without importing each other.
 */
export function resolveChatInternalId(db: Database, compositeId: string): number | null {
  const [platform, ...rest] = compositeId.split(":");
  const platformId = rest.join(":");
  const row = db.query<{ id: number }, [string, string]>(
    "SELECT id FROM chats WHERE platform = ? AND platform_id = ?"
  ).get(platform, platformId);
  return row?.id ?? null;
}
