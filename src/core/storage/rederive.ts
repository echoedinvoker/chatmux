import type { Database } from "bun:sqlite";

/**
 * Recomputing a projection column from the `raw` payload already stored beside it.
 *
 * This is repair, not a state change. A row lands with whatever the adapter of the day
 * knew how to read; when the adapter learns to read one more field, every row that came
 * before it is missing that field while still holding the bytes it could be derived from.
 *
 * Two rules follow, and both are load-bearing:
 *
 * - **Only SQLite is touched, never `events.jsonl`.** The log is the truth; the table is a
 *   derivative that can be rebuilt from it. Rewriting the log to match a repaired
 *   projection would invert that relationship.
 * - **`seq` is not bumped.** `seq` is the cursor pull consumers page on, so moving it
 *   would re-deliver hundreds of messages as if their content had changed for the reader.
 *   Nothing changed for the reader; something was fixed for us.
 */

export interface RederiveStats {
  scanned: number;
  updated: number;
  skipped: number;
}

export interface StickerExtract {
  sticker_id: string;
  package_id?: string;
}

/**
 * Fills `content_sticker_id` / `content_sticker_package_id` on sticker rows that have none.
 *
 * `extract` is a parameter rather than a hard-coded reader because `STKID` and `STKPKGID`
 * are LINE's names for these, and core does not know any platform's metadata keys. The
 * caller injects the right reader; rows it returns null for are left untouched.
 */
export function rederiveStickers(
  db: Database,
  extract: (raw: unknown) => StickerExtract | null,
): RederiveStats {
  const rows = db
    .query<{ id: number; raw: string | null }, []>(
      `SELECT id, raw FROM messages
        WHERE content_type = 'sticker' AND content_sticker_id IS NULL`,
    )
    .all();

  const update = db.prepare(
    "UPDATE messages SET content_sticker_id = ?, content_sticker_package_id = ? WHERE id = ?",
  );

  const stats: RederiveStats = { scanned: rows.length, updated: 0, skipped: 0 };

  for (const row of rows) {
    let ids: StickerExtract | null = null;
    try {
      ids = row.raw == null ? null : extract(JSON.parse(row.raw));
    } catch {
      // A row whose `raw` will not parse is a row we cannot say anything about. Skipping is
      // the whole handling: one unreadable payload must not abort the other 218.
      ids = null;
    }

    if (!ids) {
      stats.skipped++;
      continue;
    }

    update.run(ids.sticker_id, ids.package_id ?? null, row.id);
    stats.updated++;
  }

  return stats;
}
