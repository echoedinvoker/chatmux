/**
 * LINE-specific readings of a stored `raw` message payload.
 *
 * These live apart from `messages.ts` because two callers need them and only one of them
 * is the adapter: the live path converts an incoming op, and the rederive script repairs
 * rows that landed before the adapter knew how to read a field. Sharing the function is
 * what keeps the two from drifting into producing different text for the same message.
 */

export interface StickerIds {
  sticker_id: string;
  package_id?: string;
}

/**
 * The shape both callers can supply: the adapter hands over a decrypted `RawMessage`,
 * the rederive script hands over a `JSON.parse` of the stored `raw` column. Structural
 * typing is what lets one mapping serve both without core importing the adapter.
 */
export interface ContentSource {
  text?: string;
  contentType: number | string;
  contentMetadata?: Record<string, unknown> | null;
  /** e2ee messages that never got a `contentMetadata.e2eeMark` still carry this at the top level */
  e2eeVersion?: unknown;
}

export const CONTENT_TYPE_MAP: Record<number | string, string> = {
  0: "text", NONE: "text",
  1: "image", IMAGE: "image",
  2: "video", VIDEO: "video",
  3: "audio", AUDIO: "audio",
  7: "sticker", STICKER: "sticker",
  14: "file", FILE: "file",
};

export const CONTENT_TYPE_LABELS: Record<number | string, string> = {
  1: "[圖片]", IMAGE: "[圖片]",
  2: "[影片]", VIDEO: "[影片]",
  3: "[語音]", AUDIO: "[語音]",
  6: "[通話]", CALL: "[通話]",
  7: "[貼圖]", STICKER: "[貼圖]",
  13: "[聯絡人]", CONTACT: "[聯絡人]",
  14: "[檔案]", FILE: "[檔案]",
  15: "[位置]", LOCATION: "[位置]",
  22: "[Flex]", FLEX: "[Flex]",
};

/**
 * Phase 1.3: derived from LOC_ARGS arity and event pairing across all 21 stored rows,
 * not copied from a reverse-engineering doc. `C_MI` is deliberately absent — one sample,
 * structurally identical to `C_GI` but with no following `C_MJ`, which is not enough to
 * tell "removed a member" from "another kind of invite". It falls through to `[系統：C_MI]`.
 * A confident wrong label reads worse than the raw code: the code at least admits ignorance.
 */
export const CHAT_EVENT_LABELS: Record<string, string> = {
  C_ML: "[系統：成員離開]",
  C_MJ: "[系統：成員加入]",
  C_GI: "[系統：邀請成員]",
};

function contentMetadata(raw: unknown): Record<string, unknown> | null {
  if (raw == null || typeof raw !== "object") return null;
  const meta = (raw as { contentMetadata?: unknown }).contentMetadata;
  if (meta == null || typeof meta !== "object") return null;
  return meta as Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Sticker identity out of a raw LINE message, or null when this payload does not carry
 * one. Null is the signal to leave the row alone — Telegram's stickers land in the same
 * table with a raw shape that has no `STKID` at all, and writing an empty ID over them
 * would turn "we never knew" into "we know it is nothing".
 */
export function extractSticker(raw: unknown): StickerIds | null {
  const meta = contentMetadata(raw);
  if (!meta) return null;

  const stickerId = str(meta["STKID"]);
  if (!stickerId) return null;

  const packageId = str(meta["STKPKGID"]);
  return packageId ? { sticker_id: stickerId, package_id: packageId } : { sticker_id: stickerId };
}

export function resolveContentType(contentType: number | string): string {
  return CONTENT_TYPE_MAP[contentType] ?? "text";
}

/**
 * The one line a consumer will show for a message whose content is not plain text.
 *
 * Everything here reads metadata LINE already sends and we were throwing away: `[RICH]`,
 * `[CHATEVENT]` and `[NONE]` were never "no text available", they were "nobody looked".
 * The `[${contentType}]` fallback stays last on purpose — the next content type LINE
 * invents should surface as an unknown code, not vanish into one of the branches above.
 */
export function resolveContentText(msg: ContentSource): string {
  if (resolveContentType(msg.contentType) !== "text") return msg.text || "";
  if (msg.text) return msg.text;

  const meta = msg.contentMetadata ?? {};
  switch (String(msg.contentType)) {
    case "RICH":
      return str(meta["ALT_TEXT"]) ?? "[圖文訊息]";
    case "CHATEVENT": {
      const locKey = str(meta["LOC_KEY"]);
      if (!locKey) break;
      return CHAT_EVENT_LABELS[locKey] ?? `[系統：${locKey}]`;
    }
    case "NONE":
    case "0":
      // Three places, because the stored rows use two of them and nothing rules out the
      // third: `e2eeMark` on most, `contentMetadata.e2eeVersion` on the ones that carry no
      // mark at all, and the top-level field the protocol notes describe. Recognising one
      // location too many costs nothing; recognising one too few leaves the row as [NONE].
      if (meta["e2eeMark"] != null || meta["e2eeVersion"] != null || msg.e2eeVersion != null) {
        return "[無法解密]";
      }
      break;
  }

  return CONTENT_TYPE_LABELS[msg.contentType] || `[${msg.contentType}]`;
}

/**
 * A retracted message that LINE replays through backfill: `contentType=NONE` plus
 * `contentMetadata.UNSENT="true"`.
 *
 * This deliberately does NOT go through `resolveContentText`. "This message was retracted"
 * is a state, not a text — writing it as a string would land a row that no detector can
 * see: it fails the placeholder scans (the literal is not `[NONE]`), fails the
 * `retracted_at IS NOT NULL` counts, renders un-italicised as exactly what a reviewer is
 * hoping to see, and gets indexed into FTS. Retraction has one representation in this
 * system — `content_text = NULL` + `retracted_at` — and this path produces that one.
 */
export function isRetraction(msg: ContentSource): boolean {
  if (resolveContentType(msg.contentType) !== "text") return false;
  return (msg.contentMetadata ?? {})["UNSENT"] === "true";
}

/**
 * The rederive script's view of a stored `raw`: same mapping as the live path, wrapped so
 * the repair side gets "what should this row's projection be" instead of just a string.
 *
 * Returns null for anything that is not a LINE message payload. That null is what lets
 * core scan every platform's rows with one query — a reader that does not recognise a
 * payload says so, rather than guessing and overwriting another adapter's work.
 */
export function deriveProjection(
  raw: unknown,
): { text: string | null; retracted_at?: number } | null {
  if (raw == null || typeof raw !== "object") return null;
  const msg = raw as Partial<ContentSource> & { createdTime?: unknown };
  if (msg.contentType == null) return null;

  const source = msg as ContentSource;
  // A retraction is a state, not a text — so the projection says "no text, retracted at T"
  // and lands the same shape `applyUnsend` writes. Anything else, however well-worded,
  // would be a row that reads as retracted to a human and as ordinary to every query.
  if (isRetraction(source)) {
    return { text: null, retracted_at: retractionTimestamp(source) ?? Number(msg.createdTime) };
  }

  return { text: resolveContentText(source) };
}

/** `UPDATED_TIME` is when the retraction happened; it is present on all 8 stored rows. */
export function retractionTimestamp(msg: ContentSource): number | undefined {
  const raw = str((msg.contentMetadata ?? {})["UPDATED_TIME"]);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
