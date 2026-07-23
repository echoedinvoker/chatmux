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

export function syncEventToSQLite(db: Database, event: JsonlEvent): void {
  if (event.type !== "message") return;

  const upsertContact = db.prepare(`
    INSERT INTO contacts (platform, platform_id, display_name)
    VALUES (?, ?, ?)
    ON CONFLICT(platform, platform_id) DO UPDATE SET
      display_name = excluded.display_name,
      updated_at = (unixepoch('now', 'subsec') * 1000)
  `);
  upsertContact.run(event.platform, event.sender.platform_id, event.sender.display_name);

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
    (platform, platform_message_id, chat_id, sender_id, timestamp, content_type, content_text, content_media_url, raw, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
