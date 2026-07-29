import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSchema, syncEventToSQLite } from "../../src/core/storage/sqlite";
import { makeLandBackfillEvent } from "../../src/core/storage/land-backfill";
import { JsonlWriter, type JsonlEvent } from "../../src/core/storage/jsonl";

const T0 = 1_784_000_000_000;

function makeEvent(overrides: Partial<JsonlEvent> = {}): JsonlEvent {
  return {
    type: "message",
    platform: "line",
    platform_message_id: "m1",
    chat: { platform_id: "c1", type: "direct" },
    sender: { platform_id: "u1", display_name: "peer" },
    timestamp: T0,
    content: { type: "text", text: "hi" },
    raw: {},
    source: "backfill",
    ...overrides,
  };
}

/**
 * 真實 `:memory:` DB 而非 fake 存在性 predicate。
 *
 * 這一層的最大風險是「存在性檢查的鍵沒對齊 UNIQUE(platform, chat_id, platform_message_id)」，
 * 把判斷注入成 fake 就等於把該風險測掉了——必須跑到真實 schema 才驗得出跨室同 id 不會互擋。
 */
function makeHarness() {
  const db = new Database(":memory:");
  initSchema(db);
  const appended: JsonlEvent[] = [];
  const land = makeLandBackfillEvent({
    jsonl: { append: (e) => { appended.push(e); } },
    syncToSQLite: (e) => syncEventToSQLite(db, e),
    db,
  });
  return { db, appended, land };
}

function messageCount(db: Database): number {
  return db.query<{ n: number }, []>("SELECT count(*) AS n FROM messages").get()!.n;
}

describe("landBackfillEvent", () => {
  let h: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    h = makeHarness();
  });

  test("the same backfill message landed twice writes one JSONL line and one row", () => {
    const event = makeEvent();

    expect(h.land(event)).toBe(true);
    expect(h.land(event)).toBe(false);

    expect(h.appended.length).toBe(1);
    expect(messageCount(h.db)).toBe(1);
  });

  // 以下四條是反向斷言：去重條件寫太寬會把真訊息擋在 truth source 之外，而那個失敗形態是
  // 靜默的（少寫比多寫難發現得多）。

  test("a genuinely new message still reaches JSONL", () => {
    expect(h.land(makeEvent({ platform_message_id: "m1" }))).toBe(true);
    expect(h.land(makeEvent({ platform_message_id: "m2", timestamp: T0 + 1 }))).toBe(true);

    expect(h.appended.map((e) => e.platform_message_id)).toEqual(["m1", "m2"]);
    expect(messageCount(h.db)).toBe(2);
  });

  test("the same message id in a different chat is not swallowed", () => {
    expect(h.land(makeEvent({ chat: { platform_id: "c1", type: "direct" } }))).toBe(true);
    expect(h.land(makeEvent({ chat: { platform_id: "c2", type: "direct" } }))).toBe(true);

    expect(h.appended.length).toBe(2);
    expect(messageCount(h.db)).toBe(2);
  });

  test("the same message id on a different platform is not swallowed", () => {
    expect(h.land(makeEvent({ platform: "line" }))).toBe(true);
    expect(h.land(makeEvent({ platform: "telegram" }))).toBe(true);

    expect(h.appended.length).toBe(2);
    expect(messageCount(h.db)).toBe(2);
  });

  test("a non-message event sharing the id of a landed message still lands", () => {
    expect(h.land(makeEvent({ platform_message_id: "m1" }))).toBe(true);
    expect(
      h.land(makeEvent({ type: "read_receipt", platform_message_id: "m1" }))
    ).toBe(true);

    expect(h.appended.length).toBe(2);
  });
});

/**
 * Phase 驗證的機械版：同一份 backfill 批次跨兩次 cold start 重放。
 *
 * 用真實 `JsonlWriter` 寫到磁碟而非收集器——放大倍率是**檔案行數**的性質，收集器測的是
 * 呼叫次數，兩者在「append 丟例外時 key 要復原」這類路徑上會分岔。
 */
describe("landBackfillEvent across two cold starts", () => {
  test("the second cold start re-pulling the same batch adds no JSONL lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "chatmux-f26-"));
    try {
      const jsonlPath = join(dir, "events.jsonl");
      const batch = Array.from({ length: 100 }, (_, i) =>
        makeEvent({ platform_message_id: `m${i}`, timestamp: T0 + i })
      );

      // cold start 1：全新的 data dir，整批第一次落地。
      const db1 = new Database(join(dir, "chatmux.db"));
      initSchema(db1);
      const jsonl1 = new JsonlWriter(jsonlPath);
      const land1 = makeLandBackfillEvent({
        jsonl: jsonl1,
        syncToSQLite: (e) => syncEventToSQLite(db1, e),
        db: db1,
      });
      for (const e of batch) land1(e);

      const linesAfterFirst = jsonl1.readLines().length;
      const distinctAfterFirst = messageCount(db1);
      db1.close();
      expect(linesAfterFirst).toBe(100);
      expect(distinctAfterFirst).toBe(100);

      // cold start 2：同一份 data dir 重開，adapter 又回同一批（＝現況每次冷啟動的行為）。
      const db2 = new Database(join(dir, "chatmux.db"));
      initSchema(db2);
      const jsonl2 = new JsonlWriter(jsonlPath);
      const land2 = makeLandBackfillEvent({
        jsonl: jsonl2,
        syncToSQLite: (e) => syncEventToSQLite(db2, e),
        db: db2,
      });
      for (const e of batch) land2(e);

      expect(jsonl2.readLines().length).toBe(linesAfterFirst);
      expect(messageCount(db2)).toBe(distinctAfterFirst);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
