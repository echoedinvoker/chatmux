import { describe, it, expect } from "bun:test";
import {
  handleOp,
  handleSendMessage,
  handleBackfill,
  type MessageClient,
  type OpObservation,
  type AdapterMessageEvent,
} from "../../../src/adapters/line/messages.js";

function createMockClient(overrides?: Partial<MessageClient>): MessageClient {
  return {
    myMid: "u_me_mid_12345",
    myDisplayName: "Me",
    async decryptMessage(msg) {
      return { ...msg, text: msg.text ?? "[decrypted]" };
    },
    async sendCompactMessage(to, text) {
      return { sequenceId: 1, messageId: BigInt(100), createdTime: Date.now() };
    },
    async getPreviousMessages(chatMid, count) {
      return [];
    },
    ...overrides,
  };
}

function makeOperation(opts: {
  type: number | string;
  from?: string;
  to?: string;
  toType?: number | string;
  text?: string;
  id?: string;
  createdTime?: number;
  contentType?: number | string;
  contentMetadata?: Record<string, string>;
}) {
  return {
    revision: BigInt(1),
    createdTime: BigInt(opts.createdTime ?? Date.now()),
    type: opts.type,
    reqSeq: 0,
    checksum: "",
    status: 0,
    param1: opts.from ?? "",
    param2: opts.to ?? "",
    param3: "",
    message: {
      from: opts.from ?? "u_sender",
      to: opts.to ?? "u_me",
      toType: opts.toType ?? 0,
      id: opts.id ?? "msg_1",
      createdTime: BigInt(opts.createdTime ?? 1690000000000),
      deliveredTime: BigInt(0),
      text: opts.text ?? "hello",
      contentType: opts.contentType ?? 0,
      contentMetadata: opts.contentMetadata ?? {},
    },
  };
}

