import {
  CONTENT_TYPE_LABELS,
  isRetraction,
  resolveContentText,
  resolveContentType,
  retractionTimestamp,
} from "./content-text.js";
import { stickerStaticUrl } from "./media.js";

export interface RawMessage {
  from: string;
  to: string;
  toType: number | string;
  id: string;
  createdTime: bigint;
  text: string;
  contentType: number | string;
  contentMetadata: Record<string, string>;
  [key: string]: unknown;
}

export interface MessageClient {
  myMid: string;
  myDisplayName: string;
  decryptMessage(msg: RawMessage): Promise<RawMessage>;
  sendCompactMessage(
    to: string,
    text: string,
  ): Promise<{ sequenceId: number; messageId: bigint; createdTime: number }>;
  getPreviousMessages(
    chatMid: string,
    count: number,
    before?: { deliveredTime: bigint; messageId: bigint },
  ): Promise<RawMessage[]>;
}

// F23：handleOp 有兩個靜默丟棄點（非白名單 op、白名單但無 message），
// 現場不留痕跡，三個假說因此都無法證偽。四種 kind 語意不同不可混為一類：
// dropped = H3 的直接證據；dropped-no-msg = 另一個 bug（F25），不算 H3。
// kept-change = F29 的狀態變更 op（收回）。⚠️ 不可併進 kept：F23 的守恆檢查是
// 「kept 計數 : 訊息落地數 = 1:1」，而收回 op 被 kept 卻不產生新訊息，混進去
// 會讓那個不變量從此靜默地對不上。
export type OpObservationKind = "kept" | "dropped" | "dropped-no-msg" | "kept-change";

export interface OpObservation {
  kind: OpObservationKind;
  opType: unknown; // 原始字面值，不做映射（linejs 可能給數字或字串 enum）
  chatId: string;
  t: unknown;
  // 只在 DUMP_OP_TYPES 命中時帶上：這些 op 沒有 op.message，資料在 param1/2/3，
  // 而現行儀器只記 kind/opType/chatId/t ⇒ param 對應無從反推。其餘 op 不帶，避免灌爆 journal。
  raw?: unknown;
}

// 狀態類 op：要連完整結構一起 dump 才能反推 thrift param 對應。
// ⚠️ 只放具名的少數幾個——全量 dump 會撞 journald rate limit。
// The two DESTROY_MESSAGE entries came off this list once their param layout was pinned
// down (param1 = chat mid, param2 = message id) and the unsend path was built on it — a
// dump that has already told you what it knows is just noise competing for journald's
// rate limit. NOTIFIED_SEND_REACTION stays: reactions have no projection at all yet (F31),
// so its shape is still unknown and this is the only place it is visible.
const DUMP_OP_TYPES = new Set(["NOTIFIED_SEND_REACTION"]);

export type OpObserver = (observation: OpObservation) => void;

export interface AdapterChat {
  platform_id: string;
  type: "direct" | "group" | "room";
  name?: string;
}

export interface AdapterMessageEvent {
  type: "message";
  platform: string;
  platform_message_id: string;
  chat: AdapterChat;
  sender: {
    platform_id: string;
    display_name?: string;
  };
  timestamp: number;
  content: {
    type: string;
    text?: string;
    media_url?: string;
    sticker_id?: string;
    package_id?: string;
    file_name?: string;
  };
  raw: unknown;
}

/**
 * F29：收回事件。依 docs/adapter-protocol.md:533，unsend 必須帶 platform_message_id
 * 與 chat.platform_id，且**不得**帶 sender／content——core 的 applyUnsend
 * （sqlite.ts:330-332）明文寫了 apply 函式不得讀 event.sender。
 */
export interface AdapterUnsendEvent {
  type: "unsend";
  platform: string;
  platform_message_id: string;
  chat: AdapterChat;
  timestamp: number;
  raw: unknown;
}

/** 保留舊名稱當 union，讓下游 import 不必全改 */
export type AdapterEvent = AdapterMessageEvent | AdapterUnsendEvent;

const MESSAGE_OP_TYPES = new Set([
  25, "SEND_MESSAGE",
  26, "RECEIVE_MESSAGE",
]);

/**
 * F29：收回類 op。⚠️ 只放 Phase 1.1 實地取樣過的型別。
 * `NOTIFIED_DESTROY_MESSAGE`（他人收回）無法自行製造、觀測窗內未出現，
 * param 排列未取樣 ⇒ 不外推，不放進來。
 */
