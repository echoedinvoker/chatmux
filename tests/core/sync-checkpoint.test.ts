import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, appendFileSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSchema } from "../../src/core/storage/sqlite";
import { initFTS } from "../../src/core/storage/fts";
import { JsonlWriter, type JsonlEvent } from "../../src/core/storage/jsonl";
import { replayFrom } from "../../src/core/storage/replay";

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
    received_at: timestamp,
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
    received_at: timestamp,
  } as unknown as JsonlEvent;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  initSchema(db);
  initFTS(db);
  return db;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chatmux-sync-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writerWith(events: JsonlEvent[]): { jsonl: JsonlWriter; path: string } {
  const path = join(dir, "events.jsonl");
  const jsonl = new JsonlWriter(path);
  for (const e of events) jsonl.append(e);
  return { jsonl, path };
}

function messageCount(db: Database): number {
  return db.query<{ n: number }, []>("SELECT count(*) AS n FROM messages").get()!.n;
}

function storedOffset(db: Database): number | null {
  const row = db
    .query<{ byte_offset: number }, []>("SELECT byte_offset FROM sync_state WHERE source = 'events.jsonl'")
    .get();
  return row?.byte_offset ?? null;
}

function byteLengthOfFirstLines(path: string, count: number): number {
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");
  return Buffer.byteLength(lines.slice(0, count).join("\n") + "\n", "utf-8");
}

describe("sync_state schema", () => {
  test("initSchema creates an empty sync_state table", () => {
    const db = freshDb();
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(sync_state)")
      .all()
      .map((c) => c.name);

    expect(columns).toEqual(["source", "byte_offset", "updated_at"]);
    expect(db.query("SELECT count(*) AS n FROM sync_state").get()).toEqual({ n: 0 });
    db.close();
  });

  test("initSchema is idempotent and preserves an existing checkpoint", () => {
    const path = join(dir, "schema.db");
    const db = new Database(path);
    initSchema(db);
    db.exec("INSERT INTO sync_state (source, byte_offset, updated_at) VALUES ('events.jsonl', 4242, 1)");
    db.close();

    const reopened = new Database(path);
    initSchema(reopened);

    expect(reopened.query("SELECT byte_offset AS o FROM sync_state").get()).toEqual({ o: 4242 });
    reopened.close();
  });
});