describe("handleOp", () => {
  it("converts RECEIVE_MESSAGE (type 26) to adapter protocol event", async () => {
    const client = createMockClient();
    const op = makeOperation({
      type: 26,
      from: "u_friend",
      to: "u_me_mid_12345",
      text: "你好",
      id: "m_123",
      createdTime: 1690000000000,
    });
    const event = (await handleOp(op, client)) as AdapterMessageEvent | null;

    expect(event).not.toBeNull();
    expect(event!.type).toBe("message");
    expect(event!.platform).toBe("line");
    expect(event!.platform_message_id).toBe("m_123");
    expect(event!.chat.platform_id).toBe("u_friend");
    expect(event!.chat.type).toBe("direct");
    expect(event!.sender.platform_id).toBe("u_friend");
    expect(event!.timestamp).toBe(1690000000000);
    expect(event!.content.type).toBe("text");
    expect(event!.content.text).toBe("你好");
  });

  it("converts SEND_MESSAGE (type 25) with correct sender = myMid", async () => {
    const client = createMockClient({ myMid: "u_me" });
    const op = makeOperation({
      type: 25,
      from: "u_me",
      to: "u_friend",
      text: "hey",
    });
    const event = (await handleOp(op, client)) as AdapterMessageEvent | null;

    expect(event).not.toBeNull();
    expect(event!.sender.platform_id).toBe("u_me");
    expect(event!.chat.platform_id).toBe("u_friend");
  });

  it("sets chat.type to 'group' for toType=2", async () => {
    const client = createMockClient();
    const op = makeOperation({
      type: 26,
      from: "u_friend",
      to: "c_group",
      toType: 2,
    });
    const event = (await handleOp(op, client)) as AdapterMessageEvent | null;

    expect(event!.chat.type).toBe("group");
    expect(event!.chat.platform_id).toBe("c_group");
  });

  it("sets chat.type to 'group' for toType='GROUP'", async () => {
    const client = createMockClient();
    const op = makeOperation({
      type: 26,
      from: "u_friend",
      to: "c_group",
      toType: "GROUP",
    });
    const event = (await handleOp(op, client)) as AdapterMessageEvent | null;

    expect(event!.chat.type).toBe("group");
  });

  it("returns null for non-message event types", async () => {
    const client = createMockClient();
    const op = makeOperation({ type: 0, text: "end" });
    const event = (await handleOp(op, client)) as AdapterMessageEvent | null;

    expect(event).toBeNull();
  });

  // F23 1.2a: op observer — 兩個靜默丟棄點必須留下痕跡，且三類語意分開
  it("F23: reports 'dropped' with the raw op.type for non-whitelisted ops", async () => {
    const client = createMockClient();
    const seen: OpObservation[] = [];
    const op = makeOperation({ type: 55, from: "u_friend", to: "u_me" });

    const event = await handleOp(op, client, (o) => seen.push(o));

    expect(event).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe("dropped");
    expect(seen[0].opType).toBe(55); // 原始字面值，不做映射（R8）
  });

  it("F23: reports 'kept' and returns the identical event (R5 regression)", async () => {
    const client = createMockClient();
    const seen: OpObservation[] = [];
    const op = makeOperation({
      type: 26,
      from: "u_friend",
      to: "u_me_mid_12345",
      text: "你好",
      id: "m_123",
      createdTime: 1690000000000,
    });

    const withObserver = await handleOp(op, client, (o) => seen.push(o));
    const withoutObserver = await handleOp(op, client);

    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe("kept");
    expect(seen[0].opType).toBe(26);
    // observer 不得改變回傳事件
    expect(withObserver).toEqual(withoutObserver);
  });

  it("F23: reports 'dropped-no-msg' separately when op.message is absent", async () => {
    const client = createMockClient();
    const seen: OpObservation[] = [];
    const op = { ...makeOperation({ type: 26 }), message: undefined };

    const event = await handleOp(op, client, (o) => seen.push(o));

    expect(event).toBeNull();
    expect(seen).toHaveLength(1);
    // 與 "dropped" 分開：這不是 H3，是另一個 bug（F25）
    expect(seen[0].kind).toBe("dropped-no-msg");
  });

  it("F23: observation carries chat id and op createdTime for per-room correlation", async () => {
    const client = createMockClient();
    const seen: OpObservation[] = [];
    const op = makeOperation({
      type: 26,
      from: "u_friend",
      to: "c_group",
      toType: 2,
      createdTime: 1690000000000,
    });

    await handleOp(op, client, (o) => seen.push(o));

    expect(seen[0].chatId).toBe("c_group"); // op.message.to ?? op.message.from
    expect(String(seen[0].t)).toBe(String(1690000000000));
  });

  it("F23: falls back to '?' as chat id when the op carries no message", async () => {
    const client = createMockClient();
    const seen: OpObservation[] = [];
    const op = { ...makeOperation({ type: 55 }), message: undefined };

    await handleOp(op, client, (o) => seen.push(o));

    expect(seen[0].chatId).toBe("?"); // 拿不到就印 ?，不猜
  });

  it("maps sticker contentType to sticker content", async () => {
    const client = createMockClient();
    const op = makeOperation({
      type: 26,
      from: "u_friend",
      to: "u_me",
      contentType: 7,
      contentMetadata: { STKID: "12345" },
    });
    const event = (await handleOp(op, client)) as AdapterMessageEvent | null;

    expect(event!.content.type).toBe("sticker");
    expect(event!.content.sticker_id).toBe("12345");
  });

  it("maps image contentType", async () => {
    const client = createMockClient();
    const op = makeOperation({
      type: 26,
      from: "u_friend",
      to: "u_me",
      contentType: 1,
    });
    const event = (await handleOp(op, client)) as AdapterMessageEvent | null;

    expect(event!.content.type).toBe("image");
  });

  it("maps video contentType", async () => {
    const client = createMockClient();
    const op = makeOperation({
      type: 26,
      from: "u_friend",
      to: "u_me",
      contentType: 2,
    });
    const event = (await handleOp(op, client)) as AdapterMessageEvent | null;

    expect(event!.content.type).toBe("video");
  });

  it("maps unknown contentType to text with label", async () => {
    const client = createMockClient();
    const op = makeOperation({
      type: 26,
      from: "u_friend",
      to: "u_me",
      contentType: 6,
      text: "",
    });
    const event = (await handleOp(op, client)) as AdapterMessageEvent | null;

    expect(event!.content.type).toBe("text");
    expect(event!.content.text).toBe("[通話]");
  });

  it("calls decryptMessage on the message", async () => {
    let decryptCalled = false;
    const client = createMockClient({
      async decryptMessage(msg) {
        decryptCalled = true;
        return { ...msg, text: "decrypted-text" };
      },
    });
    const op = makeOperation({ type: 26, from: "u_friend", to: "u_me" });
    const event = (await handleOp(op, client)) as AdapterMessageEvent | null;

    expect(decryptCalled).toBe(true);
    expect(event!.content.text).toBe("decrypted-text");
  });

  it("handles decryption failure gracefully", async () => {
    const client = createMockClient({
      async decryptMessage() {
        throw new Error("decrypt failed");
      },
    });
    const op = makeOperation({ type: 26, from: "u_friend", to: "u_me", id: "m_fail" });
    const event = (await handleOp(op, client)) as AdapterMessageEvent | null;

    expect(event).not.toBeNull();
    expect(event!.content.text).toBe("[無法解密]");
    expect(event!.platform_message_id).toBe("m_fail");
  });

  it("preserves raw data in event", async () => {
    const client = createMockClient();
    const op = makeOperation({ type: 26, from: "u_friend", to: "u_me" });
    const event = (await handleOp(op, client)) as AdapterMessageEvent | null;

    expect(event!.raw).toBeDefined();
  });
});

