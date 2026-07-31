// One-off (F45-C): move cached media from the chat-less layout to the per-chat one.
//
//   before   <root>/<platform>/msg/<pmid>.<ext>
//   after    <root>/<platform>/msg/<safeChat>/<pmid>.<ext>
//
// A platform message id is only unique within a chat, so the old layout let two unrelated
// messages share one file. Which chat an existing file belongs to is not recoverable from the
// file — only the database knows — so this reads the database and moves what it can prove.
//
// Nothing is deleted and nothing is guessed: a file whose id maps to more than one chat, or to
// no chat core still stores, is LEFT WHERE IT IS and reported. Those are the files whose
// contents might already be the wrong message's bytes; a wrong move would make that permanent.
//
//   bun run scripts/migrate-media-cache-chat-key.ts            # dry run (default)
//   bun run scripts/migrate-media-cache-chat-key.ts --apply
//
// Options: --root <cache-root>  --db <path>

import { Database } from "bun:sqlite";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { safeChatSegment } from "../src/core/media-cache";

/** One flat cache file in the old layout. */
export interface OldFile {
  platform: string;
  messageId: string;
  ext: string;
}

export type OrphanReason = "ambiguous" | "unknown";

export interface MigrationPlan {
  moves: { from: string; to: string }[];
  orphans: (OldFile & { reason: OrphanReason })[];
  negativeRenames: { from: string; to: string }[];
  negativeOrphans: { key: string; reason: OrphanReason }[];
}

export interface MigrationInput {
  /** Cache root the paths are built from. Left empty in tests, which compare shapes. */
  root?: string;
  files: OldFile[];
  /** `<platform>:<pmid>` → every chat that has a message with that id. */
  owners: Map<string, string[]>;
  /**
   * Same keys, narrowed to the chats whose row for that id actually carries media.
   *
   * This is the disambiguation core already adopted for get_media: an id colliding with a
   * plain text message in another chat is not really ambiguous — only one of the two rows
   * could have produced these bytes. Keeping the rule identical on both sides is the point.
   */
  mediaOwners?: Map<string, string[]>;
  /** Keys from negative.json, migrated under exactly the same rule as the files. */
  negativeKeys?: string[];
}

/**
 * Decides what moves where. Pure on purpose: every judgement this migration makes lives here,
 * so it can be tested without a cache directory or a database.
 */
export function planMigration(input: MigrationInput): MigrationPlan {
  const root = input.root ?? "";
  const plan: MigrationPlan = { moves: [], orphans: [], negativeRenames: [], negativeOrphans: [] };

  /** The single owner of an id, or why there isn't one. */
  const soleOwner = (platform: string, messageId: string): string | OrphanReason => {
    const id = `${platform}:${messageId}`;
    const chats = input.owners.get(id) ?? [];
    if (chats.length === 1) return chats[0]!;
    if (chats.length === 0) return "unknown";
    // Colliding, but perhaps only one of the rows could have produced media.
    const withMedia = input.mediaOwners?.get(id) ?? [];
    return withMedia.length === 1 ? withMedia[0]! : "ambiguous";
  };

  for (const file of input.files) {
    const owner = soleOwner(file.platform, file.messageId);
    if (owner === "unknown" || owner === "ambiguous") {
      plan.orphans.push({ ...file, reason: owner });
      continue;
    }
    plan.moves.push({
      from: `${root}/${file.platform}/msg/${file.messageId}.${file.ext}`,
      to: `${root}/${file.platform}/msg/${safeChatSegment(owner)}/${file.messageId}.${file.ext}`,
    });
  }

  for (const key of input.negativeKeys ?? []) {
    // Only the old flat message shape is in scope: `<platform>/msg/<pmid>`. Sticker keys are
    // content-addressed (correctly chat-less) and a 4-segment key is already migrated.
    const parts = key.split("/");
    if (parts.length !== 3 || parts[1] !== "msg") continue;
    const [platform, , messageId] = parts as [string, string, string];
    const owner = soleOwner(platform, messageId);
    if (owner === "unknown" || owner === "ambiguous") {
      plan.negativeOrphans.push({ key, reason: owner });
      continue;
    }
    plan.negativeRenames.push({ from: key, to: `${platform}/msg/${safeChatSegment(owner)}/${messageId}` });
  }

  return plan;
}

