import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, syncEventToSQLite } from "../../src/core/storage/sqlite";

function columns(db: Database): Set<string> {
  return new Set(
    db.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((c) => c.name)
  );
}

test("migration 加上兩個 sticker 欄位且冪等", () => {
  const db = new Database(":memory:");
  initSchema(db);
  expect(columns(db).has("content_sticker_id")).toBe(true);
  expect(columns(db).has("content_sticker_package_id")).toBe(true);
  expect(() => initSchema(db)).not.toThrow(); // 重跑不炸
});

test("貼圖事件的兩個 id 會落地", () => {
  const db = new Database(":memory:");
  initSchema(db);
  syncEventToSQLite(db, {
    type: "message",
    platform: "line",
    platform_message_id: "9",
    chat: { platform_id: "cAAA", type: "group", name: "G" },
    sender: { platform_id: "uX", display_name: "X" },
    timestamp: 1,
    content: { type: "sticker", sticker_id: "14406089", package_id: "1365252" },
    raw: {},
    source: "live",
  } as any);

  const row = db.query<any, []>(
    "SELECT content_sticker_id, content_sticker_package_id FROM messages WHERE platform_message_id='9'"
  ).get();
  expect(row.content_sticker_id).toBe("14406089");
  expect(row.content_sticker_package_id).toBe("1365252");
});

// 舊 DB（沒有 sticker 欄位、且還沒做過 per-chat unique key rebuild）走 migration 路徑時，
// 既有列不得受影響——這是 migrateStickerColumns 必須排在 migrateMessageUniqueKey 之後的原因：
// rebuild 的 INSERT ... SELECT 明文列舉欄位，先加欄再 rebuild 會讓兩欄資料靜默歸零。
test("舊 DB 升級後既有列不受影響", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, platform_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('direct','group','room')), name TEXT,
      last_message_at INTEGER, raw TEXT,
      created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(platform, platform_id)
    )
  `);
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, platform_message_id TEXT NOT NULL,
      chat_id INTEGER NOT NULL REFERENCES chats(id), sender_id INTEGER, timestamp INTEGER NOT NULL,
      content_type TEXT NOT NULL, content_text TEXT, content_media_url TEXT, raw TEXT,
      source TEXT NOT NULL CHECK(source IN ('live','backfill')),
      created_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(platform, platform_message_id)
    )
  `);
  db.exec("INSERT INTO chats (platform, platform_id, type) VALUES ('line','cAAA','group')");
  db.exec(
    "INSERT INTO messages (platform, platform_message_id, chat_id, timestamp, content_type, content_text, source) " +
      "VALUES ('line','old-1',1,1,'text','舊訊息','backfill')"
  );

  initSchema(db);

  expect(columns(db).has("content_sticker_id")).toBe(true);
  const row = db.query<any, []>(
    "SELECT content_text, content_sticker_id FROM messages WHERE platform_message_id='old-1'"
  ).get();
  expect(row.content_text).toBe("舊訊息");
  expect(row.content_sticker_id).toBeNull();
});
