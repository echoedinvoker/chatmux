import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../../src/core/storage/sqlite";
import { rederiveStickers, rederiveText } from "../../src/core/storage/rederive";
import { deriveProjection, extractSticker } from "../../src/adapters/line/content-text";

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

// ── Phase 4.2（F13）：回填 [RICH] 與 [CHATEVENT] ──────────────────────
// 映射邏輯只有一份（src/adapters/line/content-text.ts），adapter 與回填共用。
// 兩份會漂移：同一則訊息從 live 進來和從回填修好會長得不一樣。
function seedText(): Database {
  const db = new Database(":memory:");
  initSchema(db);
  db.exec("INSERT INTO chats (platform, platform_id, type) VALUES ('line', 'cAAA', 'group')");

  const insert = db.prepare(
    "INSERT INTO messages (platform, platform_message_id, chat_id, timestamp, content_type, content_text, raw, source) " +
      "VALUES ('line', ?, 1, 1, 'text', ?, ?, 'backfill')"
  );
  insert.run(
    "rich",
    "[RICH]",
    JSON.stringify({ contentType: "RICH", contentMetadata: { ALT_TEXT: "◤200 點紅包◢ 限時活動" } })
  );
  insert.run(
    "evt",
    "[CHATEVENT]",
    JSON.stringify({ contentType: "CHATEVENT", contentMetadata: { LOC_KEY: "C_ML", LOC_ARGS: "uX" } })
  );
  insert.run("plain", "你好", JSON.stringify({ contentType: "NONE", text: "你好" }));
  return db;
}

test("回填 RICH 與 CHATEVENT，且不碰正常訊息", () => {
  const db = seedText();
  const r = rederiveText(db, deriveProjection);
  expect(r.updated).toBe(2);

  const rows = db.query<any, []>("SELECT platform_message_id, content_text FROM messages").all();
  const byId = Object.fromEntries(rows.map((r: any) => [r.platform_message_id, r.content_text]));
  expect(byId["rich"]).toBe("◤200 點紅包◢ 限時活動");
  expect(byId["evt"]).toBe("[系統：成員離開]");
  expect(byId["plain"]).toBe("你好"); // 未被觸碰——WHERE 不掃它

  expect(rederiveText(db, deriveProjection).updated).toBe(0); // 冪等
});

test("文字回填同樣不動 seq", () => {
  const db = seedText();
  const before = db.query<any, []>("SELECT seq FROM messages WHERE platform_message_id='rich'").get().seq;
  rederiveText(db, deriveProjection);
  const after = db.query<any, []>("SELECT seq FROM messages WHERE platform_message_id='rich'").get().seq;
  expect(after).toBe(before);
});

// ── Phase 4.3（F13×F29 合流）：回填 [NONE] ─────────────────────────────
// UNSENT=true 的列必須落地成 applyUnsend 的同一個形狀（content_text=NULL +
// retracted_at）。寫成字面字串 "[訊息已收回]" 會讓這列對每個偵測器隱形：
// 掃不到、算不到、修不到，畫面上又長得像正確結果（R12）。
function seedNone(): Database {
  const db = new Database(":memory:");
  initSchema(db);
  db.exec("INSERT INTO chats (platform, platform_id, type) VALUES ('line', 'cAAA', 'group')");

  const insert = db.prepare(
    "INSERT INTO messages (platform, platform_message_id, chat_id, timestamp, content_type, content_text, raw, source) " +
      "VALUES ('line', ?, 1, 1690000000000, 'text', '[NONE]', ?, 'backfill')"
  );
  insert.run(
    "unsent",
    JSON.stringify({
      contentType: "NONE",
      contentMetadata: { UNSENT: "true", UPDATED_TIME: "1784621248047" },
    })
  );
  insert.run(
    "e2ee",
    JSON.stringify({ contentType: "NONE", contentMetadata: { e2eeMark: "2" } })
  );
  // Phase 1.3 的 3 筆沒有 e2eeMark，只有 e2eeVersion——而它在 contentMetadata **裡面**
  // （正式資料 id 196210-196212 實查）。Step 4.4 的歸零 SQL 抓到我原本猜成頂層。
  insert.run(
    "e2ee_noflag",
    JSON.stringify({
      contentType: "NONE",
      contentMetadata: { e2eeVersion: "2", seq: "623880789847179571" },
      hasContent: false,
    })
  );
  // 頂層那個位置一併認得（沒有證據說 LINE 不會這樣送）
  insert.run(
    "e2ee_toplevel",
    JSON.stringify({ contentType: "NONE", contentMetadata: {}, e2eeVersion: "2", hasContent: false })
  );
  return db;
}

test("NONE+UNSENT 回填成真正的收回狀態", () => {
  const db = seedNone();
  rederiveText(db, deriveProjection);
  const row = db.query<any, []>(
    "SELECT content_text, retracted_at FROM messages WHERE platform_message_id='unsent'"
  ).get();
  expect(row.retracted_at).toBe(1784621248047);
  expect(row.content_text).toBeNull(); // 與 applyUnsend 一致
});

test("NONE+e2ee 只換文字，不謊稱被收回", () => {
  const db = seedNone();
  rederiveText(db, deriveProjection);
  const row = db.query<any, []>(
    "SELECT content_text, retracted_at FROM messages WHERE platform_message_id='e2ee'"
  ).get();
  expect(row.content_text).toBe("[無法解密]");
  expect(row.retracted_at).toBeNull();
});

test("只有 contentMetadata.e2eeVersion 的 NONE 也被認出來", () => {
  const db = seedNone();
  rederiveText(db, deriveProjection);
  const row = db.query<any, []>(
    "SELECT content_text FROM messages WHERE platform_message_id='e2ee_noflag'"
  ).get();
  expect(row.content_text).toBe("[無法解密]");
});

// 回填不得產生「[訊息已收回] 但 retracted_at 為 NULL」這種列——那正是 4.4
// 第二條偵測器要抓的形狀，回填自己製造它等於自廢偵測器。
test("回填後沒有任何冒牌收回列", () => {
  const db = seedNone();
  rederiveText(db, deriveProjection);
  const fake = db.query<any, []>(
    "SELECT COUNT(*) AS n FROM messages WHERE content_text = '[訊息已收回]' AND retracted_at IS NULL"
  ).get();
  expect(fake.n).toBe(0);
});

test("收回回填冪等，且不動 seq", () => {
  const db = seedNone();
  const before = db.query<any, []>("SELECT seq FROM messages WHERE platform_message_id='unsent'").get().seq;
  rederiveText(db, deriveProjection);
  expect(rederiveText(db, deriveProjection).updated).toBe(0);
  const after = db.query<any, []>("SELECT seq FROM messages WHERE platform_message_id='unsent'").get().seq;
  expect(after).toBe(before);
});

test("e2eeVersion 在頂層時同樣被認出來", () => {
  const db = seedNone();
  rederiveText(db, deriveProjection);
  const row = db.query<any, []>(
    "SELECT content_text FROM messages WHERE platform_message_id='e2ee_toplevel'"
  ).get();
  expect(row.content_text).toBe("[無法解密]");
});
