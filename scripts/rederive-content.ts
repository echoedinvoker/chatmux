/**
 * CLI entry point for repairing projection columns from stored `raw` payloads.
 *
 * Run with the daemon stopped — it writes to the same database:
 *
 *   systemctl --user stop chatmux
 *   bun run scripts/rederive-content.ts
 *   systemctl --user start chatmux
 *
 * Idempotent: a second run finds nothing left to fill and reports `updated=0`.
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { initSchema } from "../src/core/storage/sqlite";
import { rederiveStickers, rederiveText, rederiveMediaUrl } from "../src/core/storage/rederive";
import { deriveProjection, extractSticker } from "../src/adapters/line/content-text";
import { stickerStaticUrl } from "../src/adapters/line/media";

const dbPath =
  process.argv[2] ?? join(homedir(), ".local/share/chatmux/chatmux.db");

const db = new Database(dbPath);

// Migrations run at daemon startup, and this script runs with the daemon stopped — so a
// column added in the same change as its backfill does not exist yet when we get here.
// `initSchema` is idempotent; calling it makes the script responsible for the schema it
// writes into rather than dependent on somebody having booted the daemon first.
initSchema(db);

// The LINE reader is injected here rather than inside core: `STKID` / `STKPKGID` are
// LINE's names for these fields, and core does not know any platform's metadata keys.
// Rows it cannot read — Telegram's stickers, whose raw carries no sticker ID at all —
// come back as `skipped`, which is the correct outcome, not a failure.
const stickers = rederiveStickers(db, extractSticker);
const texts = rederiveText(db, deriveProjection);
// F35: only stickers get a `media_url` — under protocol v0.8 the column means an
// unauthenticated, directly-linkable URL, and LINE's images have none. Telegram's sticker
// rows carry no STKID, so they come back as `skipped` rather than a bad URL.
const mediaUrls = rederiveMediaUrl(db, (raw: any) => stickerStaticUrl(raw?.contentMetadata?.STKID));

console.log(`db: ${dbPath}`);
console.log(
  `stickers: scanned=${stickers.scanned} updated=${stickers.updated} skipped=${stickers.skipped}`,
);
console.log(
  `texts: scanned=${texts.scanned} updated=${texts.updated} skipped=${texts.skipped}`,
);
console.log(
  `media_urls: scanned=${mediaUrls.scanned} updated=${mediaUrls.updated} skipped=${mediaUrls.skipped}`,
);

db.close();
