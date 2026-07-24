import { Database } from "bun:sqlite";
import { listChats, getMessages, searchMessages, getStatus, type ChatRow, type MessageRow, type SearchResult } from "../storage/query.js";
import type { SafetyRail } from "../safety.js";

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
  content: { type: string; text: string | null };
}

interface ReadMessagesResult {
  messages: MessageOutput[];
  has_more: boolean;
  oldest_timestamp: number | null;
  newest_timestamp: number | null;
}

function resolveChatInternalId(db: Database, compositeId: string): number | null {
  const [platform, ...rest] = compositeId.split(":");
  const platformId = rest.join(":");
  const row = db.query<{ id: number }, [string, string]>(
    "SELECT id FROM chats WHERE platform = ? AND platform_id = ?"
  ).get(platform, platformId);
  return row?.id ?? null;
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
    },
  };
}

export function handleReadMessages(
  db: Database,
  params: { chat_id: string; limit?: number; before?: number; after?: number },
): ReadMessagesResult {
  const limit = params.limit ?? 20;
  const internalId = resolveChatInternalId(db, params.chat_id);
  if (internalId == null) {
    return { messages: [], has_more: false, oldest_timestamp: null, newest_timestamp: null };
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

  return { messages, has_more: hasMore, oldest_timestamp: oldest, newest_timestamp: newest };
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

export interface SendDeps {
  safetyRail: SafetyRail;
  sendToAdapter: (method: string, params: unknown) => Promise<unknown>;
  isAdapterConnected: () => boolean;
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
    const result = await deps.sendToAdapter("send_message", {
      chat_id: params.chat_id,
      content: { type: "text", text: params.text },
    }) as { message_id?: string; timestamp?: number };

    deps.safetyRail.recordSuccess();

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
    },
  };
}
