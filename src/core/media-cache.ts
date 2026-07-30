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

/** JSON-RPC "Method not found" — an adapter that does not implement get_media at all. */
const METHOD_NOT_FOUND = -32601;

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

    try {
      await this.callAdapter(key.platform, "get_media", {
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
      throw err;
    }

    return { unavailable: "gone" };
  }
}