const UNSEND_OP_TYPES = new Set(["DESTROY_MESSAGE"]);

/**
 * Phase 1.1 定案（兩個不同形狀的聊天室各取一樣本、逐欄比對實查值）：
 *   param1 = chat mid（= chats.platform_id）、param2 = messageId、param3 = "0"（語意未知，不用）
 */
function destroyOpToUnsend(op: any): AdapterUnsendEvent | null {
  const chatId = String(op.param1 ?? "");
  const messageId = String(op.param2 ?? "");
  if (!chatId || !messageId) return null;

  return {
    type: "unsend",
    platform: "line",
    platform_message_id: messageId,
    chat: {
      platform_id: chatId,
      // core 的 findTarget 用 (platform, chat.platform_id, platform_message_id) 定位，
      // 不讀 chat.type ⇒ 這欄猜錯不影響套用正確性。依 LINE 慣例 c/g 開頭為群組。
      type: /^[cg]/.test(chatId) ? "group" : "direct",
    },
    timestamp: Number(op.createdTime ?? 0),
    raw: op,
  };
}

function isGroup(toType: number | string): boolean {
  return toType === 2 || toType === "GROUP";
}

function resolveChatId(msg: RawMessage, myMid: string): string {
  if (isGroup(msg.toType)) return msg.to;
  return msg.from === myMid ? msg.to : msg.from;
}

/**
 * F13/Phase 4.1: a backfilled message that LINE already knows was retracted.
 *
 * Returned alongside the message event rather than instead of it, because the row this
 * retraction targets is the one the same backfill is about to create. Core drops an
 * unsend whose target does not exist (adapter-protocol.md:529, "no ghost row is
 * created") — sending only the unsend would not render the message as retracted, it
 * would leave a hole in the timeline where the message used to be.
 */
function retractionFor(msg: RawMessage, myMid: string, raw: unknown): AdapterUnsendEvent | null {
  if (!isRetraction(msg)) return null;

  return {
    type: "unsend",
    platform: "line",
    platform_message_id: msg.id,
    chat: {
      platform_id: resolveChatId(msg, myMid),
      type: isGroup(msg.toType) ? "group" : "direct",
    },
    timestamp: retractionTimestamp(msg) ?? Number(msg.createdTime),
    raw,
  };
}

function msgToEvent(msg: RawMessage, myMid: string, raw: unknown): AdapterMessageEvent {
  const contentType = resolveContentType(msg.contentType);
  const isSticker = contentType === "sticker";
  const stickerId = isSticker ? msg.contentMetadata?.["STKID"] : undefined;
  const packageId = isSticker ? msg.contentMetadata?.["STKPKGID"] : undefined;
  // protocol v0.8：media_url = 免認證、任何人可直連的公開 URL。
  // LINE 只有貼圖符合；圖片（obs／E2EE）一律走 get_media，不填這欄。
  const mediaUrl = isSticker ? stickerStaticUrl(stickerId) : null;

  return {
    type: "message",
    platform: "line",
    platform_message_id: msg.id,
    chat: {
      platform_id: resolveChatId(msg, myMid),
      type: isGroup(msg.toType) ? "group" : "direct",
    },
    sender: {
      platform_id: msg.from,
    },
    timestamp: Number(msg.createdTime),
    content: {
      type: contentType,
      ...(contentType === "text" ? { text: resolveContentText(msg) } : {}),
      ...(mediaUrl ? { media_url: mediaUrl } : {}),
      ...(stickerId ? { sticker_id: stickerId } : {}),
      ...(packageId ? { package_id: packageId } : {}),
      ...(contentType === "text" && !msg.text && CONTENT_TYPE_LABELS[msg.contentType]
        ? { text: CONTENT_TYPE_LABELS[msg.contentType] }
        : {}),
    },
    raw,
  };
}

