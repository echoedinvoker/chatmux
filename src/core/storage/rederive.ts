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

export interface TextProjection {
  /** `null` means the row holds no text at all — a retraction, not an empty string. */
  text: string | null;
  /**
   * Set when the payload says the message was retracted before it ever reached us. The
   * repair then has to change state, not wording, which is why this is a field and not a
   * magic string the caller would have to recognise on the way back.
   */
  retracted_at?: number;
}

/**
 * Repairs `content_text` on rows that landed as a bracketed placeholder.
 *
 * The candidate set is platform-neutral on purpose: `[RICH]`, `[CHATEVENT]` and the rest
 * are one adapter's names, and putting them (or a `platform = 'line'` filter) in this
 * WHERE would drag back exactly the coupling that passing `derive` as a parameter exists
 * to avoid. Two guards make the wider scan safe, and both matter:
 *
 * - `derive` returns null for payloads it does not recognise, so another platform's
 *   placeholders are left alone rather than rewritten by the wrong reader.
 * - a projection equal to what is already stored is not an update. Deliberate labels
 *   (`[Flex]`, `[圖片]`) map back to themselves and drop out for free, and idempotency
 *   falls out of the same rule instead of needing its own bookkeeping.
 */
export function rederiveText(
  db: Database,
  derive: (raw: unknown) => TextProjection | null,
): RederiveStats {
  const rows = db
    .query<{ id: number; raw: string | null; content_text: string | null }, []>(
      "SELECT id, raw, content_text FROM messages WHERE content_text LIKE '[%]'",
    )
    .all();

  const update = db.prepare("UPDATE messages SET content_text = ? WHERE id = ?");
  // Same columns `applyUnsend` clears, so a retraction found in a backfilled payload is
  // indistinguishable from one that arrived as a live event.
  const retract = db.prepare(
    "UPDATE messages SET content_text = NULL, content_media_url = NULL, retracted_at = ? WHERE id = ?",
  );

  const stats: RederiveStats = { scanned: rows.length, updated: 0, skipped: 0 };

  for (const row of rows) {
    let projection: TextProjection | null = null;
    try {
      projection = row.raw == null ? null : derive(JSON.parse(row.raw));
    } catch {
      projection = null;
    }

    if (!projection || (projection.retracted_at == null && projection.text === row.content_text)) {
      stats.skipped++;
      continue;
    }

    if (projection.retracted_at != null) {
      retract.run(projection.retracted_at, row.id);
    } else {
      update.run(projection.text, row.id);
    }
    stats.updated++;
  }

  return stats;
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

/**
 * Fills `content_media_url` on sticker rows that have none.
 *
 * Same shape and same reason as `rederiveStickers`: `derive` is injected because the URL
 * is built from LINE's `STKID`, and core does not know any platform's metadata keys.
 *
 * The candidate set is narrowed to stickers on purpose. Under adapter protocol v0.8
 * `media_url` means "an unauthenticated, directly-linkable public URL", and on LINE only
 * stickers qualify — images live behind obs headers or local E2EE keys and are fetched
 * through `get_media` instead. Widening this WHERE to all media rows would invite a
 * caller to backfill a URL that no consumer can actually open.
 */
export function rederiveMediaUrl(
  db: Database,
  derive: (raw: unknown) => string | null,
): RederiveStats {
  const rows = db
    .query<{ id: number; raw: string | null }, []>(
      `SELECT id, raw FROM messages
        WHERE content_type = 'sticker' AND content_media_url IS NULL`,
    )
    .all();

  const update = db.prepare("UPDATE messages SET content_media_url = ? WHERE id = ?");

  const stats: RederiveStats = { scanned: rows.length, updated: 0, skipped: 0 };

  for (const row of rows) {
    let url: string | null = null;
    try {
      url = row.raw == null ? null : derive(JSON.parse(row.raw));
    } catch {
      // One unreadable payload must not abort the other 228.
      url = null;
    }

    if (!url) {
      stats.skipped++;
      continue;
    }

    update.run(url, row.id);
    stats.updated++;
  }

  return stats;
}