describe("handleSendMessage", () => {
  it("sends via client.sendCompactMessage and returns result", async () => {
    let sentTo = "";
    let sentText = "";
    const client = createMockClient({
      async sendCompactMessage(to, text) {
        sentTo = to;
        sentText = text;
        return { sequenceId: 1, messageId: BigInt(999), createdTime: 1690000000000 };
      },
    });

    const result = await handleSendMessage(client, {
      chat_id: "u_target",
      content: { type: "text", text: "hello world" },
    });

    expect(sentTo).toBe("u_target");
    expect(sentText).toBe("hello world");
    expect(result.message_id).toBe("999");
    expect(result.timestamp).toBe(1690000000000);
  });

  it("normalizes second-precision createdTime to milliseconds", async () => {
    // 實測：LINE 的 sendCompactMessage 回的是秒級 epoch（事件路徑則是毫秒）。
    // protocol 與 JsonlEvent 約定毫秒，不轉會讓訊息落到 1970。
    const client = createMockClient({
      async sendCompactMessage() {
        return { sequenceId: 1, messageId: BigInt(999), createdTime: 1784971885 };
      },
    });

    const result = await handleSendMessage(client, {
      chat_id: "u_target",
      content: { type: "text", text: "hi" },
    });

    expect(result.timestamp).toBe(1784971885000);
  });

  it("throws on send failure", async () => {
    const client = createMockClient({
      async sendCompactMessage() {
        throw new Error("recipient not found");
      },
    });

    await expect(
      handleSendMessage(client, {
        chat_id: "u_target",
        content: { type: "text", text: "hello" },
      }),
    ).rejects.toThrow("recipient not found");
  });
});

