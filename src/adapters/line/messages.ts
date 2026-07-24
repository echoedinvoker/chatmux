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

export interface AdapterEvent {
  type: string;
  platform: string;
  platform_message_id: string;
  chat: {
    platform_id: string;
    type: "direct" | "group" | "room";
    name?: string;
  };
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
    file_name?: string;
  };
  raw: unknown;
}

const CONTENT_TYPE_MAP: Record<number | string, string> = {
  0: "text", NONE: "text",
  1: "image", IMAGE: "image",
  2: "video", VIDEO: "video",
  3: "audio", AUDIO: "audio",
  7: "sticker", STICKER: "sticker",
  14: "file", FILE: "file",
};

const CONTENT_TYPE_LABELS: Record<number | string, string> = {
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

const MESSAGE_OP_TYPES = new Set([
  25, "SEND_MESSAGE",
  26, "RECEIVE_MESSAGE",
]);

function isGroup(toType: number | string): boolean {
  return toType === 2 || toType === "GROUP";
}

function resolveChatId(msg: RawMessage, myMid: string): string {
  if (isGroup(msg.toType)) return msg.to;
  return msg.from === myMid ? msg.to : msg.from;
}

function resolveContentType(contentType: number | string): string {
  return CONTENT_TYPE_MAP[contentType] ?? "text";
}

function resolveContentText(msg: RawMessage): string {
  const mapped = resolveContentType(msg.contentType);
  if (mapped === "text") {
    return msg.text || CONTENT_TYPE_LABELS[msg.contentType] || `[${msg.contentType}]`;
  }
  return msg.text || "";
}

function msgToEvent(msg: RawMessage, myMid: string, raw: unknown): AdapterEvent {
  const contentType = resolveContentType(msg.contentType);
  const isSticker = contentType === "sticker";
  const stickerId = isSticker ? msg.contentMetadata?.["STKID"] : undefined;

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
      ...(stickerId ? { sticker_id: stickerId } : {}),
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
): Promise<AdapterEvent | null> {
  const opType = op.type;
  if (!MESSAGE_OP_TYPES.has(opType)) return null;

  const msg = op.message;
  if (!msg) return null;

  try {
    const decrypted = await client.decryptMessage(msg);
    return msgToEvent(decrypted, client.myMid, msg);
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
  const chatId = params.chat_id.includes(":") ? params.chat_id.split(":").slice(1).join(":") : params.chat_id;
  const result = await client.sendCompactMessage(chatId, params.content.text);
  return {
    message_id: String(result.messageId),
    timestamp: result.createdTime,
  };
}

export interface BackfillParams {
  chat_id: string;
  before_timestamp: number;
  count: number;
}

export interface BackfillResult {
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
    messageId: BigInt(0),
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