describe("JsonlWriter.readFrom", () => {
  const events = [
    messageEvent("1", "第一則", 1_700_000_000_000),
    messageEvent("2", "第二則", 1_700_000_001_000),
    messageEvent("3", "第三則", 1_700_000_002_000),
    messageEvent("4", "第四則", 1_700_000_003_000),
    messageEvent("5", "第五則", 1_700_000_004_000),
  ];

  test("(i) offset 0 reads every line and lands nextOffset at EOF", () => {
    const { jsonl, path } = writerWith(events);
    const chunk = jsonl.readFrom(0);

    expect(chunk.events.map((e) => e.platform_message_id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(chunk.nextOffset).toBe(statSync(path).size);
  });

  test("(ii) a mid-file offset returns only the lines after it", () => {
    const { jsonl, path } = writerWith(events);
    const offset = byteLengthOfFirstLines(path, 3);

    const chunk = jsonl.readFrom(offset);

    expect(chunk.events.map((e) => e.platform_message_id)).toEqual(["4", "5"]);
    expect(chunk.nextOffset).toBe(statSync(path).size);
  });

  test("(iii) a torn trailing line is discarded and nextOffset stops after the last newline", () => {
    const { jsonl, path } = writerWith(events);
    const complete = statSync(path).size;
    appendFileSync(path, '{"type":"message","platform":"tel');

    const chunk = jsonl.readFrom(0);

    expect(chunk.events.map((e) => e.platform_message_id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(chunk.nextOffset).toBe(complete);
  });

  test("(iii-b) remaining data with no newline at all yields nothing and does not move the offset", () => {
    const { jsonl, path } = writerWith(events);
    const complete = statSync(path).size;
    appendFileSync(path, '{"type":"message","platform":"tel');

    const chunk = jsonl.readFrom(complete);

    expect(chunk.events).toEqual([]);
    expect(chunk.nextOffset).toBe(complete);
  });

  test("(iv) an offset at or past EOF yields nothing and does not move", () => {
    const { jsonl, path } = writerWith(events);
    const size = statSync(path).size;

    expect(jsonl.readFrom(size)).toEqual({ events: [], nextOffset: size });
    expect(jsonl.readFrom(size + 500)).toEqual({ events: [], nextOffset: size + 500 });
  });

  test("(v) maxBytes smaller than the next line still returns that whole line", () => {
    const { jsonl, path } = writerWith(events);
    const firstLineEnd = byteLengthOfFirstLines(path, 1);

    const chunk = jsonl.readFrom(0, 5);

    expect(chunk.events.map((e) => e.platform_message_id)).toEqual(["1"]);
    expect(chunk.nextOffset).toBe(firstLineEnd);
    expect(chunk.nextOffset).toBeGreaterThan(0);
  });
});

describe("replayFrom", () => {
  const events = [
    messageEvent("1", "第一則", 1_700_000_000_000),
    messageEvent("2", "第二則", 1_700_000_001_000),
    editEvent("1", "第一則（編輯後）", 1_700_000_002_000),
    messageEvent("3", "第三則", 1_700_000_003_000),
    messageEvent("4", "第四則", 1_700_000_004_000),
  ];

  test("(i) a database with no checkpoint projects the whole log", () => {
    const db = freshDb();
    const { jsonl, path } = writerWith(events);

    const result = replayFrom(db, jsonl);

    expect(messageCount(db)).toBe(4);
    expect(result.events).toBe(5);
    expect(result.finalOffset).toBe(statSync(path).size);
    expect(storedOffset(db)).toBe(statSync(path).size);
    db.close();
  });

  test("(ii) a stored checkpoint keeps earlier events from being replayed", () => {
    const db = freshDb();
    const { jsonl, path } = writerWith(events);

    // 前三行含 message 1/2 與 edit(1)。從第 3 行之後起播，edit 不該被套用。
    const offset = byteLengthOfFirstLines(path, 3);
    db.exec(`INSERT INTO sync_state (source, byte_offset, updated_at) VALUES ('events.jsonl', ${offset}, 1)`);

    const result = replayFrom(db, jsonl);

    expect(result.events).toBe(2);
    expect(messageCount(db)).toBe(2);
    expect(db.query<{ t: string | null }, []>("SELECT content_text AS t FROM messages ORDER BY id").all())
      .toEqual([{ t: "第三則" }, { t: "第四則" }]);
    db.close();
  });

  test("(iii) a small batchBytes splits the work without changing the outcome", () => {
    const single = freshDb();
    const { jsonl } = writerWith(events);
    replayFrom(single, jsonl);

    const batched = freshDb();
    const result = replayFrom(batched, jsonl, { batchBytes: 200 });

    expect(result.batches).toBeGreaterThan(1);
    expect(result.events).toBe(5);
    expect(
      batched.query("SELECT platform_message_id, content_text, edited_at FROM messages ORDER BY id").all()
    ).toEqual(single.query("SELECT platform_message_id, content_text, edited_at FROM messages ORDER BY id").all());
    single.close();
    batched.close();
  });

  test("(iv) resuming after an interruption loses and duplicates nothing", () => {
    const db = freshDb();
    const { jsonl, path } = writerWith(events.slice(0, 2));

    const first = replayFrom(db, jsonl);
    expect(messageCount(db)).toBe(2);

    for (const e of events.slice(2)) jsonl.append(e);
    const second = replayFrom(db, jsonl);

    expect(second.events).toBe(3);
    expect(first.events + second.events).toBe(5);
    expect(messageCount(db)).toBe(4);
    expect(storedOffset(db)).toBe(statSync(path).size);
    db.close();
  });

  test("(v) a truncated log replays from zero instead of throwing", () => {
    const db = freshDb();
    const { jsonl, path } = writerWith(events);
    replayFrom(db, jsonl);

    const shrunk = readFileSync(path, "utf-8").split("\n").slice(0, 2).join("\n") + "\n";
    writeFileSync(path, shrunk);

    const result = replayFrom(db, jsonl);

    expect(result.finalOffset).toBe(statSync(path).size);
    expect(result.events).toBe(2);
    expect(storedOffset(db)).toBe(statSync(path).size);
    db.close();
  });
});
