import { Database } from "bun:sqlite";
import type { JsonlEvent } from "./jsonl";
import { initFTS } from "./fts";

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

  // No row means "never synced": a fresh database and one rebuilt from scratch are the same
  // case, and both must replay the log from offset 0.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      source TEXT PRIMARY KEY,
      byte_offset INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
    )
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

  // Last: it copies `seq` (added by migrateChangeColumns) and its foreign_key_check covers
  // attachments -> messages, so both must already exist.
  migrateMessageUniqueKey(db);
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

/**
 * Message identity is per chat, not per platform.
 *
 * Telegram hands out message ids that restart from a small number in every dialog, so
 * `UNIQUE(platform, platform_message_id)` made two chats fight over the same id: the second
 * arrival was swallowed by `INSERT OR IGNORE` after `upsertChat` had already moved
 * `last_message_at` forward. SQLite cannot drop a table-level constraint, hence the rebuild.
 *
 * `id` is copied verbatim: it is the FTS content_rowid and the attachments foreign key.
 * `seq` is copied verbatim too — it is the cursor pull consumers have already been handed.
 */
export function migrateMessageUniqueKey(db: Database): void {
  if (hasPerChatUniqueKey(db)) return;

  // PRAGMA foreign_keys is a silent no-op inside a transaction, so both ends live outside it.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec("DROP TRIGGER IF EXISTS messages_fts_insert");
      db.exec("DROP TRIGGER IF EXISTS messages_fts_delete");
      db.exec("DROP TRIGGER IF EXISTS messages_fts_update");

      db.exec(`
        CREATE TABLE messages_new (
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
          UNIQUE(platform, chat_id, platform_message_id)
        )
      `);

      db.exec(`
        INSERT INTO messages_new (
          id, platform, platform_message_id, chat_id, sender_id, timestamp,
          content_type, content_text, content_media_url, raw, source, created_at,
          seq, edited_at, retracted_at
        )
        SELECT
          id, platform, platform_message_id, chat_id, sender_id, timestamp,
          content_type, content_text, content_media_url, raw, source, created_at,
          seq, edited_at, retracted_at
        FROM messages
      `);

      db.exec("DROP TABLE messages");
      db.exec("ALTER TABLE messages_new RENAME TO messages");

      db.exec("CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp ON messages(chat_id, timestamp DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq)");

      initFTS(db);
      db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");

      const violations = db.query("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new Error(`migrateMessageUniqueKey: foreign_key_check reported ${violations.length} violation(s)`);
      }
    })();
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * Read the constraint from the index catalogue rather than matching `sqlite_master.sql` as
 * text: whitespace and casing differ between the original DDL and what a rebuild writes back.
 */
function hasPerChatUniqueKey(db: Database): boolean {
  const indexes = db
    .query<{ name: string; unique: number; origin: string }, []>("PRAGMA index_list(messages)")
    .all();

  return indexes.some((index) => {
    if (index.unique !== 1 || index.origin !== "u") return false;

    const columns = db
      .query<{ name: string }, []>(`PRAGMA index_info(${JSON.stringify(index.name)})`)
      .all()
      .map((c) => c.name);

    return (
      columns.length === 3 &&
      columns.includes("platform") &&
      columns.includes("chat_id") &&
      columns.includes("platform_message_id")
    );
  });
}

const NEXT_SEQ = "(SELECT COALESCE(MAX(seq), 0) + 1 FROM messages)";

interface ChangeTarget {
  id: number;
  content_text: string | null;
  edited_at: number | null;
  retracted_at: number | null;
}

/**
 * Scoped to the chat the event names. Platform message ids are only unique within a chat on
 * Telegram, so an unscoped lookup can tombstone an unrelated chat's message. When the chat is
 * unknown we refuse rather than fall back to a global lookup: not acting is honest, acting on
 * a guessed chat is silent data loss.
 */
function findTarget(db: Database, event: JsonlEvent): ChangeTarget | null {
  const chatPlatformId = event.chat?.platform_id;
  if (!chatPlatformId) {
    console.error(
      `[storage] WARN: ${event.type} for ${event.platform}:${event.platform_message_id} carries no chat.platform_id — not applied`
    );
    return null;
  }

  return db
    .query<ChangeTarget, [string, string, string]>(
      `SELECT m.id, m.content_text, m.edited_at, m.retracted_at FROM messages m
       JOIN chats c ON c.id = m.chat_id
       WHERE m.platform = ? AND m.platform_message_id = ? AND c.platform_id = ?`
    )
    .get(event.platform, event.platform_message_id, chatPlatformId);
}

/**
 * Neither apply function may read `event.sender` or touch `contacts`: ingest only enforces a
 * sender on `message` events, so a change event's sender is frequently absent entirely.
 */
function applyEdit(db: Database, event: JsonlEvent): void {
  const target = findTarget(db, event);
  if (!target) {
    console.error(`[storage] WARN: edit for unknown message ${event.platform}:${event.platform_message_id} in chat ${event.chat?.platform_id} — ignored`);
    return;
  }
  if (target.retracted_at != null) {
    console.error(`[storage] WARN: edit for retracted message ${event.platform}:${event.platform_message_id} in chat ${event.chat?.platform_id} — refused`);
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
    console.error(`[storage] WARN: unsend for unknown message ${event.platform}:${event.platform_message_id} in chat ${event.chat?.platform_id} — ignored`);
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

  // Contact, chat and message land together or not at all. Landing the chat on its own is what
  // made F16 invisible: `last_message_at` moved forward while the message row was dropped, so
  // the chat list sorted on a message nobody could open. Whatever makes the insert fail in the
  // future, the sort key must not advance without it.
  const swallowed = db.transaction(() => landMessage(db, event))();

  if (swallowed) {
    console.error(
      `[storage] WARN: message ${event.platform}:${event.platform_message_id} not inserted into chat ${event.chat.platform_id} — OR IGNORE swallowed it (constraint violation outside this chat's identity)`
    );
  }
}

/** Returns true when the row was silently dropped by something outside this chat. */
function landMessage(db: Database, event: JsonlEvent): boolean {
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

  const insertMessageStmt = db.prepare(`
    INSERT OR IGNORE INTO messages
    (platform, platform_message_id, chat_id, sender_id, timestamp, content_type, content_text, content_media_url, raw, source, seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NEXT_SEQ})
  `);
  const { changes } = insertMessageStmt.run(
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

  if (changes > 0) return false;

  // `changes === 0` conflates two things: a genuine re-delivery of a message this chat already
  // has (routine — syncCheck replays the JSONL tail on every restart), and a row swallowed by
  // something outside this chat (the F16 bug, historically silent). Only the second is worth a
  // line, so ask whether the chat actually ended up with the message.
  const present = db.query<{ id: number }, [string, string, number]>(
    "SELECT id FROM messages WHERE platform = ? AND platform_message_id = ? AND chat_id = ?"
  ).get(event.platform, event.platform_message_id, chatId);

  return !present;
}
