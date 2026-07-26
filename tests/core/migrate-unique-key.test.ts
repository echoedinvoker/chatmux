import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, migrateMessageUniqueKey } from "../../src/core/storage/sqlite";
import { initFTS, searchFTS } from "../../src/core/storage/fts";

// The pre-F16 schema, spelled out here rather than obtained from initSchema(): the point of
// this suite is to migrate a database that predates the fix, and initSchema will eventually
// have already applied the migration.
function createLegacySchema(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

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
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      raw TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
      UNIQUE(platform, platform_id)
    )
  `);

  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      platform_message_id TEXT NOT NULL,
      chat_id INTEGER NOT NULL REFERENCES chats(id),
      sender_id INTEGER REFERENCES contacts(id),
      timestamp INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      content_text TEXT,
      content_media_url TEXT,
      raw TEXT,
      source TEXT NOT NULL CHECK(source IN ('live', 'backfill')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
      seq INTEGER,
      edited_at INTEGER,
      retracted_at INTEGER,
      UNIQUE(platform, platform_message_id)
    )
  `);

  db.exec("CREATE INDEX idx_messages_chat_timestamp ON messages(chat_id, timestamp DESC)");
  db.exec("CREATE INDEX idx_messages_timestamp ON messages(timestamp DESC)");
  db.exec("CREATE UNIQUE INDEX idx_messages_seq ON messages(seq)");

  db.exec(`
    CREATE TABLE attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id),
      type TEXT NOT NULL CHECK(type IN ('image', 'video', 'audio', 'file')),
      original_url TEXT,
      local_path TEXT,
      file_name TEXT,
      file_size INTEGER,
      downloaded_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
    )
  `);

  initFTS(db);
}

function seed(db: Database): void {
  db.exec(`
    INSERT INTO chats (id, platform, platform_id, type, name)
    VALUES (1, 'telegram', '8546705305', 'direct', 'Matt TXO Alert'),
           (2, 'telegram', '-100999', 'group', '基隆澎湖金門')
  `);

  const insertMsg = db.prepare(
    `INSERT INTO messages (id, platform, platform_message_id, chat_id, timestamp, content_type, content_text, source, seq)
     VALUES (?, 'telegram', ?, ?, ?, 'text', ?, 'live', ?)`
  );
  insertMsg.run(10, "20445", 2, 1_700_000_000_000, "群組的訊息 needle", 10);
  insertMsg.run(11, "4605", 1, 1_700_000_001_000, "一對一的訊息 needle", 77);

  db.exec("INSERT INTO attachments (id, message_id, type) VALUES (1, 10, 'image')");
}

