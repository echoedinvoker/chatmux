import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, syncEventToSQLite } from "../../src/core/storage/sqlite";
import { initFTS } from "../../src/core/storage/fts";
import type { JsonlEvent } from "../../src/core/storage/jsonl";
import {
  handleReadEvents,
  handleReadMessages,
  handleSearchMessages,
  handleListChats,
  encodeCursor,
} from "../../src/core/mcp/tools";

const CHAT_ID = "telegram:-100123";

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
    received_at: 1_700_002_000_000,
  } as unknown as JsonlEvent;
}

function ok(result: ReturnType<typeof handleReadEvents>) {
  if ("error" in result) throw new Error(`unexpected error: ${result.detail}`);
  return result;
}

describe("read_events surfaces changes to already-sequenced messages", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    initFTS(db);
    for (let i = 1; i <= 5; i++) {
      syncEventToSQLite(db, messageEvent(String(600 + i), `訊息 ${i}`, 1_700_000_000_000 + i * 1000));
    }
  });

  afterEach(() => {
    db.close();
  });

  /** 消費者追到隊尾後停在那個 cursor。 */
  function cursorAtHead(): string {
    return ok(handleReadEvents(db, {})).head_cursor;
  }

  test("an edit to a message older than the cursor is delivered", () => {
    const c = cursorAtHead();
    syncEventToSQLite(db, editEvent("601", "第一則改過了", 1_700_000_100_000));

    const res = ok(handleReadEvents(db, { since: c }));

    expect(res.events.length).toBe(1);
    expect(res.events[0]!.type).toBe("edit");
    expect(res.events[0]!.message.id).toBe("telegram:601");
    expect(res.events[0]!.message.content.text).toBe("第一則改過了");
    expect(res.events[0]!.message.edited_at).toBe(1_700_000_100_000);
    expect(res.events[0]!.message.retracted_at).toBeNull();
  });

  test("a retraction of a message older than the cursor is delivered", () => {
    const c = cursorAtHead();
    syncEventToSQLite(db, unsendEvent("602", 1_700_000_200_000));

    const res = ok(handleReadEvents(db, { since: c }));

    expect(res.events.length).toBe(1);
    expect(res.events[0]!.type).toBe("unsend");
    expect(res.events[0]!.message.content.text).toBeNull();
    expect(res.events[0]!.message.retracted_at).toBe(1_700_000_200_000);
  });

  test("retraction wins over edit when a message was edited then retracted", () => {
    const c = cursorAtHead();
    syncEventToSQLite(db, editEvent("603", "先編輯", 1_700_000_300_000));
    syncEventToSQLite(db, unsendEvent("603", 1_700_000_400_000));

    const res = ok(handleReadEvents(db, { since: c }));

    expect(res.events.length).toBe(1);
    expect(res.events[0]!.type).toBe("unsend");
    expect(res.events[0]!.message.edited_at).toBe(1_700_000_300_000);
  });

  test("cursors never move backwards across successive changes", () => {
    const seen: number[] = [];
    let cursor = cursorAtHead();

    for (const [i, text] of ["一", "二", "三"].entries()) {
      syncEventToSQLite(db, editEvent("604", text, 1_700_000_500_000 + i * 1000));
      const res = ok(handleReadEvents(db, { since: cursor }));
      cursor = res.next_cursor;
      seen.push(Number(cursor.slice("evt:".length)));
    }

    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("a consumer that missed two edits still receives the final state", () => {
    const c = cursorAtHead();
    syncEventToSQLite(db, editEvent("605", "中途", 1_700_000_600_000));
    syncEventToSQLite(db, editEvent("605", "最終", 1_700_000_601_000));

    const res = ok(handleReadEvents(db, { since: c }));

    expect(res.events.length).toBe(1);
    expect(res.events[0]!.message.content.text).toBe("最終");
  });

  test("head_cursor tracks MAX(seq)", () => {
    const maxSeq = db.query<{ s: number }, []>("SELECT MAX(seq) s FROM messages").get()!.s;
    expect(ok(handleReadEvents(db, {})).head_cursor).toBe(encodeCursor(maxSeq));

    syncEventToSQLite(db, editEvent("601", "推進 seq", 1_700_000_700_000));
    const bumped = db.query<{ s: number }, []>("SELECT MAX(seq) s FROM messages").get()!.s;

    expect(bumped).toBeGreaterThan(maxSeq);
    expect(ok(handleReadEvents(db, {})).head_cursor).toBe(encodeCursor(bumped));
  });

  test("a cursor issued before the migration still means the same position", () => {
    // 既有列 seed 成 seq = id，所以舊 cursor evt:<id> 指向同一個位置
    const third = db
      .query<{ id: number }, [string]>("SELECT id FROM messages WHERE platform_message_id = ?")
      .get("603")!;

    const res = ok(handleReadEvents(db, { since: encodeCursor(third.id) }));

    expect(res.events.map((e) => e.message.id)).toEqual(["telegram:604", "telegram:605"]);
  });

  test("read_messages exposes change columns on every pagination branch", () => {
    syncEventToSQLite(db, unsendEvent("603", 1_700_000_800_000));
    syncEventToSQLite(db, editEvent("604", "編輯過的", 1_700_000_801_000));

    const branches = [
      handleReadMessages(db, { chat_id: CHAT_ID }),
      handleReadMessages(db, { chat_id: CHAT_ID, before: 1_700_000_900_000 }),
      handleReadMessages(db, { chat_id: CHAT_ID, after: 1_700_000_000_000 }),
    ];

    for (const branch of branches) {
      const retracted = branch.messages.find((m) => m.id === "telegram:603")!;
      const edited = branch.messages.find((m) => m.id === "telegram:604")!;

      expect(retracted.retracted_at).toBe(1_700_000_800_000);
      expect(retracted.content.text).toBeNull();
      expect(edited.edited_at).toBe(1_700_000_801_000);
      expect(edited.retracted_at).toBeNull();
    }
  });
});

