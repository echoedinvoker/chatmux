import { describe, it, expect } from "bun:test";
import {
  handleOp,
  handleSendMessage,
  handleBackfill,
  type MessageClient,
} from "../../../src/adapters/line/messages.js";

function createMockClient(overrides?: Partial<MessageClient>): MessageClient {
  return {
    myMid: "u_me_mid_12345",
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
    const event = await handleOp(op, client);

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
    const event = await handleOp(op, client);

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
    const event = await handleOp(op, client);

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
    const event = await handleOp(op, client);

    expect(event!.chat.type).toBe("group");
  });

  it("returns null for non-message event types", async () => {
    const client = createMockClient();
    const op = makeOperation({ type: 0, text: "end" });
    const event = await handleOp(op, client);

    expect(event).toBeNull();
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
    const event = await handleOp(op, client);

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
    const event = await handleOp(op, client);

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
    const event = await handleOp(op, client);

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
    const event = await handleOp(op, client);

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
    const event = await handleOp(op, client);

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
    const event = await handleOp(op, client);

    expect(event).not.toBeNull();
    expect(event!.content.text).toBe("[無法解密]");
    expect(event!.platform_message_id).toBe("m_fail");
  });

  it("preserves raw data in event", async () => {
    const client = createMockClient();
    const op = makeOperation({ type: 26, from: "u_friend", to: "u_me" });
    const event = await handleOp(op, client);

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

    expect(result.events[0].sender.platform_id).toBe("u_me_mid_12345");
    expect(result.events[1].sender.platform_id).toBe("u_friend");
  });
});