export async function handleOp(
  op: any,
  client: MessageClient,
  observe?: OpObserver,
): Promise<AdapterEvent | null> {
  const opType = op.type;
  const isUnsendOp = UNSEND_OP_TYPES.has(String(opType));
  // 收回 op 沒有 op.message（資料在 param1/2/3），舊 fallback 只會記出 chat=?
  const chatId =
    op.message?.to ?? op.message?.from ?? (isUnsendOp ? String(op.param1 ?? "?") : "?");
  const report = (kind: OpObservationKind): void => {
    observe?.({
      kind,
      opType,
      chatId,
      t: op.createdTime,
      ...(DUMP_OP_TYPES.has(String(opType)) ? { raw: op } : {}),
    });
  };

  if (isUnsendOp) {
    const unsend = destroyOpToUnsend(op);
    if (!unsend) {
      // 寧可不做也不做錯：param 缺一不可，猜出來的 id 會收回錯的訊息（R2）
      report("dropped-no-msg");
      return null;
    }
    report("kept-change");
    return unsend;
  }

  if (!MESSAGE_OP_TYPES.has(opType)) {
    report("dropped");
    return null;
  }

  const msg = op.message;
  if (!msg) {
    report("dropped-no-msg");
    return null;
  }

  report("kept");

  try {
    const decrypted = await client.decryptMessage(msg);
    // Live path only: the target row already exists (the message arrived before it was
    // retracted), so the state change alone is the whole story. Backfill is the one that
    // has to materialise the row first — see handleBackfill.
    return retractionFor(decrypted, client.myMid, msg) ?? msgToEvent(decrypted, client.myMid, msg);
  } catch {
    return {
      type: "message",
      platform: "line",
      platform_message_id: msg.id ?? "unknown",
      chat: {
        platform_id: resolveChatId(msg, client.myMid),
        type: isGroup(msg.toType) ? "group" : "direct",
      },
      sender: {
        platform_id: msg.from ?? "unknown",
      },
      timestamp: Number(msg.createdTime ?? 0),
      content: {
        type: "text",
        text: "[無法解密]",
      },
      raw: msg,
    };
  }
}

export interface SendMessageParams {
  chat_id: string;
  content: {
    type: string;
    text: string;
  };
}

export interface SendMessageResult {
  message_id: string;
  timestamp: number;
}

export async function handleSendMessage(
  client: MessageClient,
  params: SendMessageParams,
): Promise<SendMessageResult> {
  const result = await client.sendCompactMessage(params.chat_id, params.content.text);
  return {
    message_id: String(result.messageId),
    timestamp: toMillis(result.createdTime),
  };
}

/**
 * LINE 的 sendCompactMessage 回秒級 epoch，事件路徑（handleOp / getPreviousMessages）
 * 則是毫秒。protocol 與 JsonlEvent 一律用毫秒，所以在 adapter 邊界正規化。
 * 門檻 1e12 ＝ 2001 年的毫秒值；秒級要超過它得等到西元 33658 年，不會誤判。
 */
function toMillis(epoch: number): number {
  return epoch < 1e12 ? epoch * 1000 : epoch;
}

export interface BackfillParams {
  chat_id: string;
  before_timestamp: number;
  /** protocol v0.6, optional：這則訊息之前的歷史。缺席時語意等同 v0.5 */
  before_message_id?: string;
  count: number;
}

export interface BackfillResult {
  /**
   * Not `AdapterMessageEvent[]`: a retracted message replays as a pair — the message that
   * creates the row, then the unsend that tombstones it (Phase 4.1).
   */
  events: AdapterEvent[];
  has_more: boolean;
  oldest_timestamp: number;
}

export async function handleBackfill(
  client: MessageClient,
  params: BackfillParams,
): Promise<BackfillResult> {
  const before = {
    deliveredTime: BigInt(params.before_timestamp),
    messageId: params.before_message_id ? BigInt(params.before_message_id) : BigInt(0),
  };

  const rawMessages = await client.getPreviousMessages(
    params.chat_id,
    params.count,
    before,
  );

  const events: AdapterEvent[] = [];
  for (const raw of rawMessages) {
    try {
      const decrypted = await client.decryptMessage(raw);
      events.push(msgToEvent(decrypted, client.myMid, raw));
      // Order matters and the sort below preserves it: UPDATED_TIME is later than
      // createdTime, and equal timestamps keep insertion order (Array#sort is stable).
      const retraction = retractionFor(decrypted, client.myMid, raw);
      if (retraction) events.push(retraction);
    } catch {
      events.push({
        type: "message",
        platform: "line",
        platform_message_id: raw.id ?? "unknown",
        chat: {
          platform_id: params.chat_id,
          type: "direct",
        },
        sender: {
          platform_id: raw.from ?? "unknown",
        },
        timestamp: Number(raw.createdTime ?? 0),
        content: { type: "text", text: "[無法解密]" },
        raw,
      });
    }
  }

  events.sort((a, b) => a.timestamp - b.timestamp);

  return {
    events,
    has_more: rawMessages.length >= params.count,
    oldest_timestamp: events.length > 0 ? events[0]!.timestamp : 0,
  };
}
