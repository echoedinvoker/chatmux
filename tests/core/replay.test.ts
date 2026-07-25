import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, syncEventToSQLite } from "../../src/core/storage/sqlite";
import { initFTS } from "../../src/core/storage/fts";
import type { JsonlEvent } from "../../src/core/storage/jsonl";
import { replayJsonl } from "../../src/core/storage/replay";

interface Row {
  platform_message_id: string;
  seq: number;
  content_text: string | null;
  edited_at: number | null;
  retracted_at: number | null;
}

function messageEvent(id: string, text: string, timestamp: number): JsonlEvent {
  return {
    type: "message",
    platform: "telegram",
    platform_message_id: id,
    chat: { platform_id: "-100123", type: "group", name: "Room" },
    sender: { platform_id: "u_1", display_name: "Alice" },
    timestamp,
    content: { type: "text", text },
    raw: {},
    source: "live",
  };
}

function editEvent(id: string, text: string, timestamp: number): JsonlEvent {
  return {
    type: "edit",
    platform: "telegram",
    platform_message_id: id,
    chat: { platform_id: "-100123", type: "unknown" },
    timestamp,
    content: { type: "text", text },
    raw: {},
    source: "live",
  } as unknown as JsonlEvent;
}

function unsendEvent(id: string, timestamp: number): JsonlEvent {
  return {
    type: "unsend",
    platform: "telegram",
    platform_message_id: id,
    chat: { platform_id: "-100123", type: "unknown" },
    timestamp,
    content: { type: "unsend" },
    raw: {},
    source: "live",
    received_at: 1_700_000_500_000,
  } as unknown as JsonlEvent;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  initSchema(db);
  initFTS(db);
  return db;
}

function rows(db: Database): Row[] {
  return db
    .query<Row, []>(
      `SELECT platform_message_id, seq, content_text, edited_at, retracted_at
       FROM messages ORDER BY id ASC`
    )
    .all();
}

const STREAM: JsonlEvent[] = [
  messageEvent("200", "第一則", 1_700_000_000_000),
  messageEvent("201", "第二則", 1_700_000_001_000),
  editEvent("200", "第一則（編輯後）", 1_700_000_002_000),
  messageEvent("202", "第三則", 1_700_000_003_000),
  unsendEvent("201", 1_700_000_004_000),
  // 先編輯後收回
  editEvent("202", "第三則（編輯後）", 1_700_000_005_000),
  unsendEvent("202", 1_700_000_006_000),
  // 亂序：edit 先於它的 message（目標不存在 → 忽略，不建幽靈列）
  editEvent("300", "孤兒編輯", 1_700_000_007_000),
  messageEvent("300", "後到的訊息", 1_700_000_008_000),
];

describe("replayJsonl rebuilds the derived view from the event log", () => {
  let live: Database;
  let rebuilt: Database;

  beforeEach(() => {
    live = freshDb();
    for (const e of STREAM) syncEventToSQLite(live, e);

    rebuilt = freshDb();
    replayJsonl(rebuilt, STREAM);
  });

  afterEach(() => {
    live.close();
    rebuilt.close();
  });

  test("rebuild matches the live projection column by column", () => {
    expect(rows(rebuilt)).toEqual(rows(live));
  });

  test("the replayed stream carries the expected end state", () => {
    const byId = new Map(rows(rebuilt).map((r) => [r.platform_message_id, r]));

    expect(byId.get("200")!.content_text).toBe("第一則（編輯後）");
    expect(byId.get("200")!.edited_at).toBe(1_700_000_002_000);

    expect(byId.get("201")!.content_text).toBeNull();
    expect(byId.get("201")!.retracted_at).toBe(1_700_000_004_000);

    expect(byId.get("202")!.content_text).toBeNull();
    expect(byId.get("202")!.retracted_at).toBe(1_700_000_006_000);
    expect(byId.get("202")!.edited_at).toBe(1_700_000_005_000);

    // 孤兒 edit 被忽略，之後到的 message 以原始內容落地
    expect(byId.get("300")!.content_text).toBe("後到的訊息");
    expect(byId.get("300")!.edited_at).toBeNull();
  });

  test("replaying into an empty db creates no ghost rows", () => {
    expect(rows(rebuilt).length).toBe(4);
  });
});

/**
 * syncCheck 在啟動時把 JSONL 尾端重播進 SQLite。它現在餵的是整段尾巴（不再挑「缺漏的
 * message」——那個判斷對變更事件永遠成立為「不缺」，edit 因此永遠不會被補上），所以三種
 * 型別的冪等保證是它的前提。
 */
describe("syncCheck tail replay", () => {
  let db: Database;
  const tail: JsonlEvent[] = [
    messageEvent("500", "原文", 1_700_001_000_000),
    editEvent("500", "編輯後", 1_700_001_001_000),
    unsendEvent("501", 1_700_001_002_000),
  ];

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    db.close();
  });

  test("an edit in the tail is applied even though its target row already exists", () => {
    // 模擬「message 已同步、edit 還沒」的重啟狀態
    syncEventToSQLite(db, tail[0]!);
    expect(rows(db)[0]!.content_text).toBe("原文");

    replayJsonl(db, tail);

    expect(rows(db)[0]!.content_text).toBe("編輯後");
    expect(rows(db)[0]!.edited_at).toBe(1_700_001_001_000);
  });

  test("running the tail replay twice leaves seq untouched", () => {
    replayJsonl(db, tail);
    const first = rows(db);

    replayJsonl(db, tail);

    expect(rows(db)).toEqual(first);
  });
});
