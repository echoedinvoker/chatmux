import { Database } from "bun:sqlite";
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

  onUpdate(fn: (uri: string) => void): void {
    this.listeners.push(fn);
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
