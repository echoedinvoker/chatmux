import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateActivityColumn } from "../../src/core/storage/sqlite";

// The pre-F21 chats schema, spelled out here rather than obtained from initSchema(): the
// point of this suite is to migrate a database that predates the split, and initSchema
// already creates `last_activity_at` on fresh databases.
function createPreActivitySchema(db: Database): void {
  db.exec(`
    CREATE TABLE chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('direct', 'group', 'room')),
      name TEXT,
      last_message_at INTEGER,
      raw TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
      backfill_state TEXT,
      backfill_attempted_at INTEGER,
      backfill_oldest_id TEXT,
      UNIQUE(platform, platform_id)
    )
  `);

  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      platform_message_id TEXT NOT NULL,
      chat_id INTEGER NOT NULL REFERENCES chats(id),
      sender_id INTEGER,
      timestamp INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      content_text TEXT,
      content_media_url TEXT,
      raw TEXT,
      source TEXT NOT NULL CHECK(source IN ('live', 'backfill')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
      UNIQUE(platform, platform_message_id)
    )
  `);
}

function addChat(db: Database, platformId: string, lastMessageAt: number | null): number {
  db.prepare(
    "INSERT INTO chats (platform, platform_id, type, name, last_message_at) VALUES (?, ?, 'direct', ?, ?)"
  ).run("line", platformId, platformId, lastMessageAt);
  return db
    .query<{ id: number }, [string]>("SELECT id FROM chats WHERE platform_id = ?")
    .get(platformId)!.id;
}

function addMessage(db: Database, chatId: number, id: string, timestamp: number): void {
  db.prepare(
    "INSERT INTO messages (platform, platform_message_id, chat_id, timestamp, content_type, content_text, source) VALUES ('line', ?, ?, ?, 'text', 'hi', 'live')"
  ).run(id, chatId, timestamp);
}

function activityOf(db: Database, platformId: string): number | null {
  return db
    .query<{ last_activity_at: number | null }, [string]>(
      "SELECT last_activity_at FROM chats WHERE platform_id = ?"
    )
    .get(platformId)!.last_activity_at;
}

function messageAtOf(db: Database, platformId: string): number | null {
  return db
    .query<{ last_message_at: number | null }, [string]>(
      "SELECT last_message_at FROM chats WHERE platform_id = ?"
    )
    .get(platformId)!.last_message_at;
}

describe("migrateActivityColumn", () => {
  let db: Database;

  const DRIFT = 1_753_000_000_000; // adapter-reported activity, no landed message behind it
  const LANDED = 1_752_000_000_000; // newest landed message

  beforeEach(() => {
    db = new Database(":memory:");
    createPreActivitySchema(db);

    // A chat whose adapter-reported recency runs ahead of its landed messages (the F21 case).
    const drifted = addChat(db, "c_drift", DRIFT);
    addMessage(db, drifted, "m1", LANDED - 1000);
    addMessage(db, drifted, "m2", LANDED);

    // A healthy chat: reported recency equals its newest landed message.
    const healthy = addChat(db, "c_healthy", LANDED);
    addMessage(db, healthy, "m3", LANDED);

    // A chat with no messages at all, but with a reported recency.
    addChat(db, "c_empty", DRIFT);

    // A chat that has never been touched by either path.
    addChat(db, "c_null", null);
  });

  afterEach(() => db.close());

  test("adds the last_activity_at column", () => {
    migrateActivityColumn(db);

    const columns = new Set(
      db.query<{ name: string }, []>("PRAGMA table_info(chats)").all().map((c) => c.name)
    );
    expect(columns.has("last_activity_at")).toBe(true);
  });

  test("seeds last_activity_at from the pre-migration last_message_at", () => {
    migrateActivityColumn(db);

    expect(activityOf(db, "c_drift")).toBe(DRIFT);
    expect(activityOf(db, "c_healthy")).toBe(LANDED);
    expect(activityOf(db, "c_empty")).toBe(DRIFT);
    expect(activityOf(db, "c_null")).toBeNull();
  });

  test("recomputes last_message_at as the newest landed message", () => {
    migrateActivityColumn(db);

    expect(messageAtOf(db, "c_drift")).toBe(LANDED);
    expect(messageAtOf(db, "c_healthy")).toBe(LANDED);
    expect(messageAtOf(db, "c_empty")).toBeNull();
    expect(messageAtOf(db, "c_null")).toBeNull();
  });

  // A second initSchema() call happens on every daemon start. Re-seeding activity from
  // last_message_at then would drag a legitimately advanced activity backwards, so the guard
  // has to cover the whole function — not just the ALTER.
  test("is idempotent against activity that advanced between runs", () => {
    migrateActivityColumn(db);

    const advanced = DRIFT + 2 * 86_400_000;
    db.prepare("UPDATE chats SET last_activity_at = ? WHERE platform_id = 'c_drift'").run(advanced);

    migrateActivityColumn(db);

    expect(activityOf(db, "c_drift")).toBe(advanced);
    expect(messageAtOf(db, "c_drift")).toBe(LANDED);
  });
});
