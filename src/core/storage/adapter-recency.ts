import type { Database } from "bun:sqlite";

/**
 * The adapter-reported side of chat recency.
 *
 * These writes never carry a message with them: they say "the adapter can see activity at
 * this time", which is not the same as "a message landed here". Kept out of daemon.ts so
 * they can be tested — daemon.ts opens the real database at module scope.
 */

export type AdapterChat = {
  platform_id: string;
  type: string;
  name: string;
  last_activity_at?: number | null;
  /** @deprecated since protocol v0.7 — renamed to last_activity_at. */
  last_message_at?: number | null;
};

export type AdapterMessageBox = {
  id: string;
  lastDeliveredTime: number;
};

export function upsertChatsFromAdapter(
  db: Database,
  platform: string,
  chats: AdapterChat[],
): void {
  // The recency signal is optional (protocol v0.3). MAX so a null from a v0.2 adapter never
  // clobbers a known value; NULLIF keeps "no signal at all" as NULL rather than epoch 0, so a
  // degraded ordering stays visible instead of masquerading as a real timestamp.
  const upsert = db.prepare(`
    INSERT INTO chats (platform, platform_id, type, name, last_activity_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(platform, platform_id) DO UPDATE SET
      name = COALESCE(excluded.name, chats.name),
      last_activity_at = NULLIF(MAX(
        COALESCE(chats.last_activity_at, 0),
        COALESCE(excluded.last_activity_at, 0)
      ), 0),
      updated_at = (unixepoch('now', 'subsec') * 1000)
  `);

  for (const chat of chats) {
    // Adapters predating v0.7 send the signal under its old name.
    const activity = chat.last_activity_at ?? chat.last_message_at ?? null;
    upsert.run(platform, chat.platform_id, chat.type, chat.name, activity);
  }
}

/**
 * Refines recency for chats that already exist. Returns how many boxes referred to a chat
 * get_chats never reported — get_chats is the sole authority on which chats exist and what
 * type they are, so an unknown box is reported as a gap rather than invented here.
 */
export function applyMessageBoxRecency(
  db: Database,
  platform: string,
  boxes: AdapterMessageBox[],
): number {
  const update = db.prepare(`
    UPDATE chats SET last_activity_at = NULLIF(MAX(
      COALESCE(last_activity_at, 0), COALESCE(?, 0)
    ), 0)
    WHERE platform_id = ? AND platform = ?
  `);

  let unknown = 0;
  for (const box of boxes) {
    const updated = update.run(box.lastDeliveredTime || null, box.id, platform);
    if (updated.changes === 0) unknown++;
  }
  return unknown;
}
