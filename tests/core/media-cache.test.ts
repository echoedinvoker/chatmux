import { describe, it, expect } from "bun:test";
import { MediaCache, mediaCachePath } from "../../src/core/media-cache.js";

describe("mediaCachePath", () => {
  it("keys stickers by sticker id so one sticker is stored once", () => {
    expect(mediaCachePath("/c", { platform: "line", contentType: "sticker", stickerId: "7432559", messageId: "1" }, "image/png"))
      .toBe("/c/line/sticker/7432559.png");
  });
  it("keys images by message id", () => {
    expect(mediaCachePath("/c", { platform: "line", contentType: "image", messageId: "623174375235650150" }, "image/jpeg"))
      .toBe("/c/line/msg/623174375235650150.jpg");
  });
  it("falls back to .bin for a mime it does not know", () => {
    expect(mediaCachePath("/c", { platform: "line", contentType: "image", messageId: "9" }, "application/octet-stream"))
      .toBe("/c/line/msg/9.bin");
  });
});

describe("MediaCache: adapter without get_media", () => {
  it("asks once, then answers from the negative cache", async () => {
    const calls: string[] = [];
    const cache = new MediaCache({
      root: `/tmp/f35-test-${Date.now()}`,
      maxBytes: 1024 * 1024,
      callAdapter: async (platform, method) => {
        calls.push(`${platform}:${method}`);
        const err: any = new Error("Method not found: get_media");
        err.code = -32601;
        throw err;
      },
      fetchPublicUrl: async () => { throw new Error("must not be called"); },
    });

    const key = { platform: "line", messageId: "1", chatId: "c1", raw: {}, contentType: "image" as const };
    const first = await cache.fetchMedia(key);
    const second = await cache.fetchMedia(key);

    expect(first).toEqual({ unavailable: "unsupported_type" });
    expect(second).toEqual({ unavailable: "unsupported_type" });
    expect(calls).toEqual(["line:get_media"]);
  });

  it("remembers a deleted object forever and a network error for 24h", async () => {
    let now = 1_000_000;
    const calls: string[] = [];
    const cache = new MediaCache({
      // Unique root per run: negative entries are persisted, so a fixed directory would
      // let the previous run's negative.json answer this run's first call.
      root: `/tmp/f35-neg-${Math.random().toString(36).slice(2)}`, maxBytes: 1e6, now: () => now,
      callAdapter: async (_p, _m, params: any) => {
        calls.push(params.platform_message_id);
        if (params.platform_message_id === "gone1") return { unavailable: "gone" };
        throw new Error("socket hang up");
      },
      fetchPublicUrl: async () => { throw new Error("must not be called"); },
    });
    const g = { platform: "line", messageId: "gone1", chatId: "c", raw: {}, contentType: "image" as const };
    expect(await cache.fetchMedia(g)).toEqual({ unavailable: "gone" });
    expect(await cache.fetchMedia(g)).toEqual({ unavailable: "gone" });
    expect(calls.filter((c) => c === "gone1").length).toBe(1);

    const n = { platform: "line", messageId: "net1", chatId: "c", raw: {}, contentType: "image" as const };
    await cache.fetchMedia(n);
    now += 23 * 3600 * 1000;
    await cache.fetchMedia(n);
    expect(calls.filter((c) => c === "net1").length).toBe(1);
    now += 2 * 3600 * 1000;
    await cache.fetchMedia(n);
    expect(calls.filter((c) => c === "net1").length).toBe(2);
  });
});

describe("MediaCache: public urls", () => {
  it("fetches a public url itself and never bothers the adapter", async () => {
    const root = `/tmp/f35-pub-${Math.random().toString(36).slice(2)}`;
    let adapterCalls = 0;
    const cache = new MediaCache({
      root, maxBytes: 1e6,
      callAdapter: async () => { adapterCalls++; return { unavailable: "gone" }; },
      fetchPublicUrl: async () => ({ bytes: new Uint8Array([137, 80, 78, 71]), mime: "image/png" }),
    });
    const res: any = await cache.fetchMedia({
      platform: "line", contentType: "sticker", stickerId: "7432559", messageId: "1", chatId: "c", raw: {},
      publicUrl: "https://stickershop.line-scdn.net/stickershop/v1/sticker/7432559/android/sticker.png",
    });
    expect(res.path).toBe(`${root}/line/sticker/7432559.png`);
    expect(res.mime).toBe("image/png");
    expect(adapterCalls).toBe(0);
    expect(await cache.has("line/sticker/7432559.png")).toBe(true);
  });
});

