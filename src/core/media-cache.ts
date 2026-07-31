/**
 * Local media cache.
 *
 * Media reaches core in three different shapes (see docs/adapter-protocol.md §get_media):
 * a public URL core can fetch itself, bytes only the adapter can produce, and content the
 * platform no longer has. This class is the single place that knows which is which, so a
 * consumer only ever sees a local file path.
 *
 * Dependencies are injected rather than imported so tests never touch a real daemon,
 * a real adapter, or the network.
 */

/** Which media a caller wants. Built by the MCP tool from a stored message row. */
export interface MediaKey {
  platform: string;
  messageId: string;
  chatId: string;
  raw: unknown;
  contentType: "image" | "sticker" | "video" | "audio" | "file";
  /** Present for stickers: the cache is keyed on this so one sticker is stored once. */
  stickerId?: string;
  /** Only ever a URL that needs no authentication — core fetches these itself. */
  publicUrl?: string;
}

export type MediaResult =
  | { path: string; mime: string }
  | { unavailable: "gone" | "needs_key" | "unsupported_type" | "no_adapter" };

export interface MediaCacheOptions {
  root: string;
  maxBytes?: number;
  callAdapter: (platform: string, method: string, params: unknown) => Promise<unknown>;
  fetchPublicUrl: (url: string) => Promise<{ bytes: Uint8Array; mime: string }>;
  /** Injectable clock so TTL tests do not wait 24 hours. */
  now?: () => number;
}