describe("handleBackfill", () => {
  it("returns events in adapter protocol format", async () => {
    const rawMessages = [
      {
        from: "u_friend",
        to: "u_me_mid_12345",
        toType: 0,
        id: "m2",
        createdTime: BigInt(2000),
        text: "second",
        contentType: 0,
        contentMetadata: {},
      },
      {
        from: "u_me_mid_12345",
        to: "u_friend",
        toType: 0,
        id: "m1",
        createdTime: BigInt(1000),
        text: "first",
        contentType: 0,
        contentMetadata: {},
      },
    ];
    const client = createMockClient({
      async getPreviousMessages() {
        return rawMessages as any;
      },
    });

    const result = await handleBackfill(client, {
      chat_id: "u_friend",
      before_timestamp: 3000,
      count: 50,
    });

    expect(result.events).toHaveLength(2);
    expect(result.events[0].platform_message_id).toBe("m1");
    expect(result.events[0].timestamp).toBe(1000);
    expect(result.events[1].platform_message_id).toBe("m2");
    expect(result.events[1].timestamp).toBe(2000);
    expect(result.oldest_timestamp).toBe(1000);
  });

  it("sets has_more=false when fewer results than requested", async () => {
    const client = createMockClient({
      async getPreviousMessages() {
        return [
          { from: "u_a", to: "u_me", toType: 0, id: "m1", createdTime: BigInt(1000), text: "hi", contentType: 0, contentMetadata: {} },
        ] as any;
      },
    });

    const result = await handleBackfill(client, {
      chat_id: "u_friend",
      before_timestamp: 3000,
      count: 50,
    });

    expect(result.has_more).toBe(false);
  });

  it("sets has_more=true when results equal requested count", async () => {
    const msgs = Array.from({ length: 50 }, (_, i) => ({
      from: "u_a",
      to: "u_me",
      toType: 0,
      id: `m${i}`,
      createdTime: BigInt(1000 + i),
      text: `msg${i}`,
      contentType: 0,
      contentMetadata: {},
    }));
    const client = createMockClient({
      async getPreviousMessages() {
        return msgs as any;
      },
    });

    const result = await handleBackfill(client, {
      chat_id: "u_friend",
      before_timestamp: 3000,
      count: 50,
    });

    expect(result.has_more).toBe(true);
  });

  it("passes before_timestamp to getPreviousMessages", async () => {
    let calledBefore: any = null;
    const client = createMockClient({
      async getPreviousMessages(chatMid, count, before) {
        calledBefore = before;
        return [];
      },
    });

    await handleBackfill(client, {
      chat_id: "u_friend",
      before_timestamp: 1690000000000,
      count: 50,
    });

    expect(calledBefore).toBeDefined();
    expect(Number(calledBefore.deliveredTime)).toBe(1690000000000);
  });

  it("uses before_message_id as the real anchor messageId", async () => {
    let calledBefore: any = null;
    const client = createMockClient({
      async getPreviousMessages(chatMid, count, before) {
        calledBefore = before;
        return [];
      },
    });

    await handleBackfill(client, {
      chat_id: "u_friend",
      before_timestamp: 1690000000000,
      before_message_id: "623300721831838042",
      count: 50,
    });

    expect(calledBefore.messageId).toBe(BigInt("623300721831838042"));
    expect(Number(calledBefore.deliveredTime)).toBe(1690000000000);
  });

  it("keeps messageId=0n when before_message_id is absent (v0.5 behaviour)", async () => {
    let calledBefore: any = null;
    const client = createMockClient({
      async getPreviousMessages(chatMid, count, before) {
        calledBefore = before;
        return [];
      },
    });

    await handleBackfill(client, {
      chat_id: "u_friend",
      before_timestamp: 1690000000000,
      count: 50,
    });

    expect(calledBefore.messageId).toBe(BigInt(0));
  });

  it("handles empty history", async () => {
    const client = createMockClient();
    const result = await handleBackfill(client, {
      chat_id: "u_friend",
      before_timestamp: 3000,
      count: 50,
    });

    expect(result.events).toHaveLength(0);
    expect(result.has_more).toBe(false);
    expect(result.oldest_timestamp).toBe(0);
  });

  it("passes count to getPreviousMessages", async () => {
    let requestedCount = 0;
    const client = createMockClient({
      async getPreviousMessages(chatMid, count) {
        requestedCount = count;
        return [];
      },
    });

    await handleBackfill(client, {
      chat_id: "u_friend",
      before_timestamp: 3000,
      count: 25,
    });

    expect(requestedCount).toBe(25);
  });

  it("passes chat_id as chatMid to getPreviousMessages", async () => {
    let requestedMid = "";
    const client = createMockClient({
      async getPreviousMessages(chatMid, count) {
        requestedMid = chatMid;
        return [];
      },
    });

    await handleBackfill(client, {
      chat_id: "u_target_chat",
      before_timestamp: 3000,
      count: 50,
    });

    expect(requestedMid).toBe("u_target_chat");
  });

  it("sets correct sender identity for self and others in backfill", async () => {
    const rawMessages = [
      {
        from: "u_me_mid_12345",
        to: "u_friend",
        toType: 0,
        id: "m1",
        createdTime: BigInt(1000),
        text: "mine",
        contentType: 0,
        contentMetadata: {},
      },
      {
        from: "u_friend",
        to: "u_me_mid_12345",
        toType: 0,
        id: "m2",
        createdTime: BigInt(2000),
        text: "theirs",
        contentType: 0,
        contentMetadata: {},
      },
    ];
    const client = createMockClient({
      async getPreviousMessages() {
        return rawMessages as any;
      },
    });

    const result = await handleBackfill(client, {
      chat_id: "u_friend",
      before_timestamp: 3000,
      count: 50,
    });

    const sent = result.events as AdapterMessageEvent[];
    expect(sent[0].sender.platform_id).toBe("u_me_mid_12345");
    expect(sent[1].sender.platform_id).toBe("u_friend");
  });
});

