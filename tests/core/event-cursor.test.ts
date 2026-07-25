import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, syncEventToSQLite } from "../../src/core/storage/sqlite";
import { initFTS } from "../../src/core/storage/fts";
import type { JsonlEvent } from "../../src/core/storage/jsonl";
import { getEventsSince, getHeadSeq } from "../../src/core/storage/query";
import {
  handleReadEvents,
  handleReadMessages,
  encodeCursor,
  decodeCursor,
} from "../../src/core/mcp/tools";

const CHAT_ID = "line:c_001";

function makeEvent(
  id: string,
  timestamp: number,
  opts?: { source?: string; text?: string },
): JsonlEvent {
  return {
    type: "message",
    platform: "line",
    platform_message_id: id,
    chat: { platform_id: "c_001", type: "direct", name: "Alice" },
    sender: { platform_id: "u_001", display_name: "Alice" },
    timestamp,
    content: { type: "text", text: opts?.text ?? id },
    raw: {},
    source: opts?.source ?? "live",
  };
}

/** Narrow the union to the success shape, failing the test if it is an error. */
function ok(result: ReturnType<typeof handleReadEvents>) {
  if ("error" in result) throw new Error(`unexpected error: ${result.detail}`);
  return result;
}

describe("cursor codec", () => {
  test("round-trips a sequence", () => {
    expect(decodeCursor(encodeCursor(0))).toBe(0);
    expect(decodeCursor(encodeCursor(1642))).toBe(1642);
  });

  test("rejects tokens this core did not issue", () => {
    expect(decodeCursor("1642")).toBeNull();
    expect(decodeCursor("evt:")).toBeNull();
    expect(decodeCursor("evt:abc")).toBeNull();
    expect(decodeCursor("evt:-1")).toBeNull();
    expect(decodeCursor("evt:1.5")).toBeNull();
    expect(decodeCursor("msg:1")).toBeNull();
  });
});

