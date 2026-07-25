import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../../src/core/storage/sqlite";
import { getOldestMessageAnchor, buildBackfillParams } from "../../src/core/storage/query";

function insertChat(db: Database, platform: string, platformId: string): number {
  db.prepare(
    "INSERT INTO chats (platform, platform_id, type, name) VALUES (?, ?, 'direct', ?)"
  ).run(platform, platformId, platformId);
  return db.query<{ id: number }, [string, string]>(
    "SELECT id FROM chats WHERE platform = ? AND platform_id = ?"
  ).get(platform, platformId)!.id;
}

function insertMessage(
  db: Database,
  platform: string,
  chatId: number,
  platformMessageId: string,
  timestamp: number
): void {
  db.prepare(`
    INSERT INTO messages
      (platform, platform_message_id, chat_id, timestamp, content_type, content_text, source, seq)
    VALUES (?, ?, ?, ?, 'text', ?, 'backfill', (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages))
  `).run(platform, platformMessageId, chatId, timestamp, platformMessageId);
}

describe("cold start backfill anchor", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
  });

  test("getOldestMessageAnchor returns the oldest message of that chat", () => {
    const chatId = insertChat(db, "line", "c_anchor");
    insertMessage(db, "line", chatId, "623300721831838042", 1784000000000);
    insertMessage(db, "line", chatId, "623300721831838099", 1784900000000);

    const anchor = getOldestMessageAnchor(db, "line", "c_anchor");

    expect(anchor).toEqual({
      platform_message_id: "623300721831838042",
      timestamp: 1784000000000,
    });
  });

  test("getOldestMessageAnchor does not leak messages from another chat", () => {
    const target = insertChat(db, "line", "c_target");
    const other = insertChat(db, "line", "c_other");
    insertMessage(db, "line", other, "m_older_other", 1000);
    insertMessage(db, "line", target, "m_target", 2000);

    expect(getOldestMessageAnchor(db, "line", "c_target")).toEqual({
      platform_message_id: "m_target",
      timestamp: 2000,
    });
  });

  test("getOldestMessageAnchor returns null when the chat has no messages", () => {
    insertChat(db, "line", "c_empty");

    expect(getOldestMessageAnchor(db, "line", "c_empty")).toBeNull();
  });

  test("buildBackfillParams carries before_message_id and the anchor timestamp", () => {
    const chatId = insertChat(db, "line", "c_anchor");
    insertMessage(db, "line", chatId, "623300721831838042", 1784000000000);
    insertMessage(db, "line", chatId, "623300721831838099", 1784900000000);

    const params = buildBackfillParams(db, "line", "c_anchor", 50);

    expect(params.chat_id).toBe("c_anchor");
    expect(params.count).toBe(50);
    expect(params.before_message_id).toBe("623300721831838042");
    expect(params.before_timestamp).toBe(1784000000000);
  });

  test("buildBackfillParams omits before_message_id entirely when the chat is empty", () => {
    insertChat(db, "line", "c_empty");
    const before = Date.now();

    const params = buildBackfillParams(db, "line", "c_empty", 50);

    expect("before_message_id" in params).toBe(false);
    expect(params.before_message_id).toBeUndefined();
    expect(params.before_timestamp).toBeGreaterThanOrEqual(before);
  });
});