/** Lists the flat files still in the old layout. Directories are already-migrated chats. */
async function scanOldFiles(root: string): Promise<OldFile[]> {
  const files: OldFile[] = [];
  let platforms: string[];
  try {
    platforms = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return files;
  }
  for (const platform of platforms) {
    let entries;
    try {
      entries = await readdir(`${root}/${platform}/msg`, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf(".");
      if (dot <= 0) continue;
      files.push({ platform, messageId: entry.name.slice(0, dot), ext: entry.name.slice(dot + 1) });
    }
  }
  return files;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string, fallback: string): string => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  const apply = argv.includes("--apply");
  const root = flag("--root", `${homedir()}/.cache/chatmux/media`);
  const dbPath = flag("--db", `${homedir()}/.local/share/chatmux/chatmux.db`);

  const files = await scanOldFiles(root);

  const db = new Database(dbPath, { readonly: true });
  const ownersOf = db.query<{ platform_id: string }, [string, string]>(
    `SELECT DISTINCT c.platform_id
       FROM messages m JOIN chats c ON c.id = m.chat_id
      WHERE m.platform = ? AND m.platform_message_id = ?`,
  );
  const mediaOwnersOf = db.query<{ platform_id: string }, [string, string]>(
    `SELECT DISTINCT c.platform_id
       FROM messages m JOIN chats c ON c.id = m.chat_id
      WHERE m.platform = ? AND m.platform_message_id = ?
        AND m.content_type IN ('image', 'sticker', 'video', 'audio', 'file')`,
  );

  const negativePath = `${root}/negative.json`;
  let negative: Record<string, unknown> = {};
  try {
    negative = JSON.parse(await readFile(negativePath, "utf-8")) as Record<string, unknown>;
  } catch {
    // No negative memory yet — nothing to rewrite.
  }

  // One lookup per distinct id, covering both the files and the negative keys.
  const owners = new Map<string, string[]>();
  const mediaOwners = new Map<string, string[]>();
  const ids = new Set<string>(files.map((f) => `${f.platform}:${f.messageId}`));
  for (const key of Object.keys(negative)) {
    const parts = key.split("/");
    if (parts.length === 3 && parts[1] === "msg") ids.add(`${parts[0]}:${parts[2]}`);
  }
  for (const id of ids) {
    const [platform, ...rest] = id.split(":");
    const pmid = rest.join(":");
    owners.set(id, ownersOf.all(platform!, pmid).map((r) => r.platform_id));
    mediaOwners.set(id, mediaOwnersOf.all(platform!, pmid).map((r) => r.platform_id));
  }
  db.close();

  const plan = planMigration({ root, files, owners, mediaOwners, negativeKeys: Object.keys(negative) });

  console.log(`root            ${root}`);
  console.log(`db              ${dbPath}`);
  console.log(`mode            ${apply ? "APPLY" : "dry-run (pass --apply to move)"}`);
  console.log(`old-layout files ${files.length}`);
  console.log(`  to move        ${plan.moves.length}`);
  console.log(`  left in place  ${plan.orphans.length}`);
  console.log(`negative keys    ${Object.keys(negative).length}`);
  console.log(`  to rewrite     ${plan.negativeRenames.length}`);
  console.log(`  left in place  ${plan.negativeOrphans.length}`);
  for (const o of plan.orphans) {
    console.log(`  orphan file    ${o.platform}/msg/${o.messageId}.${o.ext}  (${o.reason})`);
  }
  for (const o of plan.negativeOrphans) {
    console.log(`  orphan negkey  ${o.key}  (${o.reason})`);
  }

  if (!apply) process.exit(0);

  let moved = 0;
  let collided = 0;
  for (const move of plan.moves) {
    // A destination that already exists is the per-chat cache having answered for this
    // message since the new code shipped. That file was written under the correct key, so it
    // wins; overwriting it with a file of unproven provenance would undo the fix.
    if (await stat(move.to).then(() => true).catch(() => false)) {
      console.log(`  skip (dest exists) ${move.to}`);
      collided++;
      continue;
    }
    await mkdir(dirname(move.to), { recursive: true });
    await rename(move.from, move.to);
    moved++;
  }

  for (const rename_ of plan.negativeRenames) {
    negative[rename_.to] = negative[rename_.from];
    delete negative[rename_.from];
  }
  if (plan.negativeRenames.length > 0) {
    await writeFile(negativePath, JSON.stringify(negative, null, 2));
  }

  console.log(`moved           ${moved}`);
  console.log(`skipped (dest existed) ${collided}`);
  console.log(`negative keys rewritten ${plan.negativeRenames.length}`);
}
