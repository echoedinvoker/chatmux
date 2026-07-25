import { Database } from "bun:sqlite";

export function initFTS(db: Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content_text,
      content='messages',
      content_rowid='id',
      tokenize='trigram'
    )
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages
    BEGIN
      INSERT INTO messages_fts(rowid, content_text) VALUES (new.id, new.content_text);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages
    BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES ('delete', old.id, old.content_text);
    END
  `);

  // External-content FTS5 has no implicit UPDATE path: editing content_text would leave the
  // old terms indexed, so a retracted message would still be findable by the text its author
  // just withdrew. The 'delete' command must carry the exact value that was indexed (the
  // insert trigger stores new.content_text verbatim, NULLs included, so old.content_text is
  // symmetric) — a mismatch corrupts the index silently.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages
    BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES ('delete', old.id, old.content_text);
      INSERT INTO messages_fts(rowid, content_text) VALUES (new.id, new.content_text);
    END
  `);
}

export interface FTSResult {
  id: number;
  content_text: string;
}

export function searchFTS(db: Database, query: string): FTSResult[] {
  if (query.length < 3) {
    return db
      .query<FTSResult, [string]>(
        "SELECT id, content_text FROM messages WHERE content_text LIKE '%' || ? || '%'"
      )
      .all(query);
  }

  return db
    .query<FTSResult, [string]>(
      `SELECT m.id, m.content_text
       FROM messages_fts fts
       JOIN messages m ON m.id = fts.rowid
       WHERE messages_fts MATCH ?`
    )
    .all(query);
}
