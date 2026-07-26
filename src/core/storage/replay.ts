import { Database } from "bun:sqlite";
import type { JsonlEvent, JsonlWriter } from "./jsonl";
import { syncEventToSQLite } from "./sqlite";

/**
 * Rebuild the derived SQLite view by projecting the JSONL log in order.
 *
 * This is why change events are applied inside `syncEventToSQLite` rather than one layer up
 * in ingest: a rebuild replays the log through the projection alone, so any apply logic
 * living above it would silently produce a rebuild that disagrees with the live database.
 * The caller supplies the events, so a large log can be streamed in batches.
 */
export function replayJsonl(db: Database, events: JsonlEvent[]): void {
  for (const event of events) syncEventToSQLite(db, event);
}

const SOURCE = "events.jsonl";

/** 4.5 MB ≈ 3,000 lines at the measured 1,506-byte average: ~31 batches over the current log. */
const DEFAULT_BATCH_BYTES = 4_500_000;

export interface ReplayResult {
  events: number;
  batches: number;
  finalOffset: number;
}

/**
 * Project the log forward from the checkpoint recorded in `sync_state`.
 *
 * No row means never synced, so a fresh or rebuilt database replays from zero — that is the
 * case `readTailLines(100)` used to lose silently, since only the last hundred lines of the
 * log ever made it back into a rebuilt projection.
 *
 * Each batch commits its events and its new offset in one transaction, so a crash resumes on a
 * batch boundary rather than replaying from the start.
 */
export function replayFrom(
  db: Database,
  jsonl: JsonlWriter,
  opts?: { batchBytes?: number }
): ReplayResult {
  const batchBytes = opts?.batchBytes ?? DEFAULT_BATCH_BYTES;
  const stored = db
    .query<{ byte_offset: number }, [string]>("SELECT byte_offset FROM sync_state WHERE source = ?")
    .get(SOURCE);

  let offset = stored?.byte_offset ?? 0;
  const size = jsonl.byteSize();
  if (size < offset) {
    console.error(`[replay] ${SOURCE} shrank (${size} < ${offset}) — replaying from the start`);
    offset = 0;
  }

  const writeOffset = db.query(
    `INSERT INTO sync_state (source, byte_offset, updated_at)
     VALUES (?, ?, unixepoch('now', 'subsec') * 1000)
     ON CONFLICT(source) DO UPDATE SET byte_offset = excluded.byte_offset, updated_at = excluded.updated_at`
  );

  let events = 0;
  let batches = 0;

  for (;;) {
    const chunk = jsonl.readFrom(offset, batchBytes);
    // A chunk that cannot advance the offset would spin here forever: a torn trailing line or
    // an offset past EOF both look like "no events" but mean different things.
    if (chunk.nextOffset === offset) break;

    db.transaction(() => {
      for (const event of chunk.events) syncEventToSQLite(db, event);
      writeOffset.run(SOURCE, chunk.nextOffset);
    })();

    events += chunk.events.length;
    batches += 1;
    offset = chunk.nextOffset;
  }

  return { events, batches, finalOffset: offset };
}
