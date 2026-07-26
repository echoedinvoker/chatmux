// One-off: apply the F16 per-chat unique key to a database file, with the daemon stopped.
// Run with `bun run scripts/f16-migrate.ts <path-to-db>` — bun:sqlite, not node.
import { Database } from "bun:sqlite";
import { initSchema } from "../src/core/storage/sqlite";
import { initFTS } from "../src/core/storage/fts";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun run scripts/f16-migrate.ts <path-to-db>");
  process.exit(1);
}

const db = new Database(path);
initSchema(db);
initFTS(db);

const count = (sql: string) => db.query<{ n: number }, []>(sql).get()?.n ?? null;

console.log("messages     ", count("SELECT COUNT(*) AS n FROM messages"));
console.log("max(seq)     ", count("SELECT MAX(seq) AS n FROM messages"));
console.log("attachments  ", count("SELECT COUNT(*) AS n FROM attachments"));
console.log("messages_fts ", count("SELECT COUNT(*) AS n FROM messages_fts"));
console.log("chats        ", count("SELECT COUNT(*) AS n FROM chats"));
console.log("fk violations", db.query("PRAGMA foreign_key_check").all().length);
console.log("integrity    ", JSON.stringify(db.query("PRAGMA integrity_check").all()));
console.log("foreign_keys ", JSON.stringify(db.query("PRAGMA foreign_keys").all()));

db.close();
