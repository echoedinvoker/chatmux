import { Database } from "bun:sqlite";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { handleListChats, handleReadMessages, handleGetStatus } from "./tools.js";

interface ResourceContext {
  adapters: Record<string, unknown>;
  dbSizeMb?: number;
  jsonlSizeMb?: number;
  /**
   * Called when a chat's messages are read. Subscribers re-read the resource rather than
   * the tool, so without this hook the on-demand trigger would miss that path entirely.
   */
  onChatRead?: (chatId: string) => void;
}

export function handleResource(
  db: Database,
  uri: string,
  ctx: ResourceContext,
): string | null {
  if (uri === "chat://chats") {
    const result = handleListChats(db, { limit: 1000 });
    return JSON.stringify(result);
  }

  if (uri === "chat://status") {
    const result = handleGetStatus(db, {
      adapters: ctx.adapters as any,
      dbSizeMb: ctx.dbSizeMb,
      jsonlSizeMb: ctx.jsonlSizeMb,
    });
    return JSON.stringify(result);
  }

  const messagesMatch = uri.match(/^chat:\/\/chats\/(.+?)\/messages(?:\?(.*))?$/);
  if (messagesMatch) {
    const chatId = messagesMatch[1];
    const searchParams = new URLSearchParams(messagesMatch[2] ?? "");
    const limit = searchParams.has("limit") ? Number(searchParams.get("limit")) : 20;
    const result = handleReadMessages(db, { chat_id: chatId, limit });
    ctx.onChatRead?.(chatId);
    return JSON.stringify(result);
  }

  const infoMatch = uri.match(/^chat:\/\/chats\/(.+?)\/info$/);
  if (infoMatch) {
    const chatId = infoMatch[1];
    const [platform, ...rest] = chatId.split(":");
    const platformId = rest.join(":");

    const chat = db.query<{
      id: number; platform: string; platform_id: string; type: string; name: string | null;
      last_activity_at: number | null;
    }, [string, string]>(
      "SELECT id, platform, platform_id, type, name, last_activity_at FROM chats WHERE platform = ? AND platform_id = ?"
    ).get(platform, platformId);

    if (!chat) return JSON.stringify({ error: "chat not found" });

    const stats = db.query<{
      count: number; first_at: number | null; last_at: number | null;
    }, [number]>(
      `SELECT COUNT(*) as count, MIN(timestamp) as first_at, MAX(timestamp) as last_at
       FROM messages WHERE chat_id = ?`
    ).get(chat.id)!;

    const members = db.query<{ platform: string; platform_id: string; display_name: string }, [number]>(
      `SELECT DISTINCT c.platform, c.platform_id, c.display_name
       FROM contacts c
       JOIN messages m ON m.sender_id = c.id
       WHERE m.chat_id = ?`
    ).all(chat.id);

    return JSON.stringify({
      id: `${chat.platform}:${chat.platform_id}`,
      type: chat.type,
      name: chat.name,
      platform: chat.platform,
      members: members.map(m => ({
        id: `${m.platform}:${m.platform_id}`,
        display_name: m.display_name,
      })),
      message_count: stats.count,
      first_message_at: stats.first_at,
      last_message_at: stats.last_at,
      last_activity_at: chat.last_activity_at,
    });
  }

  return null;
}

export class ResourceSubscriptionManager {
  private listeners: ((uri: string) => void)[] = [];

  /** Exposed so tests can assert listeners do not leak when sessions close. */
  get listenerCount(): number {
    return this.listeners.length;
  }

  /** Returns a canceller; sessions must call it on close or their listener outlives them. */
  onUpdate(fn: (uri: string) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  notifyMessageReceived(chatId: string): void {
    const uris = [
      "chat://chats",
      `chat://chats/${chatId}/messages`,
    ];
    for (const uri of uris) {
      for (const fn of this.listeners) fn(uri);
    }
  }

  notifyContactUpdated(chatId: string): void {
    for (const fn of this.listeners) fn(`chat://chats/${chatId}/info`);
  }

  notifyStatusChanged(): void {
    for (const fn of this.listeners) fn("chat://status");
  }
}

/**
 * Wires MCP resource subscription onto one session's server.
 *
 * Lives here rather than in daemon.ts so tests exercise the shipped code: daemon.ts has
 * module-level side effects (DB, AdapterManager) and cannot be imported by a test, so a
 * copy of this logic there would only ever be verified by a copy of it in a fixture.
 *
 * URIs are matched by exact equality — subscribing to a template does *not* cover its
 * instances. MCP does not define that semantic and inventing it would give third-party
 * clients undocumented behaviour.
 *
 * Returns a canceller the caller must invoke when the session closes.
 */
export function registerSubscriptionHandlers(
  server: McpServer,
  subs: ResourceSubscriptionManager,
): () => void {
  const subscribed = new Set<string>(); // per-session: one call per session

  // Must happen before server.connect(transport) — the SDK throws otherwise.
  server.server.registerCapabilities({ resources: { subscribe: true } });

  server.server.setRequestHandler(SubscribeRequestSchema, async ({ params }) => {
    subscribed.add(params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async ({ params }) => {
    subscribed.delete(params.uri);
    return {};
  });

  return subs.onUpdate((uri) => {
    if (!subscribed.has(uri)) return;
    server.server
      .notification({ method: "notifications/resources/updated", params: { uri } })
      .catch((err) => console.error("[MCP] notify failed:", err));
  });
}
