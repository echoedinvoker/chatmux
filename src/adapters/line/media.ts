/**
 * LINE 媒體來源：貼圖 URL 組法、chunks 正規化、來源分派、get_media handler。
 *
 * 協定位置：adapter protocol v0.8 的 optional method `get_media`。
 * consumer 永遠只看 core 回傳的本機路徑，憑證與金鑰不離開這個 adapter。
 */

/**
 * 貼圖的靜態 PNG URL。免認證：只需要 STKID，STKPKGID／STKVER／STKOPT 都不參與。
 *
 * ⚠️ 刻意**不** import 也不照抄 linejs 的 `getStickerURL()`
 * （`client/features/message/talk.ts:162`）。它用 `STKOPT === "A"` 判動畫，
 * 但實測 `STKOPT === "AS"` 也有 409KB 的 APNG ⇒ 那個二分法會靜默丟掉 AS 的動畫。
 * 正確判準是 `STKOPT ∈ {A, AS}`。
 *
 * 本輪一律走靜態 `sticker.png`（220/220 實驗驗證可下載），完全不做動畫分支
 * ⇒ 沒有可以錯的二分法。動畫貼圖另立摩擦條目，不在本輪範圍。
 */
export function stickerStaticUrl(stkid: string | null | undefined): string | null {
  if (!stkid) return null;
  return `https://stickershop.line-scdn.net/stickershop/v1/sticker/${stkid}/android/sticker.png`;
}

/**
 * 把 DB 裡 `raw.chunks` 的混合序列化還原成 linejs 吃得下的形狀。
 *
 * JSON round-trip 之後 chunks 不是清一色的東西：實測 53 筆 E2EE 訊息中只有 34 筆
 * 全是 `{type:"Buffer",data:[…]}`，另 19 筆混雜純 string。
 *
 * ⚠️ string 要**原樣傳回**，不要自己 `Buffer.from(chunk, "utf-8")`——linejs
 * 內部就是這樣處理的（`base/e2ee/mod.ts:758,838,902`），在這裡先轉一次沒有好處，
 * 但更重要的是不能對 string 讀 `.data`。
 *
 * 實驗第一版一律 `Buffer.from(c.data)`，對 19 筆 string chunk 炸成
 * `The first argument must be of type string, Buffer... Received undefined`，
 * 看起來像「E2EE 拿不到」而不是「自己的還原邏輯錯」，差點把 F35 縮成半條。
 * ⇒ **spike／測試報失敗時，先懷疑自己的程式碼，再懷疑外部限制。**
 */
export function normalizeChunks(chunks: unknown[]): (Buffer | string)[] {
  return chunks.map((chunk) =>
    typeof chunk === "string" ? chunk : Buffer.from((chunk as { data: number[] }).data),
  );
}

/** 一筆媒體該走哪條取得路徑。純判斷，不打網路。 */
export type MediaRoute =
  | { kind: "e2ee" }
  | { kind: "download_url"; url: string }
  | { kind: "obs"; messageId: string }
  | { kind: "gone" };

interface RawMediaMessage {
  id?: string;
  contentMetadata?: Record<string, string> | null;
  chunks?: unknown[] | null;
}

/**
 * 依 raw payload 決定取得路徑。刻意做成純函式，把「走哪條路」與「怎麼打網路」分開
 * ——分派錯了會表現成「拿不到」，跟網路失敗長得一樣，分開才驗得動。
 *
 * 順序有意義：
 *  1. `e2eeVersion` 存在 ⇒ 必須本機解密。此時 `chunks` 空 ⇒ 先分類成 `gone`，
 *     否則 linejs 的 `downloadMediaByE2EE` 會回 `null`（`base/obs/mod.ts:422`），
 *     那個 null 會被讀成網路失敗而不是「LINE 端已刪」。
 *  2. `DOWNLOAD_URL`（bot／官方帳號訊息）⇒ 免認證直接 GET。
 *  3. 其餘 ⇒ obs，帶 adapter 的 authToken。
 */