describe("MediaCache: adapter bytes land on disk", () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

  it("writes what the adapter returned, then answers the second call from disk", async () => {
    const root = `/tmp/f35-bytes-${Math.random().toString(36).slice(2)}`;
    let adapterCalls = 0;
    const cache = new MediaCache({
      root, maxBytes: 1e6,
      callAdapter: async () => {
        adapterCalls++;
        return { bytes_base64: Buffer.from(JPEG).toString("base64"), mime: "image/jpeg" };
      },
      fetchPublicUrl: async () => { throw new Error("must not be called"); },
    });
    const key = {
      platform: "line", contentType: "image" as const,
      messageId: "623174375235650150", chatId: "c", raw: {},
    };

    const first: any = await cache.fetchMedia(key);
    expect(first.path).toBe(`${root}/line/msg/623174375235650150.jpg`);
    expect(first.mime).toBe("image/jpeg");
    expect(new Uint8Array(await Bun.file(first.path).arrayBuffer())).toEqual(JPEG);

    const second: any = await cache.fetchMedia(key);
    expect(second.path).toBe(first.path);
    expect(adapterCalls).toBe(1);
  });

  it("downloads a sticker once no matter how many messages sent it", async () => {
    const root = `/tmp/f35-dedupe-${Math.random().toString(36).slice(2)}`;
    let fetches = 0;
    const cache = new MediaCache({
      root, maxBytes: 1e6,
      callAdapter: async () => { throw new Error("must not be called"); },
      fetchPublicUrl: async () => {
        fetches++;
        return { bytes: new Uint8Array([137, 80, 78, 71]), mime: "image/png" };
      },
    });
    const sticker = (messageId: string) => ({
      platform: "line", contentType: "sticker" as const, stickerId: "7432559",
      messageId, chatId: "c", raw: {},
      publicUrl: "https://stickershop.line-scdn.net/stickershop/v1/sticker/7432559/android/sticker.png",
    });

    const a: any = await cache.fetchMedia(sticker("m1"));
    const b: any = await cache.fetchMedia(sticker("m2"));

    expect(b.path).toBe(a.path);
    expect(fetches).toBe(1);
  });
});

describe("MediaCache: disk budget", () => {
  it("prunes the least recently used file when over budget", async () => {
    const root = `/tmp/f35-lru-${Math.random().toString(36).slice(2)}`;
    const cache = new MediaCache({
      root, maxBytes: 2000,
      callAdapter: async () => ({ unavailable: "gone" }),
      fetchPublicUrl: async () => { throw new Error("no"); },
    });
    await cache.writeForTest("line/msg/a.jpg", new Uint8Array(1000), 1);
    await cache.writeForTest("line/msg/b.jpg", new Uint8Array(1000), 3);
    await cache.writeForTest("line/msg/c.jpg", new Uint8Array(1000), 2);
    const stats = await cache.prune();
    expect(stats.deleted).toBe(1);
    expect(await cache.has("line/msg/a.jpg")).toBe(false);
    expect(await cache.has("line/msg/b.jpg")).toBe(true);
    expect(await cache.has("line/msg/c.jpg")).toBe(true);
  });

  it("still knows a deleted object is gone after a daemon restart", async () => {
    const root = `/tmp/f35-negfile-${Math.random().toString(36).slice(2)}`;
    const calls: string[] = [];
    const make = () => new MediaCache({
      root, maxBytes: 1e6,
      callAdapter: async (_p, _m, params: any) => {
        calls.push(params.platform_message_id);
        return { unavailable: "gone" };
      },
      fetchPublicUrl: async () => { throw new Error("must not be called"); },
    });
    const key = { platform: "line", messageId: "gone1", chatId: "c", raw: {}, contentType: "image" as const };

    expect(await make().fetchMedia(key)).toEqual({ unavailable: "gone" });
    // A fresh instance over the same root is what a daemon restart looks like.
    expect(await make().fetchMedia(key)).toEqual({ unavailable: "gone" });
    expect(calls).toEqual(["gone1"]);
  });
});