describe("F16 migration: message unique key becomes per-chat", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    createLegacySchema(db);
    seed(db);
  });

  afterEach(() => {
    db.close();
  });

  test("preserves rows, ids and seq values", () => {
    migrateMessageUniqueKey(db);

    const rows = db
      .query<{ id: number; platform_message_id: string; chat_id: number; seq: number }, []>(
        "SELECT id, platform_message_id, chat_id, seq FROM messages ORDER BY id"
      )
      .all();

    expect(rows).toEqual([
      { id: 10, platform_message_id: "20445", chat_id: 2, seq: 10 },
      { id: 11, platform_message_id: "4605", chat_id: 1, seq: 77 },
    ]);
  });

  test("keeps the attachments foreign key intact", () => {
    migrateMessageUniqueKey(db);

    const violations = db.query("PRAGMA foreign_key_check").all();
    expect(violations).toEqual([]);
  });

  test("leaves foreign key enforcement switched on afterwards", () => {
    migrateMessageUniqueKey(db);

    const [row] = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").all();
    expect(row?.foreign_keys).toBe(1);
  });

  test("rebuilds the FTS index without duplicating it", () => {
    migrateMessageUniqueKey(db);

    expect(searchFTS(db, "needle").map((r) => r.id).sort()).toEqual([10, 11]);

    const [fts] = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages_fts").all();
    expect(fts?.n).toBe(2);
  });

  test("keeps the FTS triggers live for later writes", () => {
    migrateMessageUniqueKey(db);

    db.exec(
      `INSERT INTO messages (platform, platform_message_id, chat_id, timestamp, content_type, content_text, source, seq)
       VALUES ('telegram', '30000', 1, 1700000002000, 'text', 'freshly indexed needle', 'live', 78)`
    );

    expect(searchFTS(db, "needle").length).toBe(3);
  });

  test("keeps the unique seq index", () => {
    migrateMessageUniqueKey(db);

    expect(() =>
      db.exec(
        `INSERT INTO messages (platform, platform_message_id, chat_id, timestamp, content_type, content_text, source, seq)
         VALUES ('telegram', '30001', 1, 1700000003000, 'text', 'dup seq', 'live', 77)`
      )
    ).toThrow();
  });

  test("accepts the same platform_message_id in a different chat", () => {
    migrateMessageUniqueKey(db);

    db.exec(
      `INSERT INTO messages (platform, platform_message_id, chat_id, timestamp, content_type, content_text, source, seq)
       VALUES ('telegram', '20445', 1, 1700000004000, 'text', 'same id, other chat', 'live', 79)`
    );

    const rows = db
      .query<{ chat_id: number }, [string]>(
        "SELECT chat_id FROM messages WHERE platform_message_id = ? ORDER BY chat_id"
      )
      .all("20445");

    expect(rows.map((r) => r.chat_id)).toEqual([1, 2]);
  });

  test("still rejects the same platform_message_id within one chat", () => {
    migrateMessageUniqueKey(db);

    expect(() =>
      db.exec(
        `INSERT INTO messages (platform, platform_message_id, chat_id, timestamp, content_type, content_text, source, seq)
         VALUES ('telegram', '20445', 2, 1700000005000, 'text', 'same id, same chat', 'live', 80)`
      )
    ).toThrow();
  });

  test("is a no-op on an already migrated database", () => {
    migrateMessageUniqueKey(db);
    const before = db
      .query<{ id: number; seq: number }, []>("SELECT id, seq FROM messages ORDER BY id")
      .all();

    // A rebuild would have to CREATE TABLE messages_new; squatting on that name turns a second
    // rebuild into a hard error, so "no-op" is falsifiable instead of merely indistinguishable
    // from a rebuild that happens to produce the same rows.
    db.exec("CREATE TABLE messages_new (tripwire INTEGER)");

    migrateMessageUniqueKey(db);
    db.exec("DROP TABLE messages_new");

    const after = db
      .query<{ id: number; seq: number }, []>("SELECT id, seq FROM messages ORDER BY id")
      .all();
    expect(after).toEqual(before);

    const [fts] = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages_fts").all();
    expect(fts?.n).toBe(2);
  });

  // The daemon runs initSchema on every start, so the second pass has to be inert — this is
  // the path that actually executes in production, not migrateMessageUniqueKey on its own.
  test("initSchema can be run repeatedly without rebuilding again", () => {
    initSchema(db);
    const first = db
      .query<{ id: number; seq: number; platform_message_id: string; chat_id: number }, []>(
        "SELECT id, seq, platform_message_id, chat_id FROM messages ORDER BY id"
      )
      .all();

    initSchema(db);
    initSchema(db);

    const after = db
      .query<{ id: number; seq: number; platform_message_id: string; chat_id: number }, []>(
        "SELECT id, seq, platform_message_id, chat_id FROM messages ORDER BY id"
      )
      .all();

    expect(after).toEqual(first);
    expect(searchFTS(db, "needle").map((r) => r.id).sort()).toEqual([10, 11]);

    const [fts] = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages_fts").all();
    expect(fts?.n).toBe(2);

    const [attachments] = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM attachments").all();
    expect(attachments?.n).toBe(1);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