describe("event cursor", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    initFTS(db);
  });

  afterEach(() => {
    db.close();
  });

  test("head is 0 on an empty log", () => {
    expect(getHeadSeq(db)).toBe(0);
    const result = ok(handleReadEvents(db, {}));
    expect(result.events).toEqual([]);
    expect(result.next_cursor).toBe(encodeCursor(0));
    expect(result.has_more).toBe(false);
  });

  test("omitting since returns the head without replaying history", () => {
    syncEventToSQLite(db, makeEvent("m_001", 1000));
    syncEventToSQLite(db, makeEvent("m_002", 2000));

    const result = ok(handleReadEvents(db, {}));
    expect(result.events).toEqual([]);
    expect(result.next_cursor).toBe(result.head_cursor);
    expect(decodeCursor(result.next_cursor)).toBe(getHeadSeq(db));
  });

  test("returns events after a cursor in ascending write order", () => {
    syncEventToSQLite(db, makeEvent("m_001", 1000));
    const start = ok(handleReadEvents(db, {})).next_cursor;

    syncEventToSQLite(db, makeEvent("m_002", 2000));
    syncEventToSQLite(db, makeEvent("m_003", 3000));

    const result = ok(handleReadEvents(db, { since: start }));
    expect(result.events.map(e => e.message.id)).toEqual([
      "line:m_002",
      "line:m_003",
    ]);
    expect(result.has_more).toBe(false);
  });

  test("resuming from next_cursor delivers each event exactly once", () => {
    syncEventToSQLite(db, makeEvent("m_001", 1000));
    syncEventToSQLite(db, makeEvent("m_002", 2000));
    syncEventToSQLite(db, makeEvent("m_003", 3000));

    const seen: string[] = [];
    let cursor = encodeCursor(0);
    for (;;) {
      const page = ok(handleReadEvents(db, { since: cursor, limit: 2 }));
      seen.push(...page.events.map(e => e.message.id));
      cursor = page.next_cursor;
      if (!page.has_more) break;
    }

    expect(seen).toEqual(["line:m_001", "line:m_002", "line:m_003"]);

    // Draining again from the final cursor yields nothing — no duplicates.
    expect(ok(handleReadEvents(db, { since: cursor })).events).toEqual([]);
  });

  test("paginates with has_more and a stable next_cursor", () => {
    for (let i = 1; i <= 5; i++) {
      syncEventToSQLite(db, makeEvent(`m_00${i}`, 1000 * i));
    }

    const first = ok(handleReadEvents(db, { since: encodeCursor(0), limit: 2 }));
    expect(first.events.length).toBe(2);
    expect(first.has_more).toBe(true);

    const second = ok(handleReadEvents(db, { since: first.next_cursor, limit: 2 }));
    expect(second.events.map(e => e.message.id)).toEqual(["line:m_003", "line:m_004"]);
    expect(second.has_more).toBe(true);

    const third = ok(handleReadEvents(db, { since: second.next_cursor, limit: 2 }));
    expect(third.events.map(e => e.message.id)).toEqual(["line:m_005"]);
    expect(third.has_more).toBe(false);
  });

  test("an idle consumer keeps a valid cursor when nothing is new", () => {
    syncEventToSQLite(db, makeEvent("m_001", 1000));
    const head = ok(handleReadEvents(db, {})).next_cursor;

    const idle = ok(handleReadEvents(db, { since: head }));
    expect(idle.events).toEqual([]);
    expect(idle.next_cursor).toBe(head);
  });

  test("rejects a cursor it did not issue", () => {
    const result = handleReadEvents(db, { since: "42" });
    expect("error" in result && result.error).toBe("invalid_cursor");
  });

  test("head_cursor lets a consumer detect a cursor ahead of the log", () => {
    syncEventToSQLite(db, makeEvent("m_001", 1000));

    // Simulates a stored cursor from a DB that was later rebuilt smaller.
    const ahead = ok(handleReadEvents(db, { since: encodeCursor(9999) }));
    expect(ahead.events).toEqual([]);
    expect(decodeCursor(ahead.next_cursor)!).toBeGreaterThan(
      decodeCursor(ahead.head_cursor)!,
    );
  });

  // The whole reason this primitive exists. `read_messages({ after })` filters on
  // timestamp, so a backfilled message older than the consumer's last-seen time is
  // invisible to it forever. The cursor is write-order, so it still arrives.
  test("backfill inserting an OLDER message still advances the cursor", () => {
    syncEventToSQLite(db, makeEvent("m_live", 5000));
    const caughtUp = ok(handleReadEvents(db, {})).next_cursor;

    syncEventToSQLite(db, makeEvent("m_old", 1000, { source: "backfill" }));

    const result = ok(handleReadEvents(db, { since: caughtUp }));
    expect(result.events.map(e => e.message.id)).toEqual(["line:m_old"]);
    expect(result.events[0]!.message.timestamp).toBe(1000);
  });

  test("timestamp-based read_messages misses what the cursor catches", () => {
    syncEventToSQLite(db, makeEvent("m_live", 5000));
    const caughtUp = ok(handleReadEvents(db, {})).next_cursor;
    syncEventToSQLite(db, makeEvent("m_old", 1000, { source: "backfill" }));

    // A consumer tracking progress by timestamp asks for anything after 5000.
    const byTimestamp = handleReadMessages(db, { chat_id: CHAT_ID, after: 5000 });
    expect(byTimestamp.messages.map(m => m.id)).not.toContain("line:m_old");

    // The same progress tracked by cursor sees it.
    const byCursor = ok(handleReadEvents(db, { since: caughtUp }));
    expect(byCursor.events.map(e => e.message.id)).toContain("line:m_old");
  });

  test("deduped re-delivery does not advance the cursor", () => {
    const event = makeEvent("m_001", 1000);
    syncEventToSQLite(db, event);
    const head = getHeadSeq(db);

    // Live and backfill can both carry the same message (NEVER #7).
    syncEventToSQLite(db, { ...event, source: "backfill" });

    expect(getHeadSeq(db)).toBe(head);
    expect(ok(handleReadEvents(db, { since: encodeCursor(head) })).events).toEqual([]);
  });

  test("getEventsSince respects its limit", () => {
    for (let i = 1; i <= 5; i++) {
      syncEventToSQLite(db, makeEvent(`m_00${i}`, 1000 * i));
    }
    expect(getEventsSince(db, 0, 3).length).toBe(3);
    expect(getEventsSince(db, 0, 100).length).toBe(5);
  });
});
