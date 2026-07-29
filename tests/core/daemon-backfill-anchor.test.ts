import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../../src/core/storage/sqlite";
import {
  getOldestMessageAnchor,
  getNewestMessageAnchor,
  buildHistoryBackfillParams,
  buildCatchupBackfillParams,
} from "../../src/core/storage/query";

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

  test("getNewestMessageAnchor returns the newest message of that chat", () => {
    const chatId = insertChat(db, "line", "c_anchor");
    insertMessage(db, "line", chatId, "m_mid", 1784500000000);
    insertMessage(db, "line", chatId, "m_old", 1784000000000);
    insertMessage(db, "line", chatId, "m_new", 1784900000000);

    expect(getNewestMessageAnchor(db, "line", "c_anchor")).toEqual({
      platform_message_id: "m_new",
      timestamp: 1784900000000,
    });
  });

  test("getNewestMessageAnchor does not leak messages from another chat", () => {
    const target = insertChat(db, "line", "c_target");
    const other = insertChat(db, "line", "c_other");
    insertMessage(db, "line", target, "m_target", 2000);
    insertMessage(db, "line", other, "m_newer_other", 3000);

    expect(getNewestMessageAnchor(db, "line", "c_target")).toEqual({
      platform_message_id: "m_target",
      timestamp: 2000,
    });
  });

  test("getNewestMessageAnchor returns null when the chat has no messages", () => {
    insertChat(db, "line", "c_empty");

    expect(getNewestMessageAnchor(db, "line", "c_empty")).toBeNull();
  });

  // on-demand (F4 歷史翻頁)：從 DB 最舊那則往回翻
  test("history params carry before_message_id pinned to the oldest known message", () => {
    const chatId = insertChat(db, "line", "c_anchor");
    insertMessage(db, "line", chatId, "623300721831838042", 1784000000000);
    insertMessage(db, "line", chatId, "623300721831838099", 1784900000000);

    const params = buildHistoryBackfillParams(db, "line", "c_anchor", 50);

    expect(params.chat_id).toBe("c_anchor");
    expect(params.count).toBe(50);
    expect(params.before_message_id).toBe("623300721831838042");
    expect(params.before_timestamp).toBe(1784000000000);
  });

  test("history params omit before_message_id entirely when the chat is empty", () => {
    insertChat(db, "line", "c_empty");
    const before = Date.now();

    const params = buildHistoryBackfillParams(db, "line", "c_empty", 50);

    expect("before_message_id" in params).toBe(false);
    expect(params.before_message_id).toBeUndefined();
    expect(params.before_timestamp).toBeGreaterThanOrEqual(before);
  });

  // cold start catch-up (F26)：batch 1 不帶 anchor，讓 adapter 走 messageBoxes fallback 取最新
  test("catch-up params omit before_message_id even when the chat already has messages", () => {
    const chatId = insertChat(db, "line", "c_anchor");
    insertMessage(db, "line", chatId, "623300721831838042", 1784000000000);
    insertMessage(db, "line", chatId, "623300721831838099", 1784900000000);
    const before = Date.now();

    const params = buildCatchupBackfillParams("c_anchor", 50);

    expect(params.chat_id).toBe("c_anchor");
    expect(params.count).toBe(50);
    expect("before_message_id" in params).toBe(false);
    expect(params.before_message_id).toBeUndefined();
    expect(params.before_timestamp).toBeGreaterThanOrEqual(before);
  });
});