// ── Phase 0.3（F13+F29）：狀態類 op 連完整結構一起 report ──────────────
// ⚠️ dump 對象刻意用 NOTIFIED_SEND_REACTION 而非 NOTIFIED_DESTROY_MESSAGE：
// 後者在 Phase 2.1 會進 UNSEND_OP_TYPES 並改報 kept-change，屆時 kind 斷言必然變紅，
// 最省事的改法是放寬 kind 斷言——那會拿掉唯一守著 kept / kept-change 區分的東西，
// 而 F23 的 467:467 守恆靠它。
describe("op observer dump（Phase 0.3）", () => {
  const stubClient = createMockClient();

  it("狀態類 op 被丟棄時連完整結構一起 report", async () => {
    const seen: OpObservation[] = [];
    const op = {
      type: "NOTIFIED_SEND_REACTION",
      param1: "cAAA",
      param2: "12345",
      param3: "0",
      createdTime: 1785307616740,
    };

    const ev = await handleOp(op, stubClient, (o) => seen.push(o));

    expect(ev).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe("dropped");
    expect(seen[0].raw).toEqual(op);
  });

  it("非狀態類的雜訊 op 不夾帶完整結構（避免灌爆 journal）", async () => {
    const seen: OpObservation[] = [];
    const op = { type: "NOTIFIED_READ_MESSAGE", param1: "cAAA", createdTime: 1 };

    await handleOp(op, stubClient, (o) => seen.push(o));

    expect(seen[0].kind).toBe("dropped");
    expect(seen[0].raw).toBeUndefined();
  });
});

describe("handleOp — unsend（F29：LINE 收回 op → unsend 事件）", () => {
  const stubClient = createMockClient();

  it("DESTROY_MESSAGE 產生 unsend 事件，不帶 sender/content", async () => {
    const op = {
      type: "DESTROY_MESSAGE",
      param1: "cAAA",
      param2: "623757041235919438",
      param3: "0",
      createdTime: 1785307616740,
    };

    const ev = await handleOp(op, stubClient, () => {});

    expect(ev).not.toBeNull();
    expect(ev!.type).toBe("unsend");
    expect(ev!.platform).toBe("line");
    expect(ev!.platform_message_id).toBe("623757041235919438");
    expect(ev!.chat.platform_id).toBe("cAAA");
    expect(ev!.timestamp).toBe(1785307616740);
    expect((ev as any).sender).toBeUndefined();
    expect((ev as any).content).toBeUndefined();
  });

  it("缺 chat 或 message id 的收回 op 不產生事件（寧可不做也不做錯）", async () => {
    const op = { type: "DESTROY_MESSAGE", param1: "", param2: "", createdTime: 1 };
    expect(await handleOp(op, stubClient, () => {})).toBeNull();
  });

  // 見計畫 2.1「⚠️ 不可污染 kept」——F23 的守恆檢查靠 kept 與訊息落地數 1:1
  it("收回 op 報 kept-change，不算進 kept", async () => {
    const seen: OpObservation[] = [];
    await handleOp(
      { type: "DESTROY_MESSAGE", param1: "cAAA", param2: "1", createdTime: 1 },
      stubClient,
      (o) => seen.push(o),
    );
    expect(seen[0].kind).toBe("kept-change");
  });

  it("既有 message 事件的形狀不受型別分家影響", async () => {
    const op = {
      type: "RECEIVE_MESSAGE",
      message: {
        from: "uOTHER",
        to: "uSELF",
        toType: "USER",
        id: "1",
        createdTime: 1n,
        text: "hi",
        contentType: "NONE",
        contentMetadata: {},
      },
    };
    const ev = await handleOp(op, stubClient, () => {});
    expect(ev!.type).toBe("message");
    expect((ev as any).sender.platform_id).toBe("uOTHER");
    expect((ev as any).content.text).toBe("hi");
  });
});