import { mkdir, readdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** JSON-RPC "Method not found" — an adapter that does not implement get_media at all. */
const METHOD_NOT_FOUND = -32601;

/** How long a *transient* failure is trusted before core tries the source again. */
const TRANSIENT_TTL_MS = 24 * 60 * 60 * 1000;

interface NegativeEntry {
  reason: "gone" | "needs_key" | "unsupported_type";
  at: number;
  permanent: boolean;
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Recovers the mime type a cached file was stored under, from its extension. */
function mimeForExt(fileName: string): string {
  const ext = fileName.slice(fileName.lastIndexOf(".") + 1);
  for (const [mime, candidate] of Object.entries(MIME_EXT)) {
    if (candidate === ext) return mime;
  }
  return "application/octet-stream";
}

/**
 * One path segment standing for a chat.
 *
 * encodeURIComponent already guarantees no `/`, so a chat id cannot add a directory level.
 * `.` is encoded on top of that so no chat id can ever *be* `.` or `..` — a platform is free
 * to hand us those, and they would otherwise walk out of the cache root.
 *
 * Exported because the one-off migration (scripts/migrate-media-cache-chat-key.ts) has to
 * produce byte-identical segments; a second copy of this rule would silently strand files.
 */
export function safeChatSegment(chatId: string): string {
  return encodeURIComponent(chatId).replace(/\./g, "%2E");
}

/**
 * Where one piece of media lives on disk.
 *
 * Stickers are keyed on the sticker id, not the message id: the same sticker is sent over
 * and over, and keying on the message would store one copy per send. Everything else is
 * keyed on the message *and its chat*: a platform message id is only unique within a chat
 * (see docs/storage-schema.md), so keying on the id alone made two unrelated messages share
 * one file.
 */
export function mediaCachePath(
  root: string,
  key: Pick<MediaKey, "platform" | "contentType" | "messageId" | "stickerId" | "chatId">,
  mime: string,
): string {
  const ext = MIME_EXT[mime] ?? "bin";
  if (key.contentType === "sticker" && key.stickerId) {
    return `${root}/${key.platform}/sticker/${key.stickerId}.${ext}`;
  }
  return `${root}/${key.platform}/msg/${safeChatSegment(key.chatId)}/${key.messageId}.${ext}`;
}

export class MediaCache {
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly callAdapter: MediaCacheOptions["callAdapter"];
  private readonly fetchPublicUrl: MediaCacheOptions["fetchPublicUrl"];
  private readonly now: () => number;

  /**
   * Platforms whose adapter answered -32601. Remembered for the whole platform, not per
   * message: the adapter does not implement the method, so asking about another message
   * cannot produce a different answer.
   */
  private unsupportedPlatforms = new Set<string>();

  /**
   * Failures, so scrolling past media that cannot be fetched does not re-hit the network
   * on every redraw. `permanent` separates the two cases that matter: the platform no
   * longer has the content (asking again can never help) from this attempt failing
   * (asking again tomorrow might).
   */
  private negative = new Map<string, NegativeEntry>();

  /** Set once negative.json has been read, so a restart does not re-hit deleted media. */
  private negativeLoaded = false;

  constructor(opts: MediaCacheOptions) {
    this.root = opts.root;
    this.maxBytes = opts.maxBytes ?? 200 * 1024 * 1024;
    this.callAdapter = opts.callAdapter;
    this.fetchPublicUrl = opts.fetchPublicUrl;
    this.now = opts.now ?? (() => Date.now());
  }

  async fetchMedia(key: MediaKey): Promise<MediaResult> {
    if (this.unsupportedPlatforms.has(key.platform)) {
      return { unavailable: "unsupported_type" };
    }

    await this.loadNegative();
    const negKey = this.negativeKey(key);
    const remembered = this.negative.get(negKey);
    if (remembered && (remembered.permanent || this.now() - remembered.at <= TRANSIENT_TTL_MS)) {
      return { unavailable: remembered.reason };
    }

    // The point of the cache: media already on disk costs nothing. This check has to come
    // before both fetch paths, or every scroll re-downloads what is already here.
    const cached = await this.findCached(key);
    if (cached) return cached;

    // A public URL needs no credentials by definition (docs/adapter-protocol.md §event),
    // so core fetches it directly rather than waking the adapter for every sticker.
    if (key.publicUrl) {
      try {
        const { bytes, mime } = await this.fetchPublicUrl(key.publicUrl);
        return await this.store(key, bytes, mime);
      } catch {
        await this.rememberNegative(negKey, { reason: "gone", at: this.now(), permanent: false });
        return { unavailable: "gone" };
      }
    }

    let answer: unknown;
    try {
      answer = await this.callAdapter(key.platform, "get_media", {
        platform_message_id: key.messageId,
        chat_id: key.chatId,
        raw: key.raw,
      });
    } catch (err: unknown) {
      // Deliberately reading `err.code` rather than using adapter-runner's
      // isMethodNotFound(): callAdapter is injected, so what it throws is not
      // guaranteed to be an AdapterProtocolError.
      if ((err as { code?: number } | null)?.code === METHOD_NOT_FOUND) {
        this.unsupportedPlatforms.add(key.platform);
        return { unavailable: "unsupported_type" };
      }
      // A thrown error means *this attempt* failed, so it expires — unlike an
      // `unavailable` answer, which is the adapter saying asking again cannot help.
      await this.rememberNegative(negKey, { reason: "gone", at: this.now(), permanent: false });
      return { unavailable: "gone" };
    }

    const reply = answer as
      | { unavailable?: NegativeEntry["reason"]; bytes_base64?: string; mime?: string }
      | null;

    if (reply?.unavailable) {
      await this.rememberNegative(negKey, { reason: reply.unavailable, at: this.now(), permanent: true });
      return { unavailable: reply.unavailable };
    }

    if (reply?.bytes_base64) {
      const bytes = new Uint8Array(Buffer.from(reply.bytes_base64, "base64"));
      return await this.store(key, bytes, reply.mime ?? "application/octet-stream");
    }

    // A reply with neither bytes nor a reason breaks the protocol. Treat it as a failed
    // attempt rather than a permanent absence — the adapter may simply be out of date.
    await this.rememberNegative(negKey, { reason: "gone", at: this.now(), permanent: false });
    return { unavailable: "gone" };
  }

  /**
   * Looks for media already on disk.
   *
   * Stickers have a known extension, so it is one stat. Images do not — the extension comes
   * from the mime type the source reported, which is only known after fetching — so the
   * message's own files are listed instead.
   */
  private async findCached(key: MediaKey): Promise<MediaResult | null> {
    if (key.contentType === "sticker" && key.stickerId) {
      const rel = `${key.platform}/sticker/${key.stickerId}.png`;
      return (await this.has(rel)) ? { path: `${this.root}/${rel}`, mime: "image/png" } : null;
    }
    const dir = `${this.root}/${key.platform}/msg/${safeChatSegment(key.chatId)}`;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return null;
    }
    const hit = entries.find((name) => name.slice(0, name.lastIndexOf(".")) === key.messageId);
    return hit ? { path: `${dir}/${hit}`, mime: mimeForExt(hit) } : null;
  }

  /** Lands bytes on disk and keeps the cache inside its budget. */
  private async store(key: MediaKey, bytes: Uint8Array, mime: string): Promise<MediaResult> {
    const path = mediaCachePath(this.root, key, mime);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    await this.prune();
    return { path, mime };
  }

  /**
   * Negative entries are keyed the same way files are, so a sticker is remembered once and a
   * message is remembered per chat. Keeping the two key shapes identical is what stops a
   * "cannot fetch" memory from applying to a different message that happens to share an id.
   */
  private negativeKey(key: MediaKey): string {
    return key.contentType === "sticker" && key.stickerId
      ? `${key.platform}/sticker/${key.stickerId}`
      : `${key.platform}/msg/${safeChatSegment(key.chatId)}/${key.messageId}`;
  }

  private get negativePath(): string {
    return `${this.root}/negative.json`;
  }

  /**
   * Negative entries survive a restart on purpose. Without this, every daemon restart
   * re-fetches media LINE deleted months ago — once per scroll past it.
   */
  private async loadNegative(): Promise<void> {
    if (this.negativeLoaded) return;
    this.negativeLoaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.negativePath, "utf-8")) as Record<string, NegativeEntry>;
      for (const [k, v] of Object.entries(parsed)) this.negative.set(k, v);
    } catch {
      // No file yet, or a file we cannot read. Either way an empty memory is correct:
      // the worst case is re-asking, which is what would happen without the cache at all.
    }
  }

  private async rememberNegative(key: string, entry: NegativeEntry): Promise<void> {
    this.negative.set(key, entry);
    try {
      await mkdir(this.root, { recursive: true });
      await writeFile(this.negativePath, JSON.stringify(Object.fromEntries(this.negative), null, 2));
    } catch {
      // Losing the file costs a re-fetch later; failing the caller's request costs them
      // the media they asked for. The in-memory entry already holds for this session.
    }
  }

  /** True when a cached file exists, addressed relative to the cache root. */
  async has(relPath: string): Promise<boolean> {
    try {
      await stat(`${this.root}/${relPath}`);
      return true;
    } catch {
      return false;
    }
  }

  /** Writes a cache file with an explicit atime, so LRU order is testable without waiting. */
  async writeForTest(relPath: string, bytes: Uint8Array, atimeSeconds: number): Promise<void> {
    const full = `${this.root}/${relPath}`;
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes);
    await utimes(full, atimeSeconds, atimeSeconds);
  }

  /**
   * Drops least-recently-*read* files until the cache fits its budget.
   *
   * atime, not mtime: what matters is when someone last looked at the media, not when it
   * was downloaded. Eviction is safe — every source is still reachable, so an evicted file
   * costs one re-fetch the next time it is viewed.
   */
  async prune(): Promise<{ deleted: number; freed: number }> {
    const files: { path: string; size: number; atime: number }[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(full);
        } else if (full !== this.negativePath) {
          const st = await stat(full);
          files.push({ path: full, size: st.size, atime: st.atimeMs });
        }
      }
    };
    await walk(this.root);

    let total = files.reduce((sum, f) => sum + f.size, 0);
    if (total <= this.maxBytes) return { deleted: 0, freed: 0 };

    files.sort((a, b) => a.atime - b.atime);
    let deleted = 0;
    let freed = 0;
    for (const file of files) {
      if (total <= this.maxBytes) break;
      try {
        await unlink(file.path);
        total -= file.size;
        freed += file.size;
        deleted++;
      } catch {
        // Someone else removed it; it is no longer taking space either way.
      }
    }
    return { deleted, freed };
  }
}
