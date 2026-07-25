import { Database } from "bun:sqlite";
import type { JsonlEvent } from "./jsonl";
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