// ── Phase 3.2（F13）：貼圖事件帶滿 sticker_id + package_id ─────────────
describe("msgToEvent — 貼圖欄位（Phase 3.2）", () => {
  const stubClient = createMockClient();

  const stickerOp = (meta: Record<string, string>) => ({
    type: "RECEIVE_MESSAGE",
    message: {
      from: "uOTHER",
      to: "uSELF",
      toType: "USER",
      id: "9",
      createdTime: 1n,
      text: "",
      contentType: "STICKER",
      contentMetadata: meta,
    },
  });

  it("貼圖事件同時帶 sticker_id 與 package_id", async () => {
    const ev = (await handleOp(
      stickerOp({ STKID: "14406089", STKPKGID: "1365252" }),
      stubClient,
      () => {},
    )) as AdapterMessageEvent | null;

    expect(ev!.content.type).toBe("sticker");
    expect(ev!.content.sticker_id).toBe("14406089");
    expect(ev!.content.package_id).toBe("1365252");
  });

  it("缺 STKPKGID 時不塞出一個 undefined 鍵", async () => {
    const ev = (await handleOp(
      stickerOp({ STKID: "1" }),
      stubClient,
      () => {},
    )) as AdapterMessageEvent | null;

    expect(ev!.content.sticker_id).toBe("1");
    expect("package_id" in ev!.content).toBe(false);
  });

  // ── F35 Phase 3.2：貼圖是 LINE 唯一符合 v0.8 media_url 語意的來源 ──
  it("貼圖事件帶得出免認證的 media_url", async () => {
    const ev = (await handleOp(
      stickerOp({ STKID: "7432559", STKPKGID: "5145", STKVER: "1" }),
      stubClient,
      () => {},
    )) as AdapterMessageEvent | null;

    expect(ev!.content.media_url).toBe(
      "https://stickershop.line-scdn.net/stickershop/v1/sticker/7432559/android/sticker.png",
    );
  });

  it("圖片不填 media_url——它走 get_media，不是公開 URL", async () => {
    const imageOp = {
      type: "RECEIVE_MESSAGE",
      message: {
        from: "uOTHER", to: "uSELF", toType: "USER", id: "10",
        createdTime: 1n, text: "", contentType: "IMAGE", contentMetadata: {},
      },
    };
    const ev = (await handleOp(imageOp, stubClient, () => {})) as AdapterMessageEvent | null;

    expect(ev!.content.type).toBe("image");
    expect("media_url" in ev!.content).toBe(false);
  });
});

