import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../../src/core/storage/sqlite";
import { rederiveStickers } from "../../src/core/storage/rederive";
import { extractSticker } from "../../src/adapters/line/content-text";

function seed(): Database {
  const db = new Database(":memory:");
  initSchema(db);
  db.exec("INSERT INTO chats (platform, platform_id, type) VALUES ('line', 'cAAA', 'group')");

  const insert = db.prepare(
    "INSERT INTO messages (platform, platform_message_id, chat_id, timestamp, content_type, raw, source) " +
      "VALUES ('line', ?, 1, 1, 'sticker', ?, 'backfill')"
  );
  insert.run(
    "ok",
    JSON.stringify({ contentMetadata: { STKID: "14406089", STKPKGID: "1365252" } })
  );
  insert.run("nullraw", null);
  insert.run("badjson", "not json");
  return db;
}

test("從 raw 回填貼圖 id，且冪等", () => {
  const db = seed();
  const first = rederiveStickers(db, extractSticker);
  expect(first.updated).toBe(1);

  const row = db.query<any, []>(
    "SELECT content_sticker_id, content_sticker_package_id FROM messages WHERE platform_message_id='ok'"
  ).get();
  expect(row.content_sticker_id).toBe("14406089");
  expect(row.content_sticker_package_id).toBe("1365252");

  const second = rederiveStickers(db, extractSticker);
  expect(second.updated).toBe(0); // 冪等：第二次沒東西可改
});

test("raw 缺失或壞掉的列被跳過，不拋錯也不寫入", () => {
  const db = seed();
  expect(() => rederiveStickers(db, extractSticker)).not.toThrow();

  const bad = db.query<any, []>(
    "SELECT content_sticker_id FROM messages WHERE platform_message_id='badjson'"
  ).get();
  expect(bad.content_sticker_id).toBeNull();

  const missing = db.query<any, []>(
    "SELECT content_sticker_id FROM messages WHERE platform_message_id='nullraw'"
  ).get();
  expect(missing.content_sticker_id).toBeNull();
});

// 回填是修正投影，不是狀態變更。bump seq 會讓每個 pull consumer 重收這幾百筆
// 假的變更事件（chat.nvim 會把它們當成「訊息有更新」重畫）。
test("回填不動 seq", () => {
  const db = seed();
  const before = db.query<any, []>("SELECT seq FROM messages WHERE platform_message_id='ok'").get().seq;
  rederiveStickers(db, extractSticker);
  const after = db.query<any, []>("SELECT seq FROM messages WHERE platform_message_id='ok'").get().seq;
  expect(after).toBe(before);
});

// Telegram 的 raw 沒有 STKID，extract 回 null ⇒ 該列被跳過而不是寫進空值。
test("extract 認不出來的列被跳過", () => {
  const db = seed();
  db.exec("INSERT INTO chats (platform, platform_id, type) VALUES ('telegram', 'tgAAA', 'group')");
  db.exec(
    "INSERT INTO messages (platform, platform_message_id, chat_id, timestamp, content_type, raw, source) " +
      `VALUES ('telegram', 'tg1', 2, 1, 'sticker', '${JSON.stringify({ sticker: { emoji: "🐱" } })}', 'backfill')`
  );

  const res = rederiveStickers(db, extractSticker);
  expect(res.updated).toBe(1);
  expect(res.skipped).toBe(3);

  const tg = db.query<any, []>(
    "SELECT content_sticker_id FROM messages WHERE platform_message_id='tg1'"
  ).get();
  expect(tg.content_sticker_id).toBeNull();
});
