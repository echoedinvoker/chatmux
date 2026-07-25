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

export function searchMessages(
  db: Database,
  query: string,
  opts?: { limit?: number }
): SearchResult[] {
  const limit = opts?.limit ?? 50;

  if (query.length < 3) {
    return db
      .query<SearchResult, [string, number]>(
        `SELECT id, platform, platform_message_id, chat_id, sender_id,
                timestamp, content_type, content_text, content_text AS snippet,
                edited_at, retracted_at
         FROM messages
         WHERE content_text LIKE '%' || ? || '%'
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(query, limit);
  }

  return db
    .query<SearchResult, [string, number]>(
      `SELECT m.id, m.platform, m.platform_message_id, m.chat_id, m.sender_id,
              m.timestamp, m.content_type, m.content_text,
              m.edited_at, m.retracted_at,
              snippet(messages_fts, 0, '<b>', '</b>', '...', 32) AS snippet
       FROM messages_fts fts
       JOIN messages m ON m.id = fts.rowid
       WHERE messages_fts MATCH ?
       ORDER BY m.timestamp DESC
       LIMIT ?`
    )
    .all(query, limit);
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
                timestamp, content_type, content_text, content_media_url, source,
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
                timestamp, content_type, content_text, content_media_url, source,
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
              timestamp, content_type, content_text, content_media_url, source,
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
              timestamp, content_type, content_text, content_media_url, source,
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
    SELECT c.id, c.platform, c.platform_id, c.type, c.name, c.last_message_at,
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

  sql += " ORDER BY c.last_message_at DESC NULLS LAST LIMIT ? OFFSET ?";
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