// ── Phase 4.1（F13）：resolveContentText 依 metadata 分流 ──────────────
// 映射依 Phase 1.3 定案表（[RICH] 756 / [CHATEVENT] 21 / [NONE] 13）。
// ⚠️ R12：NONE + UNSENT 這一支產的是 retraction，不是文字。斷言事件型別，
// 不要斷言 content.text——產字面字串會讓缺陷對每個偵測器隱形。
describe("resolveContentText — 語意 placeholder 分流（Phase 4.1）", () => {
  const stubClient = createMockClient();

  const msgWith = (contentType: string, meta: Record<string, string>, text = "") => ({
    type: "RECEIVE_MESSAGE",
    message: {
      from: "uOTHER",
      to: "cAAA",
      toType: "GROUP",
      id: "1",
      createdTime: 1n,
      text,
      contentType,
      contentMetadata: meta,
    },
  });

  it("RICH 顯示 ALT_TEXT 的真實文案", async () => {
    const ev = (await handleOp(
      msgWith("RICH", { ALT_TEXT: "◤200 點紅包◢ 限時活動" }),
      stubClient,
      () => {},
    )) as AdapterMessageEvent | null;
    expect(ev!.content.text).toBe("◤200 點紅包◢ 限時活動");
  });

  it("RICH 缺 ALT_TEXT 時退回可辨識的標籤而非 [RICH]", async () => {
    const ev = (await handleOp(
      msgWith("RICH", {}),
      stubClient,
      () => {},
    )) as AdapterMessageEvent | null;
    expect(ev!.content.text).toBe("[圖文訊息]");
  });

  it("CHATEVENT 依 LOC_KEY 語意化", async () => {
    const ev = (await handleOp(
      msgWith("CHATEVENT", { LOC_KEY: "C_ML", LOC_ARGS: "uX" }),
      stubClient,
      () => {},
    )) as AdapterMessageEvent | null;
    expect(ev!.content.text).toBe("[系統：成員離開]");
  });

  // 不猜語意：推不定就保留原代號。一個看起來正確的錯誤中文標籤比 [CHATEVENT] 更糟。
  it("未知的 LOC_KEY 保留原代號，不猜中文", async () => {
    const ev = (await handleOp(
      msgWith("CHATEVENT", { LOC_KEY: "C_ZZ" }),
      stubClient,
      () => {},
    )) as AdapterMessageEvent | null;
    expect(ev!.content.text).toBe("[系統：C_ZZ]");
  });

  it("NONE + UNSENT 產出 unsend 事件而非文字 placeholder", async () => {
    const ev = await handleOp(
      msgWith("NONE", { UNSENT: "true", UPDATED_TIME: "1784621248047" }),
      stubClient,
      () => {},
    );
    expect(ev!.type).toBe("unsend");
    expect((ev as any).content).toBeUndefined();
    expect(ev!.timestamp).toBe(1784621248047);
  });

  it("NONE + e2eeMark 標成無法解密", async () => {
    const ev = (await handleOp(
      msgWith("NONE", { e2eeMark: "2" }),
      stubClient,
      () => {},
    )) as AdapterMessageEvent | null;
    expect(ev!.content.text).toBe("[無法解密]");
  });

  // Phase 1.3 實測：計畫原本以為「成因未明」的 3 筆也是 e2ee，只是沒有 e2eeMark
  // 這個 key，而是 raw 頂層的 e2eeVersion。只看 e2eeMark 會漏掉它們，
  // 回填後仍是 [NONE]，4.4 的歸零 SQL 直接不過。
  it("NONE + e2eeVersion（無 e2eeMark）同樣標成無法解密", async () => {
    const op = msgWith("NONE", {});
    (op.message as any).e2eeVersion = "2";
    const ev = (await handleOp(op, stubClient, () => {})) as AdapterMessageEvent | null;
    expect(ev!.content.text).toBe("[無法解密]");
  });

  it("未知 contentType 仍走原兜底，不被吞掉", async () => {
    const ev = (await handleOp(
      msgWith("BRANDNEW", {}),
      stubClient,
      () => {},
    )) as AdapterMessageEvent | null;
    expect(ev!.content.text).toBe("[BRANDNEW]");
  });
});

// ── Phase 4.1 追加（見「問題與變更紀錄」2026-07-29 Step 4.1）────────────
// backfill 的已收回訊息，其目標列就是 backfill 自己要建的。只發 unsend
// ⇒ findTarget 找不到 ⇒ 依 adapter-protocol.md:529「no ghost row is created」
// ⇒ 該則訊息在畫面上不是「已收回」，是整則不見。所以要發一對。
describe("handleBackfill — 已收回訊息產出 message + unsend 一對（Phase 4.1）", () => {
  const retractedRaw = {
    from: "uOTHER",
    to: "cAAA",
    toType: "GROUP",
    id: "m_unsent",
    createdTime: 1784621000000n,
    text: "",
    contentType: "NONE",
    contentMetadata: { UNSENT: "true", UPDATED_TIME: "1784621248047" },
  };

  it("先建列再 tombstone，順序不可顛倒", async () => {
    const client = createMockClient({
      async getPreviousMessages() {
        return [retractedRaw as any];
      },
    });

    const result = await handleBackfill(client, {
      chat_id: "cAAA",
      before_timestamp: 1790000000000,
      count: 10,
    });

    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.type).toBe("message");
    expect(result.events[0]!.platform_message_id).toBe("m_unsent");
    expect(result.events[1]!.type).toBe("unsend");
    expect(result.events[1]!.platform_message_id).toBe("m_unsent");
    expect(result.events[1]!.chat.platform_id).toBe("cAAA");
    expect(result.events[1]!.timestamp).toBe(1784621248047);
  });

  it("一般訊息仍只產一個事件", async () => {
    const client = createMockClient({
      async getPreviousMessages() {
        return [{ ...retractedRaw, id: "m_plain", text: "hi", contentMetadata: {} } as any];
      },
    });

    const result = await handleBackfill(client, {
      chat_id: "cAAA",
      before_timestamp: 1790000000000,
      count: 10,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe("message");
  });
});
