import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, syncEventToSQLite } from "../../src/core/storage/sqlite";
import { initFTS } from "../../src/core/storage/fts";
import type { JsonlEvent } from "../../src/core/storage/jsonl";

interface Row {
  id: number;
  seq: number;
  content_text: string | null;
  content_media_url: string | null;
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

/** edit 事件不帶 sender：core 不用它（D4），型別上仍需 cast。 */
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
    received_at: 1_700_000_000_000,
  } as unknown as JsonlEvent;
}

function row(db: Database, id: string): Row | null {
  return db
    .query<Row, [string]>(
      `SELECT id, seq, content_text, content_media_url, edited_at, retracted_at
       FROM messages WHERE platform = 'telegram' AND platform_message_id = ?`
    )
    .get(id);
}

function count(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM messages").get()!.n;
}

describe("syncEventToSQLite applies change events to existing rows", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    initFTS(db);
    syncEventToSQLite(db, messageEvent("100", "原始內容", 1_700_000_000_000));
    syncEventToSQLite(db, messageEvent("101", "鄰居甲", 1_700_000_001_000));
    syncEventToSQLite(db, messageEvent("102", "鄰居乙", 1_700_000_002_000));
  });

  afterEach(() => {
    db.close();
  });

  test("edit updates content_text and edited_at, keeps id", () => {
    const before = row(db, "100")!;
    syncEventToSQLite(db, editEvent("100", "編輯後內容", 1_700_000_009_000));
    const after = row(db, "100")!;

    expect(after.id).toBe(before.id);
    expect(after.content_text).toBe("編輯後內容");
    expect(after.edited_at).toBe(1_700_000_009_000);
    expect(after.retracted_at).toBeNull();
    expect(after.seq).toBeGreaterThan(before.seq);
  });

  test("unsend clears content and stamps retracted_at", () => {
    const before = row(db, "100")!;
    syncEventToSQLite(db, unsendEvent("100", 1_700_000_010_000));
    const after = row(db, "100")!;

    expect(after.content_text).toBeNull();
    expect(after.content_media_url).toBeNull();
    expect(after.retracted_at).toBe(1_700_000_010_000);
    expect(after.seq).toBeGreaterThan(before.seq);
  });

  test("edit for an unknown message is ignored — no throw, no ghost row", () => {
    const n = count(db);
    expect(() => syncEventToSQLite(db, editEvent("999", "幽靈", 1_700_000_011_000))).not.toThrow();
    expect(count(db)).toBe(n);
    expect(row(db, "999")).toBeNull();
  });

  test("unsend for an unknown message is ignored — no throw, no ghost row", () => {
    const n = count(db);
    expect(() => syncEventToSQLite(db, unsendEvent("999", 1_700_000_012_000))).not.toThrow();
    expect(count(db)).toBe(n);
    expect(row(db, "999")).toBeNull();
  });

  test("edit then unsend ends retracted with null content", () => {
    syncEventToSQLite(db, editEvent("100", "中途內容", 1_700_000_013_000));
    syncEventToSQLite(db, unsendEvent("100", 1_700_000_014_000));
    const after = row(db, "100")!;

    expect(after.content_text).toBeNull();
    expect(after.retracted_at).toBe(1_700_000_014_000);
    expect(after.edited_at).toBe(1_700_000_013_000);
  });

  test("edit after unsend is refused — retraction is terminal", () => {
    syncEventToSQLite(db, unsendEvent("100", 1_700_000_015_000));
    const retracted = row(db, "100")!;
    syncEventToSQLite(db, editEvent("100", "復活內容", 1_700_000_016_000));
    const after = row(db, "100")!;

    expect(after.content_text).toBeNull();
    expect(after.retracted_at).toBe(1_700_000_015_000);
    expect(after.seq).toBe(retracted.seq);
  });

  test("changes do not touch sibling messages", () => {
    const a = row(db, "101")!;
    const b = row(db, "102")!;
    syncEventToSQLite(db, editEvent("100", "只動我", 1_700_000_017_000));
    syncEventToSQLite(db, unsendEvent("101", 1_700_000_018_000));

    expect(row(db, "102")).toEqual(b);
    expect(row(db, "101")!.content_text).toBeNull();
    expect(a.content_text).toBe("鄰居甲");
  });

  test("unsend is idempotent — a repeat does not bump seq", () => {
    syncEventToSQLite(db, unsendEvent("100", 1_700_000_019_000));
    const first = row(db, "100")!;
    syncEventToSQLite(db, unsendEvent("100", 1_700_000_019_000));
    const second = row(db, "100")!;

    expect(second.seq).toBe(first.seq);
    expect(second.retracted_at).toBe(first.retracted_at);
  });

  test("unsend with timestamp 0 must not store retracted_at = 0", () => {
    syncEventToSQLite(db, unsendEvent("100", 0));
    const after = row(db, "100")!;

    expect(after.retracted_at).not.toBe(0);
    expect(after.retracted_at).not.toBeNull();
  });

  test("edit is idempotent — replaying the same edit does not bump seq", () => {
    const e = editEvent("100", "同一次編輯", 1_700_000_020_000);
    syncEventToSQLite(db, e);
    const first = row(db, "100")!;
    syncEventToSQLite(db, e);
    const second = row(db, "100")!;

    expect(second.seq).toBe(first.seq);
    expect(second.content_text).toBe("同一次編輯");
  });

  test("edit without a sender field applies normally", () => {
    const e = editEvent("100", "無 sender", 1_700_000_021_000) as unknown as Record<string, unknown>;
    delete e.sender;

    expect(() => syncEventToSQLite(db, e as unknown as JsonlEvent)).not.toThrow();
    expect(row(db, "100")!.content_text).toBe("無 sender");
  });

  test("two consecutive edits both land (streaming bot case)", () => {
    syncEventToSQLite(db, editEvent("100", "第一次", 1_700_000_022_000));
    const first = row(db, "100")!;
    syncEventToSQLite(db, editEvent("100", "第二次", 1_700_000_023_000));
    const second = row(db, "100")!;

    expect(second.content_text).toBe("第二次");
    expect(second.seq).toBeGreaterThan(first.seq);
  });

  test("new messages get a monotonic seq", () => {
    const a = row(db, "100")!;
    const b = row(db, "101")!;
    const c = row(db, "102")!;

    expect(b.seq).toBeGreaterThan(a.seq);
    expect(c.seq).toBeGreaterThan(b.seq);
  });
});
