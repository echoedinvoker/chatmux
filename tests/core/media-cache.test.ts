import { describe, it, expect } from "bun:test";
import { MediaCache } from "../../src/core/media-cache.js";

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
});
