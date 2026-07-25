import { Database } from "bun:sqlite";
import type { JsonlEvent } from "./jsonl";

export function initSchema(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
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
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('direct', 'group', 'room')),
      name TEXT,
      last_message_at INTEGER,
      raw TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
      UNIQUE(platform, platform_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
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
      UNIQUE(platform, platform_message_id)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp
    ON messages(chat_id, timestamp DESC)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp
    ON messages(timestamp DESC)
  `);

  migrateChangeColumns(db);
  migrateBackfillColumns(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS attachments (
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
}

/**
 * Change-event columns, added in place because the table predates them.
 *
 * `seq` is the event-stream position, deliberately separate from `id`: `id` is the FTS
 * content_rowid and the attachments foreign key, so it must never move, while `seq` has to
 * jump to the tail every time a stored message changes. Existing rows seed to `seq = id`,
 * which keeps cursors issued before this migration pointing at the same place (`id` is
 * AUTOINCREMENT, so MAX(seq) = MAX(id) at seed time).
 *
 * Seeding runs before the unique index purely so the index is built once with final
 * semantics — SQLite permits repeated NULLs either way.
 */
function migrateChangeColumns(db: Database): void {
  const existing = new Set(
    db.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((c) => c.name)
  );

  if (!existing.has("seq")) db.exec("ALTER TABLE messages ADD COLUMN seq INTEGER");
  if (!existing.has("edited_at")) db.exec("ALTER TABLE messages ADD COLUMN edited_at INTEGER");
  if (!existing.has("retracted_at")) db.exec("ALTER TABLE messages ADD COLUMN retracted_at INTEGER");

  db.exec("UPDATE messages SET seq = id WHERE seq IS NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq)");
}

/**
 * Per-chat backfill bookkeeping. NULL means `unknown`: an untouched chat and a chat
 * migrated from an older DB are indistinguishable, which is the honest reading.
 */
function migrateBackfillColumns(db: Database): void {
  const existing = new Set(
    db.query<{ name: string }, []>("PRAGMA table_info(chats)").all().map((c) => c.name)
  );

  if (!existing.has("backfill_state")) db.exec("ALTER TABLE chats ADD COLUMN backfill_state TEXT");
  if (!existing.has("backfill_attempted_at")) db.exec("ALTER TABLE chats ADD COLUMN backfill_attempted_at INTEGER");
  if (!existing.has("backfill_oldest_id")) db.exec("ALTER TABLE chats ADD COLUMN backfill_oldest_id TEXT");
}

const NEXT_SEQ = "(SELECT COALESCE(MAX(seq), 0) + 1 FROM messages)";

interface ChangeTarget {
  id: number;
  content_text: string | null;
  edited_at: number | null;
  retracted_at: number | null;
}

function findTarget(db: Database, event: JsonlEvent): ChangeTarget | null {
  return db
    .query<ChangeTarget, [string, string]>(
      `SELECT id, content_text, edited_at, retracted_at FROM messages
       WHERE platform = ? AND platform_message_id = ?`
    )
    .get(event.platform, event.platform_message_id);
}

/**
 * Neither apply function may read `event.sender` or touch `contacts`: ingest only enforces a
 * sender on `message` events, so a change event's sender is frequently absent entirely.
 */
function applyEdit(db: Database, event: JsonlEvent): void {
  const target = findTarget(db, event);
  if (!target) {
    console.error(`[storage] WARN: edit for unknown message ${event.platform}:${event.platform_message_id} — ignored`);
    return;
  }
  if (target.retracted_at != null) {
    console.error(`[storage] WARN: edit for retracted message ${event.platform}:${event.platform_message_id} — refused`);
    return;
  }

  const text = event.content?.text ?? null;
  // Idempotent short-circuit. syncCheck replays the JSONL tail on every restart; without this
  // each restart would bump seq and hand pull consumers an event carrying no state change.
  if (target.content_text === text && target.edited_at === event.timestamp) return;

  db.prepare(
    `UPDATE messages SET content_text = ?, edited_at = ?, seq = ${NEXT_SEQ} WHERE id = ?`
  ).run(text, event.timestamp, target.id);
}

function applyUnsend(db: Database, event: JsonlEvent): void {
  const target = findTarget(db, event);
  if (!target) {
    console.error(`[storage] WARN: unsend for unknown message ${event.platform}:${event.platform_message_id} — ignored`);
    return;
  }
  if (target.retracted_at != null) return;

  // Telegram's delete event carries timestamp 0, and 0 is falsy in every `if (row.retracted_at)`
  // downstream — it would read as "not retracted".
  const retractedAt = event.timestamp || event.received_at || Date.now();

  db.prepare(
    `UPDATE messages
        SET content_text = NULL, content_media_url = NULL, retracted_at = ?, seq = ${NEXT_SEQ}
      WHERE id = ?`
  ).run(retractedAt, target.id);
}

export function syncEventToSQLite(db: Database, event: JsonlEvent): void {
  if (event.type === "edit") return applyEdit(db, event);
  if (event.type === "unsend") return applyUnsend(db, event);
  if (event.type !== "message") return;

  const upsertContact = db.prepare(`
    INSERT INTO contacts (platform, platform_id, display_name)
    VALUES (?, ?, ?)
    ON CONFLICT(platform, platform_id) DO UPDATE SET
      display_name = CASE
        WHEN LENGTH(excluded.display_name) > 0
          AND NOT (excluded.display_name GLOB '[uc][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*')
        THEN excluded.display_name
        WHEN LENGTH(contacts.display_name) > 0
        THEN contacts.display_name
        ELSE excluded.display_name
      END,
      updated_at = (unixepoch('now', 'subsec') * 1000)
  `);
  upsertContact.run(event.platform, event.sender.platform_id, event.sender.display_name ?? event.sender.platform_id);

  const contactId = db.query<{ id: number }, [string, string]>(
    "SELECT id FROM contacts WHERE platform = ? AND platform_id = ?"
  ).get(event.platform, event.sender.platform_id)!.id;

  const upsertChat = db.prepare(`
    INSERT INTO chats (platform, platform_id, type, name, last_message_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(platform, platform_id) DO UPDATE SET
      name = COALESCE(excluded.name, chats.name),
      last_message_at = MAX(COALESCE(chats.last_message_at, 0), excluded.last_message_at),
      updated_at = (unixepoch('now', 'subsec') * 1000)
  `);
  upsertChat.run(
    event.platform,
    event.chat.platform_id,
    event.chat.type,
    event.chat.name ?? null,
    event.timestamp
  );

  const chatId = db.query<{ id: number }, [string, string]>(
    "SELECT id FROM chats WHERE platform = ? AND platform_id = ?"
  ).get(event.platform, event.chat.platform_id)!.id;

  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages
    (platform, platform_message_id, chat_id, sender_id, timestamp, content_type, content_text, content_media_url, raw, source, seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NEXT_SEQ})
  `);
  insertMessage.run(
    event.platform,
    event.platform_message_id,
    chatId,
    contactId,
    event.timestamp,
    event.content.type,
    event.content.text ?? null,
    event.content.media_url ?? null,
    JSON.stringify(event.raw),
    event.source
  );
}
