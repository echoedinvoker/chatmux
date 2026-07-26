import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../../src/core/storage/sqlite";
import {
  upsertChatsFromAdapter,
  applyMessageBoxRecency,
} from "../../src/core/storage/adapter-recency";

const LANDED = 1_752_000_000_000;
const REPORTED = LANDED + 12 * 86_400_000;

function seedChat(db: Database, platformId: string): void {
  db.prepare(
    "INSERT INTO chats (platform, platform_id, type, name, last_message_at, last_activity_at) VALUES ('line', ?, 'direct', ?, ?, ?)"
  ).run(platformId, platformId, LANDED, LANDED);
}

function read(db: Database, platformId: string) {
  return db
    .query<{ last_message_at: number | null; last_activity_at: number | null }, [string]>(
      "SELECT last_message_at, last_activity_at FROM chats WHERE platform_id = ?"
    )
    .get(platformId)!;
}

describe("adapter-reported recency (path B)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
  });

  afterEach(() => db.close());

  test("get_chats moves activity forward and leaves the landed-message time alone", () => {
    seedChat(db, "c_001");

    upsertChatsFromAdapter(db, "line", [
      { platform_id: "c_001", type: "direct", name: "Alice", last_activity_at: REPORTED },
    ]);

    const row = read(db, "c_001");
    expect(row.last_activity_at).toBe(REPORTED);
    expect(row.last_message_at).toBe(LANDED);
  });

  test("get_message_boxes moves activity forward and leaves the landed-message time alone", () => {
    seedChat(db, "c_001");

    const unknown = applyMessageBoxRecency(db, "line", [
      { id: "c_001", lastDeliveredTime: REPORTED },
    ]);

    expect(unknown).toBe(0);
    const row = read(db, "c_001");
    expect(row.last_activity_at).toBe(REPORTED);
    expect(row.last_message_at).toBe(LANDED);
  });

  // R8: LINE reports 0 for a box with no messages, which reaches SQLite as NULL. Scalar
  // max() returns NULL if any argument is NULL, so the unguarded form silently wiped a
  // healthy value — now the list's primary ordering key.
  test("a message box with no delivery time never clears an existing activity", () => {
    seedChat(db, "c_001");
    applyMessageBoxRecency(db, "line", [{ id: "c_001", lastDeliveredTime: REPORTED }]);

    applyMessageBoxRecency(db, "line", [{ id: "c_001", lastDeliveredTime: 0 }]);

    expect(read(db, "c_001").last_activity_at).toBe(REPORTED);
  });

  test("an adapter still sending the deprecated last_message_at name keeps its ordering signal", () => {
    seedChat(db, "c_001");

    upsertChatsFromAdapter(db, "line", [
      { platform_id: "c_001", type: "direct", name: "Alice", last_message_at: REPORTED },
    ]);

    const row = read(db, "c_001");
    expect(row.last_activity_at).toBe(REPORTED);
    expect(row.last_message_at).toBe(LANDED);
  });

  test("reports boxes referring to chats get_chats never announced", () => {
    expect(applyMessageBoxRecency(db, "line", [{ id: "c_ghost", lastDeliveredTime: REPORTED }])).toBe(1);
  });
});
