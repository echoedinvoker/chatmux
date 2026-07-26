// F16 positive verification: manufacture the collision the old schema could not survive.
//
// This deliberately BYPASSES the daemon and landEvent, calling syncEventToSQLite directly —
// which writes no JSONL. Doing that to the production database would mint rows that exist in
// SQLite but not in the truth source, permanently breaking the invariant this whole fix rests
// on. So it opens a THROWAWAY COPY, passed as an explicit path.
//
// `CHATMUX_DATA_DIR` does NOT sandbox this: only daemon.ts reads it. initSchema /
// syncEventToSQLite / initFTS take an already-opened Database and read no env var at all.
// The isolation comes from the path below, nothing else.
//
//   bun run scripts/f16-collision-probe.ts <path-to-throwaway-copy>

import { Database } from "bun:sqlite";
import { initSchema, syncEventToSQLite } from "../src/core/storage/sqlite";
import { initFTS, searchFTS } from "../src/core/storage/fts";
import { getMessages } from "../src/core/storage/query";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("usage: bun run scripts/f16-collision-probe.ts <path-to-throwaway-copy>");
  process.exit(1);
}
if (dbPath.includes(".local/share/chatmux/chatmux.db")) {
  console.error("refusing to run against the production database — pass a copy");
  process.exit(1);
}

const TEST_CHAT = "7869659098"; // Saved Messages (Phase 3.1)
const db = new Database(dbPath);
initSchema(db);
initFTS(db);

// Borrow an id that already belongs to a different chat: that is exactly the collision the
// per-platform unique key used to lose.
const victim = db
  .query<{ id: number; chat_id: number; platform_message_id: string; content_text: string | null; seq: number }, [string]>(
    `SELECT m.id, m.chat_id, m.platform_message_id, m.content_text, m.seq
     FROM messages m JOIN chats c ON c.id = m.chat_id
     WHERE m.platform = 'telegram' AND c.platform_id != ? AND m.content_text IS NOT NULL
     ORDER BY m.id DESC LIMIT 1`
  )
  .get(TEST_CHAT)!;

const COLLIDING_ID = victim.platform_message_id;
console.log("victim row (other chat):", JSON.stringify(victim));
console.log("colliding platform_message_id:", COLLIDING_ID);

// --- 3.4: the same id in the test chat must land as its own row -------------------------
syncEventToSQLite(db, {
  type: "message",
  platform: "telegram",
  platform_message_id: COLLIDING_ID,
  chat: { platform_id: TEST_CHAT, type: "direct", name: "Matt Chang" },
  sender: { platform_id: "7869659098", display_name: "Matt Chang" },
  timestamp: Date.now(),
  content: { type: "text", text: "f16-collision-probe needle" },
  raw: {},
  source: "live",
} as any);

const both = db
  .query<{ id: number; chat_id: number; content_text: string | null }, [string]>(
    "SELECT id, chat_id, content_text FROM messages WHERE platform = 'telegram' AND platform_message_id = ? ORDER BY id"
  )
  .all(COLLIDING_ID);
console.log("\n[3.4] rows sharing that id:", JSON.stringify(both, null, 2));

const testChatId = db
  .query<{ id: number }, [string]>("SELECT id FROM chats WHERE platform = 'telegram' AND platform_id = ?")
  .get(TEST_CHAT)!.id;

const inTestChat = getMessages(db, testChatId, { limit: 50 }).filter((m) => m.platform_message_id === COLLIDING_ID);
const inVictimChat = getMessages(db, victim.chat_id, { limit: 200 }).filter((m) => m.platform_message_id === COLLIDING_ID);

console.log("[3.4] read_messages(test chat) rows with that id:", inTestChat.length, JSON.stringify(inTestChat.map((m) => m.content_text)));
console.log("[3.4] read_messages(victim chat) rows with that id:", inVictimChat.length, JSON.stringify(inVictimChat.map((m) => m.content_text)));
console.log("[3.4] FTS finds the new row:", JSON.stringify(searchFTS(db, "\"f16-collision-probe needle\"").map((r) => r.id)));
console.log("[3.4] FTS still finds the victim:", JSON.stringify(searchFTS(db, `"${(victim.content_text ?? "").slice(0, 12).replace(/"/g, "")}"`).map((r) => r.id)));

// --- 3.5: unsend addressed at the TEST chat must not touch the other chat's row ---------
const beforeVictim = db
  .query<{ content_text: string | null; seq: number; retracted_at: number | null }, [number]>(
    "SELECT content_text, seq, retracted_at FROM messages WHERE id = ?"
  )
  .get(victim.id)!;

syncEventToSQLite(db, {
  type: "unsend",
  platform: "telegram",
  platform_message_id: COLLIDING_ID,
  chat: { platform_id: TEST_CHAT, type: "direct", name: "Matt Chang" },
  timestamp: Date.now(),
  raw: {},
  source: "live",
} as any);

const afterTest = db
  .query<{ id: number; content_text: string | null; retracted_at: number | null }, [string, number]>(
    "SELECT id, content_text, retracted_at FROM messages WHERE platform_message_id = ? AND chat_id = ?"
  )
  .get(COLLIDING_ID, testChatId)!;
const afterVictim = db
  .query<{ content_text: string | null; seq: number; retracted_at: number | null }, [number]>(
    "SELECT content_text, seq, retracted_at FROM messages WHERE id = ?"
  )
  .get(victim.id)!;

console.log("\n[3.5] test chat row after unsend:", JSON.stringify(afterTest));
console.log("[3.5] victim row before:", JSON.stringify(beforeVictim));
console.log("[3.5] victim row after :", JSON.stringify(afterVictim));
console.log("[3.5] victim untouched:", JSON.stringify(beforeVictim) === JSON.stringify(afterVictim));

db.close();