describe("all read paths agree about a retracted message", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    initFTS(db);
    syncEventToSQLite(db, messageEvent("701", "會被收回的暗號蜜蜂", 1_700_000_000_000));
    syncEventToSQLite(db, messageEvent("702", "留著的訊息", 1_700_000_001_000));
  });

  afterEach(() => {
    db.close();
  });

  test("search_messages cannot find it — FTS branch", () => {
    expect(handleSearchMessages(db, { query: "暗號蜜蜂" }).results.length).toBe(1);
    syncEventToSQLite(db, unsendEvent("701", 1_700_000_002_000));
    expect(handleSearchMessages(db, { query: "暗號蜜蜂" }).results.length).toBe(0);
  });

  test("search_messages cannot find it — short-query LIKE branch", () => {
    // query.length < 3 走 LIKE fallback，不經過 FTS 索引，必須各自驗
    expect(handleSearchMessages(db, { query: "蜜蜂" }).results.length).toBe(1);
    syncEventToSQLite(db, unsendEvent("701", 1_700_000_003_000));
    expect(handleSearchMessages(db, { query: "蜜蜂" }).results.length).toBe(0);
  });

  test("read_messages reports it as retracted with null text", () => {
    syncEventToSQLite(db, unsendEvent("701", 1_700_000_004_000));
    const m = handleReadMessages(db, { chat_id: CHAT_ID }).messages.find((x) => x.id === "telegram:701")!;

    expect(m.content.text).toBeNull();
    expect(m.retracted_at).toBe(1_700_000_004_000);
  });

  test("list_chats survives its newest message being retracted", () => {
    syncEventToSQLite(db, unsendEvent("702", 1_700_000_005_000));
    const chat = handleListChats(db, {}).chats.find((c) => c.id === CHAT_ID)!;

    // 子查詢回 null 而不是報錯或洩漏原文。last_message_at 刻意不動——它的語意是
    // 「最後一則訊息的到達時間」，不是「最後一次狀態變動」。
    expect(chat.last_message!.text).toBeNull();
    expect(chat.last_message!.timestamp).toBe(1_700_000_001_000);
  });

  test("a retracted newest message still counts toward last_message_at (R7)", () => {
    syncEventToSQLite(db, unsendEvent("702", 1_700_000_005_000));
    const row = db.query<{ last_message_at: number | null; last_activity_at: number | null }, []>(
      "SELECT last_message_at, last_activity_at FROM chats LIMIT 1"
    ).get()!;

    // tombstone 是留在 messages 裡的一列（content_text = NULL, retracted_at 有值），
    // 所以它計入 MAX(m.timestamp)——使用者點進去看得到它。
    expect(row.last_message_at).toBe(1_700_000_001_000);
    expect(row.last_activity_at).toBeGreaterThanOrEqual(row.last_message_at!);
  });
});