export function routeMedia(raw: RawMediaMessage): MediaRoute {
  const meta = raw.contentMetadata ?? {};
  if (meta["e2eeVersion"]) {
    return raw.chunks && raw.chunks.length > 0 ? { kind: "e2ee" } : { kind: "gone" };
  }
  const downloadUrl = meta["DOWNLOAD_URL"];
  if (downloadUrl) return { kind: "download_url", url: downloadUrl };
  return { kind: "obs", messageId: raw.id ?? "" };
}

/** adapter protocol v0.8 §get_media 的 params。 */
export interface GetMediaParams {
  platform_message_id: string;
  chat_id: string;
  raw: unknown;
}

export type GetMediaResult =
  | { bytes_base64: string; mime: string; file_name?: string }
  | { unavailable: "gone" | "needs_key" | "unsupported_type" };

/** handleGetMedia 需要的 client 能力，只有這三個——測試不必造整個 linejs client。 */
export interface MediaClient {
  downloadMessageData(messageId: string): Promise<File>;
  downloadMediaByE2EE(message: unknown): Promise<File | null>;
}

async function fileToResult(file: File): Promise<GetMediaResult> {
  const bytes = Buffer.from(await file.arrayBuffer());
  // 0 bytes ＝ LINE 端已刪（obs 對 notexist 的物件回空 body，不是 4xx）。
  // 不當成網路失敗，否則使用者每次捲動都會對已刪媒體重打一次。
  if (bytes.length === 0) return { unavailable: "gone" };
  return {
    bytes_base64: bytes.toString("base64"),
    mime: file.type || "application/octet-stream",
    ...(file.name ? { file_name: file.name } : {}),
  };
}

/**
 * adapter protocol v0.8 的 `get_media`：把一筆媒體的位元組交給 core。
 *
 * 三種來源形狀（實驗實跑驗證，不是推論）在這裡收斂成同一個回傳形狀，
 * 讓 core 與所有 consumer 只看本機路徑——authToken 與 E2EE 金鑰不離開這個行程。
 *
 * 不可得一律回 `{ unavailable }` 而**不是**丟 exception：exception 對 core 來說
 * 分不出「LINE 端已刪」與「網路壞了」，而這兩者的快取策略相反（永久 vs 24h）。
 */
export async function handleGetMedia(
  client: MediaClient,
  params: GetMediaParams,
): Promise<GetMediaResult> {
  const raw = (params.raw ?? {}) as RawMediaMessage;
  const route = routeMedia(raw);

  switch (route.kind) {
    case "gone":
      return { unavailable: "gone" };

    case "download_url": {
      const res = await fetch(route.url);
      if (!res.ok) return { unavailable: "gone" };
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0) return { unavailable: "gone" };
      return {
        bytes_base64: bytes.toString("base64"),
        mime: res.headers.get("content-type") ?? "application/octet-stream",
      };
    }

    case "obs": {
      // isSquare 對 talk 訊息必須維持 false——實驗確認 g2 路徑對 talk 訊息一律 404。
      const file = await client.downloadMessageData(route.messageId || params.platform_message_id);
      return fileToResult(file);
    }

    case "e2ee": {
      const message = {
        ...raw,
        chunks: normalizeChunks(raw.chunks ?? []),
      };
      try {
        const file = await client.downloadMediaByE2EE(message);
        // linejs 對 chunks 空回 null（base/obs/mod.ts:422）；routeMedia 已先攔掉，
        // 這裡是保險。null ⇒ 已刪，不是失敗。
        if (!file) return { unavailable: "gone" };
        return fileToResult(file);
      } catch (err) {
        // 群組共享金鑰不在本機時，e2ee 層丟的是找不到 key 的錯。
        // 這與網路失敗不同——重試不會變好，但也不是「已刪」。
        const msg = err instanceof Error ? err.message : String(err);
        if (/key/i.test(msg)) return { unavailable: "needs_key" };
        throw err;
      }
    }
  }
}
