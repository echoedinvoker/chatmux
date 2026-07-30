import { describe, it, expect } from "bun:test";
import { stickerStaticUrl, normalizeChunks, routeMedia } from "../../../src/adapters/line/media.js";

const BASE = "https://stickershop.line-scdn.net/stickershop/v1/sticker";

describe("stickerStaticUrl", () => {
  // 實驗實測樣本（STKOPT 依序為 "", 0, 0, NULL, NULL, A, A, AS）——五種變體全部只需要 STKID
  const IDS = ["862163523", "12563932", "165", "16401367", "4422", "52002740", "13132811", "865220995"];
  it("needs only STKID, for every STKOPT variant", () => {
    for (const id of IDS) {
      expect(stickerStaticUrl(id)).toBe(`${BASE}/${id}/android/sticker.png`);
    }
  });
  it("refuses to build a url without a sticker id", () => {
    expect(stickerStaticUrl(null)).toBeNull();
    expect(stickerStaticUrl("")).toBeNull();
  });
});

const buf = (bytes: number[]) => ({ type: "Buffer", data: bytes });

describe("normalizeChunks", () => {
  // DB 實測的七種序列化組合（53 筆 E2EE 中只有 34 筆是清一色 Buffer）
  const CASES: unknown[][] = [
    [buf([1]), buf([2]), buf([3]), buf([4]), buf([5])],
    [buf([1]), buf([2]), buf([3]), buf([4]), "s"],
    [buf([1]), buf([2]), buf([3]), "s", buf([5])],
    [buf([1]), buf([2]), "s", buf([4]), buf([5])],
    [buf([1]), buf([2]), buf([3]), "s", "t"],
    [buf([1]), buf([2]), "s", "t", buf([5])],
    [buf([1]), buf([2]), "s", buf([4]), "t"],
  ];
  it("survives every serialization mix found in the DB", () => {
    for (const chunks of CASES) {
      const out = normalizeChunks(chunks);
      expect(out.length).toBe(chunks.length);
      for (const c of out) expect(Buffer.isBuffer(c) || typeof c === "string").toBe(true);
    }
  });
  it("restores a Buffer-shaped chunk to equal bytes", () => {
    expect(normalizeChunks([buf([104, 105])])[0]).toEqual(Buffer.from([104, 105]));
  });
  it("passes a string chunk through instead of reading .data off it", () => {
    expect(normalizeChunks(["hi"])[0]).toBe("hi");
  });
});

describe("routeMedia", () => {
  it("sends an e2ee image down the decrypt path", () => {
    expect(routeMedia({ id: "m1", contentMetadata: { e2eeVersion: "2", OID: "o", SID: "s" }, chunks: ["a"] }))
      .toEqual({ kind: "e2ee" });
  });
  it("prefers the unauthenticated DOWNLOAD_URL when there is one", () => {
    expect(routeMedia({ id: "m2", contentMetadata: { DOWNLOAD_URL: "https://manager.line-scdn.net/x" } }))
      .toEqual({ kind: "download_url", url: "https://manager.line-scdn.net/x" });
  });
  it("falls back to obs by message id", () => {
    expect(routeMedia({ id: "m3", contentMetadata: {} })).toEqual({ kind: "obs", messageId: "m3" });
  });
  it("classifies an e2ee message with no chunks as gone, not as a failure", () => {
    expect(routeMedia({ id: "m4", contentMetadata: { e2eeVersion: "2" }, chunks: [] })).toEqual({ kind: "gone" });
  });
});
