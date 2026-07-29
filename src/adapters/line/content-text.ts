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
