import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, syncEventToSQLite } from "../../src/core/storage/sqlite";
import { initFTS } from "../../src/core/storage/fts";
import type { JsonlEvent } from "../../src/core/storage/jsonl";
import { handleListChats, handleReadMessages, handleSearchMessages, handleSendMessage, handleGetStatus, handleGetMedia } from "../../src/core/mcp/tools";
import type { OutgoingDraft } from "../../src/core/mcp/tools";
import { handleResource, ResourceSubscriptionManager } from "../../src/core/mcp/resources";
import { SafetyRail } from "../../src/core/safety";
import { markInFlight, clearInFlight, __resetBackfillState } from "../../src/core/backfill-on-demand";

function makeEvent(overrides: Partial<JsonlEvent> & { platform_message_id: string }): JsonlEvent {
  return {
    type: "message",
    platform: "line",
    platform_message_id: overrides.platform_message_id,
    chat: { platform_id: "c_alice", type: "direct", name: "Alice" },
    sender: { platform_id: "u_alice", display_name: "Alice" },
    timestamp: Date.now(),
    content: { type: "text", text: "hello" },
    source: "live",
    raw: {},
    ...overrides,
  };
}

describe("list_chats tool", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    initFTS(db);

    syncEventToSQLite(db, makeEvent({
      platform_message_id: "m1",
      chat: { platform_id: "c_alice", type: "direct", name: "Alice" },
      sender: { platform_id: "u_alice", display_name: "Alice" },
      timestamp: 1690000000000,
      content: { type: "text", text: "你好！" },
    }));
    syncEventToSQLite(db, makeEvent({
      platform_message_id: "m2",
      chat: { platform_id: "c_group", type: "group", name: "工作群組" },
      sender: { platform_id: "u_bob", display_name: "Bob" },
      timestamp: 1690000001000,
      content: { type: "text", text: "開會了" },
    }));
  });

  afterEach(() => db.close());

  test("returns all chats with correct format", () => {
    const result = handleListChats(db, {});
    expect(result.chats).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
  });

  test("chat has composite id (platform:platform_id)", () => {
    const result = handleListChats(db, {});
    const alice = result.chats.find((c: any) => c.name === "Alice");
    expect(alice).toBeDefined();
    expect(alice.id).toBe("line:c_alice");
    expect(alice.platform).toBe("line");
    expect(alice.type).toBe("direct");
  });

  test("chat includes last_message preview", () => {
    const result = handleListChats(db, {});
    const alice = result.chats.find((c: any) => c.name === "Alice");
    expect(alice.last_message).toBeDefined();
    expect(alice.last_message.text).toBe("你好！");
    expect(alice.last_message.timestamp).toBe(1690000000000);
  });

  test("chat includes message_count", () => {
    const result = handleListChats(db, {});
    const alice = result.chats.find((c: any) => c.name === "Alice");
    expect(alice.message_count).toBe(1);
  });

  test("filters by platform", () => {
    const result = handleListChats(db, { platform: "telegram" });
    expect(result.chats).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test("searches by chat name", () => {
    const result = handleListChats(db, { search: "Alice" });
    expect(result.chats).toHaveLength(1);
    expect(result.chats[0].name).toBe("Alice");
  });

  test("respects limit and offset", () => {
    const result = handleListChats(db, { limit: 1, offset: 0 });
    expect(result.chats).toHaveLength(1);

    const result2 = handleListChats(db, { limit: 1, offset: 1 });
    expect(result2.chats).toHaveLength(1);
    expect(result2.chats[0].id).not.toBe(result.chats[0].id);
  });

  test("orders by last_activity_at DESC", () => {
    const result = handleListChats(db, {});
    expect(result.chats[0].name).toBe("工作群組");
    expect(result.chats[1].name).toBe("Alice");
  });

  test("last_message timestamp and text come from the same landed message", () => {
    // F21 核心症狀：adapter 自報 7/25 有動靜，但 core 只落地到 7/13 那則
    const jul13 = 1752364800000;
    const jul25 = 1753401600000;
    db.query("UPDATE chats SET last_activity_at = ? WHERE platform_id = ?").run(jul25, "c_alice");
    db.query("UPDATE chats SET last_message_at = ? WHERE platform_id = ?").run(jul13, "c_alice");
    db.query("UPDATE messages SET timestamp = ? WHERE platform_message_id = ?").run(jul13, "m1");

    const alice = handleListChats(db, { search: "Alice" }).chats[0];
    expect(alice.last_message.timestamp).toBe(jul13);
    expect(alice.last_message.text).toBe("你好！");
  });

  test("list_chats and chat info report the same last_message_at", () => {
    const jul13 = 1752364800000;
    const jul25 = 1753401600000;
    db.query("UPDATE chats SET last_activity_at = ? WHERE platform_id = ?").run(jul25, "c_alice");
    db.query("UPDATE chats SET last_message_at = ? WHERE platform_id = ?").run(jul13, "c_alice");
    db.query("UPDATE messages SET timestamp = ? WHERE platform_message_id = ?").run(jul13, "m1");

    const fromTool = handleListChats(db, { search: "Alice" }).chats[0];
    const fromResource = JSON.parse(
      handleResource(db, "chat://chats/line:c_alice/info", {} as any)!
    );

    expect(fromResource.last_message_at).toBe(fromTool.last_message.timestamp);
    expect(fromResource.last_activity_at).toBe(jul25);
  });
});

describe("read_messages tool", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    initFTS(db);

    for (let i = 0; i < 5; i++) {
      syncEventToSQLite(db, makeEvent({
        platform_message_id: `m${i}`,
        chat: { platform_id: "c_alice", type: "direct", name: "Alice" },
        sender: { platform_id: "u_alice", display_name: "Alice" },
        timestamp: 1690000000000 + i * 1000,
        content: { type: "text", text: `message ${i}` },
      }));
    }
  });

  afterEach(() => db.close());

  test("returns messages for a chat by composite id", () => {
    const result = handleReadMessages(db, { chat_id: "line:c_alice" });
    expect(result.messages).toHaveLength(5);
  });

  test("message has correct format", () => {
    const result = handleReadMessages(db, { chat_id: "line:c_alice", limit: 1 });
    const msg = result.messages[0];
    expect(msg.id).toMatch(/^line:m\d$/);
    expect(msg.chat_id).toBe("line:c_alice");
    expect(msg.sender).toBeDefined();
    expect(msg.sender.id).toBe("line:u_alice");
    expect(msg.sender.display_name).toBe("Alice");
    expect(msg.timestamp).toBeGreaterThan(0);
    expect(msg.content.type).toBe("text");
    expect(msg.content.text).toBeDefined();
  });

  test("returns messages ordered by timestamp DESC", () => {
    const result = handleReadMessages(db, { chat_id: "line:c_alice" });
    for (let i = 0; i < result.messages.length - 1; i++) {
      expect(result.messages[i].timestamp).toBeGreaterThanOrEqual(result.messages[i + 1].timestamp);
    }
  });

  test("respects limit", () => {
    const result = handleReadMessages(db, { chat_id: "line:c_alice", limit: 2 });
    expect(result.messages).toHaveLength(2);
    expect(result.has_more).toBe(true);
  });

  test("has_more is false when all messages returned", () => {
    const result = handleReadMessages(db, { chat_id: "line:c_alice", limit: 10 });
    expect(result.messages).toHaveLength(5);
    expect(result.has_more).toBe(false);
  });

  test("supports before cursor", () => {
    const result = handleReadMessages(db, {
      chat_id: "line:c_alice",
      before: 1690000003000,
    });
    expect(result.messages.length).toBe(3);
    for (const msg of result.messages) {
      expect(msg.timestamp).toBeLessThan(1690000003000);
    }
  });

  test("supports after cursor", () => {
    const result = handleReadMessages(db, {
      chat_id: "line:c_alice",
      after: 1690000002000,
    });
    expect(result.messages.length).toBe(2);
    for (const msg of result.messages) {
      expect(msg.timestamp).toBeGreaterThan(1690000002000);
    }
  });

  test("returns oldest/newest timestamp", () => {
    const result = handleReadMessages(db, { chat_id: "line:c_alice" });
    expect(result.oldest_timestamp).toBe(1690000000000);
    expect(result.newest_timestamp).toBe(1690000004000);
  });

  test("returns empty for non-existent chat", () => {
    const result = handleReadMessages(db, { chat_id: "line:c_nonexistent" });
    expect(result.messages).toHaveLength(0);
  });
});

describe("read_messages history state", () => {
  let db: Database;

  function setState(state: string | null) {
    db.query("UPDATE chats SET backfill_state = ? WHERE platform_id = 'c_alice'").run(state);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    initFTS(db);
    __resetBackfillState();

    syncEventToSQLite(db, makeEvent({
      platform_message_id: "m0",
      chat: { platform_id: "c_alice", type: "direct", name: "Alice" },
      sender: { platform_id: "u_alice", display_name: "Alice" },
      timestamp: 1690000000000,
      content: { type: "text", text: "hi" },
    }));
  });

  afterEach(() => {
    __resetBackfillState();
    db.close();
  });

  test("unavailable maps to unavailable", () => {
    setState("unavailable");
    expect(handleReadMessages(db, { chat_id: "line:c_alice" }).history?.state).toBe("unavailable");
  });

  test("exhausted maps to complete", () => {
    setState("exhausted");
    expect(handleReadMessages(db, { chat_id: "line:c_alice" }).history?.state).toBe("complete");
  });

  test("partial maps to partial", () => {
    setState("partial");
    expect(handleReadMessages(db, { chat_id: "line:c_alice" }).history?.state).toBe("partial");
  });

  test("NULL maps to unknown", () => {
    setState(null);
    expect(handleReadMessages(db, { chat_id: "line:c_alice" }).history?.state).toBe("unknown");
  });

  test("in-flight overrides the DB column", () => {
    setState("partial");
    markInFlight("line:c_alice");
    expect(handleReadMessages(db, { chat_id: "line:c_alice" }).history?.state).toBe("backfilling");
    clearInFlight("line:c_alice");
    expect(handleReadMessages(db, { chat_id: "line:c_alice" }).history?.state).toBe("partial");
  });

  test("existing fields are unchanged", () => {
    setState("unavailable");
    const result = handleReadMessages(db, { chat_id: "line:c_alice" });
    expect(result.messages).toHaveLength(1);
    expect(result.has_more).toBe(false);
    expect(result.oldest_timestamp).toBe(1690000000000);
    expect(result.newest_timestamp).toBe(1690000000000);
  });

  test("non-existent chat still returns the empty shape", () => {
    const result = handleReadMessages(db, { chat_id: "line:c_nope" });
    expect(result.messages).toHaveLength(0);
    expect(result.has_more).toBe(false);
    expect(result.oldest_timestamp).toBeNull();
    expect(result.newest_timestamp).toBeNull();
    expect(result.history?.state).toBe("unknown");
  });
});

describe("search_messages tool", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    initFTS(db);

    const messages = [
      { id: "m1", text: "今天中午吃什麼？", ts: 1690000000000 },
      { id: "m2", text: "午餐吃便當", ts: 1690000001000 },
      { id: "m3", text: "晚安，明天見", ts: 1690000002000 },
      { id: "m4", text: "開會時間改了", ts: 1690000003000 },
      { id: "m5", text: "this is english text", ts: 1690000004000 },
    ];

    for (const msg of messages) {
      syncEventToSQLite(db, makeEvent({
        platform_message_id: msg.id,
        chat: { platform_id: "c_alice", type: "direct", name: "Alice" },
        sender: { platform_id: "u_alice", display_name: "Alice" },
        timestamp: msg.ts,
        content: { type: "text", text: msg.text },
      }));
    }
  });

  afterEach(() => db.close());

  test("searches 2-char CJK via LIKE fallback", () => {
    const result = handleSearchMessages(db, { query: "午餐" });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].message.content.text).toContain("午餐");
  });

  test("searches 3+ char CJK via FTS5 trigram", () => {
    const result = handleSearchMessages(db, { query: "中午吃" });
    expect(result.results.length).toBeGreaterThan(0);
  });

  test("result includes snippet with highlight", () => {
    const result = handleSearchMessages(db, { query: "中午吃什麼" });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].snippet).toBeDefined();
  });

  test("result includes chat_name", () => {
    const result = handleSearchMessages(db, { query: "午餐" });
    expect(result.results[0].chat_name).toBe("Alice");
  });

  test("message has correct format", () => {
    const result = handleSearchMessages(db, { query: "午餐" });
    const msg = result.results[0].message;
    expect(msg.id).toMatch(/^line:m\d$/);
    expect(msg.chat_id).toBe("line:c_alice");
    expect(msg.sender.id).toBe("line:u_alice");
    expect(msg.sender.display_name).toBe("Alice");
  });

  test("filters by chat_id", () => {
    syncEventToSQLite(db, makeEvent({
      platform_message_id: "m_other",
      chat: { platform_id: "c_bob", type: "direct", name: "Bob" },
      sender: { platform_id: "u_bob", display_name: "Bob" },
      timestamp: 1690000005000,
      content: { type: "text", text: "午餐一起吃" },
    }));

    const result = handleSearchMessages(db, { query: "午餐", chat_id: "line:c_alice" });
    for (const r of result.results) {
      expect(r.message.chat_id).toBe("line:c_alice");
    }
  });

  test("respects limit", () => {
    const result = handleSearchMessages(db, { query: "午餐", limit: 1 });
    expect(result.results).toHaveLength(1);
  });

  test("returns total and pagination info", () => {
    const result = handleSearchMessages(db, { query: "午餐" });
    expect(result.total).toBeGreaterThan(0);
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
  });

  test("returns empty for no matches", () => {
    const result = handleSearchMessages(db, { query: "不存在的詞" });
    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

describe("send_message tool", () => {
  test("sends successfully via adapter", async () => {
    const safety = new SafetyRail({ initialBackoffMs: 1, maxBackoffMs: 1 });
    const mockSend = async (_method: string, _params: unknown) => ({
      message_id: "line:m_sent_1",
      timestamp: 1690000010000,
    });

    const result = await handleSendMessage(
      { safetyRail: safety, sendToAdapter: mockSend, isAdapterConnected: () => true },
      { chat_id: "line:c_alice", text: "hello" },
    );
    expect(result.success).toBe(true);
    expect(result.message_id).toBe("line:m_sent_1");
    expect(result.timestamp).toBe(1690000010000);
  });

  test("records outgoing draft exactly once after successful send", async () => {
    const safety = new SafetyRail({ initialBackoffMs: 1, maxBackoffMs: 1 });
    const drafts: OutgoingDraft[] = [];

    await handleSendMessage(
      {
        safetyRail: safety,
        sendToAdapter: async () => ({ message_id: "m1", timestamp: 1234 }),
        isAdapterConnected: () => true,
        recordOutgoing: (d) => { drafts.push(d); },
      },
      { chat_id: "line:c_alice", text: "hi" },
    );

    expect(drafts.length).toBe(1);
    const draft = drafts[0]!;
    expect(draft.type).toBe("message");
    expect(draft.platform).toBe("line");
    expect(draft.platform_message_id).toBe("m1");
    expect(draft.chat.platform_id).toBe("c_alice");
    expect(draft.content).toEqual({ type: "text", text: "hi" });
    expect(draft.timestamp).toBe(1234);
    expect(draft.source).toBe("live");
  });

  test("does not record outgoing when send fails", async () => {
    const safety = new SafetyRail({ initialBackoffMs: 1, maxBackoffMs: 1 });
    const drafts: OutgoingDraft[] = [];

    const result = await handleSendMessage(
      {
        safetyRail: safety,
        sendToAdapter: async () => { throw new Error("boom"); },
        isAdapterConnected: () => true,
        recordOutgoing: (d) => { drafts.push(d); },
      },
      { chat_id: "line:c_alice", text: "hi" },
    );

    expect(result.success).toBe(false);
    expect(drafts.length).toBe(0);
  });

  test("does not record outgoing when adapter is disconnected", async () => {
    const safety = new SafetyRail({ initialBackoffMs: 1, maxBackoffMs: 1 });
    const drafts: OutgoingDraft[] = [];

    await handleSendMessage(
      {
        safetyRail: safety,
        sendToAdapter: async () => ({ message_id: "m1", timestamp: 1234 }),
        isAdapterConnected: () => false,
        recordOutgoing: (d) => { drafts.push(d); },
      },
      { chat_id: "line:c_alice", text: "hi" },
    );

    expect(drafts.length).toBe(0);
  });

  test("does not record outgoing when adapter returns no message_id", async () => {
    const safety = new SafetyRail({ initialBackoffMs: 1, maxBackoffMs: 1 });
    const drafts: OutgoingDraft[] = [];

    const result = await handleSendMessage(
      {
        safetyRail: safety,
        sendToAdapter: async () => ({ timestamp: 1234 }),
        isAdapterConnected: () => true,
        recordOutgoing: (d) => { drafts.push(d); },
      },
      { chat_id: "line:c_alice", text: "hi" },
    );

    expect(result.success).toBe(true);
    expect(drafts.length).toBe(0);
  });

  test("returns error when adapter is not connected", async () => {
    const safety = new SafetyRail({ initialBackoffMs: 1, maxBackoffMs: 1 });
    const result = await handleSendMessage(
      { safetyRail: safety, sendToAdapter: async () => ({}), isAdapterConnected: () => false },
      { chat_id: "line:c_alice", text: "hello" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("adapter_unavailable");
  });

  test("returns error when kill switch is tripped", async () => {
    const safety = new SafetyRail({ initialBackoffMs: 1, maxBackoffMs: 1 });
    safety.killSwitch.recordAnomaly("test kill");

    const result = await handleSendMessage(
      { safetyRail: safety, sendToAdapter: async () => ({}), isAdapterConnected: () => true },
      { chat_id: "line:c_alice", text: "hello" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("adapter_unavailable");
  });

  test("records success on SafetyRail after successful send", async () => {
    const safety = new SafetyRail({ initialBackoffMs: 1, maxBackoffMs: 1 });
    await safety.recordError(new Error("prev error"));

    await handleSendMessage(
      {
        safetyRail: safety,
        sendToAdapter: async () => ({ message_id: "m1", timestamp: 1 }),
        isAdapterConnected: () => true,
      },
      { chat_id: "line:c_alice", text: "hello" },
    );
    expect(safety.errorTracker.count).toBe(0);
  });

  test("records error on SafetyRail when send fails", async () => {
    const safety = new SafetyRail({ initialBackoffMs: 1, maxBackoffMs: 1 });
    const result = await handleSendMessage(
      {
        safetyRail: safety,
        sendToAdapter: async () => { throw new Error("send failed"); },
        isAdapterConnected: () => true,
      },
      { chat_id: "line:c_alice", text: "hello" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("send_failed");
    expect(safety.errorTracker.count).toBe(1);
  });
});

describe("get_status tool", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    initFTS(db);

    syncEventToSQLite(db, makeEvent({
      platform_message_id: "m1",
      timestamp: 1690000000000,
    }));
    syncEventToSQLite(db, makeEvent({
      platform_message_id: "m2",
      timestamp: 1690000005000,
    }));
  });

  afterEach(() => db.close());

  test("returns storage stats from DB", () => {
    const result = handleGetStatus(db, {
      adapters: { line: { state: "connected", uptime_seconds: 60 } },
    });
    expect(result.storage.message_count).toBe(2);
    expect(result.storage.chat_count).toBe(1);
    expect(result.storage.contact_count).toBe(1);
    expect(result.storage.oldest_message).toBe(1690000000000);
    expect(result.storage.newest_message).toBe(1690000005000);
  });

  test("includes adapter states", () => {
    const result = handleGetStatus(db, {
      adapters: {
        line: { state: "connected", uptime_seconds: 3600, rate_limit: { remaining: 3, resets_in_seconds: 45 } },
      },
    });
    expect(result.adapters.line.state).toBe("connected");
    expect(result.adapters.line.uptime_seconds).toBe(3600);
    expect(result.adapters.line.rate_limit.remaining).toBe(3);
  });

  test("returns db_size_mb and jsonl_size_mb", () => {
    const result = handleGetStatus(db, {
      adapters: {},
      dbSizeMb: 1.5,
      jsonlSizeMb: 2.3,
    });
    expect(result.storage.db_size_mb).toBe(1.5);
    expect(result.storage.jsonl_size_mb).toBe(2.3);
  });
});

describe("MCP resources", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    initFTS(db);

    syncEventToSQLite(db, makeEvent({
      platform_message_id: "m1",
      chat: { platform_id: "c_alice", type: "direct", name: "Alice" },
      sender: { platform_id: "u_alice", display_name: "Alice" },
      timestamp: 1690000000000,
      content: { type: "text", text: "你好！" },
    }));
    syncEventToSQLite(db, makeEvent({
      platform_message_id: "m2",
      chat: { platform_id: "c_alice", type: "direct", name: "Alice" },
      sender: { platform_id: "u_alice", display_name: "Alice" },
      timestamp: 1690000001000,
      content: { type: "text", text: "再見" },
    }));
  });

  afterEach(() => db.close());

  test("chat://chats returns all chats", () => {
    const result = handleResource(db, "chat://chats", {
      adapters: {},
    });
    expect(result).toBeDefined();
    const data = JSON.parse(result);
    expect(data.chats).toHaveLength(1);
    expect(data.chats[0].id).toBe("line:c_alice");
  });

  test("chat://chats/{id}/messages returns recent messages", () => {
    const result = handleResource(db, "chat://chats/line:c_alice/messages", {
      adapters: {},
    });
    const data = JSON.parse(result);
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0].chat_id).toBe("line:c_alice");
  });

  test("chat://chats/{id}/messages respects limit query param", () => {
    const result = handleResource(db, "chat://chats/line:c_alice/messages?limit=1", {
      adapters: {},
    });
    const data = JSON.parse(result);
    expect(data.messages).toHaveLength(1);
  });

  test("chat://chats/{id}/info returns chat info", () => {
    const result = handleResource(db, "chat://chats/line:c_alice/info", {
      adapters: {},
    });
    const data = JSON.parse(result);
    expect(data.id).toBe("line:c_alice");
    expect(data.type).toBe("direct");
    expect(data.name).toBe("Alice");
    expect(data.message_count).toBe(2);
    expect(data.platform).toBe("line");
  });

  test("chat://status returns system status", () => {
    const result = handleResource(db, "chat://status", {
      adapters: { line: { state: "connected", uptime_seconds: 60 } },
    });
    const data = JSON.parse(result);
    expect(data.adapters.line.state).toBe("connected");
    expect(data.storage.message_count).toBe(2);
  });

  test("returns null for unknown resource URI", () => {
    const result = handleResource(db, "chat://unknown", { adapters: {} });
    expect(result).toBeNull();
  });

  test("chat://chats/{id}/messages reports the read so history can be fetched", () => {
    const read: string[] = [];
    handleResource(db, "chat://chats/line:c_alice/messages", {
      adapters: {},
      onChatRead: (id) => read.push(id),
    });
    expect(read).toEqual(["line:c_alice"]);
  });

  test("chat list and status reads are not chat reads", () => {
    const read: string[] = [];
    const ctx = { adapters: {}, onChatRead: (id: string) => read.push(id) };

    handleResource(db, "chat://chats", ctx);
    handleResource(db, "chat://status", ctx);
    handleResource(db, "chat://chats/line:c_alice/info", ctx);

    expect(read).toEqual([]);
  });
});

describe("resource subscription", () => {
  test("new message triggers chat://chats and chat://chats/{id}/messages notifications", () => {
    const sub = new ResourceSubscriptionManager();
    const notifications: string[] = [];
    sub.onUpdate((uri) => notifications.push(uri));

    sub.notifyMessageReceived("line:c_alice");

    expect(notifications).toContain("chat://chats");
    expect(notifications).toContain("chat://chats/line:c_alice/messages");
  });

  test("does not duplicate URIs in a single notification batch", () => {
    const sub = new ResourceSubscriptionManager();
    const notifications: string[] = [];
    sub.onUpdate((uri) => notifications.push(uri));

    sub.notifyMessageReceived("line:c_alice");
    const chatChats = notifications.filter(u => u === "chat://chats");
    expect(chatChats).toHaveLength(1);
  });

  test("contact update triggers chat://chats/{id}/info", () => {
    const sub = new ResourceSubscriptionManager();
    const notifications: string[] = [];
    sub.onUpdate((uri) => notifications.push(uri));

    sub.notifyContactUpdated("line:c_alice");
    expect(notifications).toContain("chat://chats/line:c_alice/info");
  });

  test("status change triggers chat://status", () => {
    const sub = new ResourceSubscriptionManager();
    const notifications: string[] = [];
    sub.onUpdate((uri) => notifications.push(uri));

    sub.notifyStatusChanged();
    expect(notifications).toContain("chat://status");
  });

  test("supports multiple listeners", () => {
    const sub = new ResourceSubscriptionManager();
    const a: string[] = [];
    const b: string[] = [];
    sub.onUpdate((uri) => a.push(uri));
    sub.onUpdate((uri) => b.push(uri));

    sub.notifyStatusChanged();
    expect(a).toContain("chat://status");
    expect(b).toContain("chat://status");
  });
});

// ── Phase 3.4（F13）：read_messages 回傳貼圖 id ────────────────────────
describe("read_messages 的貼圖欄位（Phase 3.4）", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    initFTS(db);

    syncEventToSQLite(db, makeEvent({
      platform_message_id: "s1",
      chat: { platform_id: "cAAA", type: "group", name: "G" },
      timestamp: 1690000000000,
      content: { type: "sticker", sticker_id: "14406089", package_id: "1365252" },
    }));
    syncEventToSQLite(db, makeEvent({
      platform_message_id: "t1",
      chat: { platform_id: "cAAA", type: "group", name: "G" },
      timestamp: 1690000001000,
      content: { type: "text", text: "文字" },
    }));
  });

  afterEach(() => db.close());

  test("對貼圖回傳 sticker_id 與 package_id", () => {
    const res = handleReadMessages(db, { chat_id: "line:cAAA" });
    const sticker = res.messages.find((m) => m.content.type === "sticker")!;
    expect(sticker.content.sticker_id).toBe("14406089");
    expect(sticker.content.package_id).toBe("1365252");
  });

  test("文字訊息的 content 不夾帶貼圖鍵", () => {
    const res = handleReadMessages(db, { chat_id: "line:cAAA" });
    const text = res.messages.find((m) => m.content.type === "text")!;
    expect("sticker_id" in text.content).toBe(false);
    expect("package_id" in text.content).toBe(false);
  });
});

describe("get_media tool", () => {
  const STICKER_URL =
    "https://stickershop.line-scdn.net/stickershop/v1/sticker/7432559/android/sticker.png";

  /** Minimal cache stub: proves the tool turned a stored row into the right key. */
  const fakeCache = (result: unknown) => ({
    fetchMedia: async (key: any) => {
      expect(key.platform).toBe("line");
      expect(key.contentType).toBe("sticker");   // decides sticker/ vs msg/ in the path
      expect(key.messageId).toBe("m1");          // images key on it; nothing else catches a miss
      expect(key.stickerId).toBe("7432559");
      expect(key.publicUrl).toBe(STICKER_URL);
      return result;
    },
  }) as any;

  function seedSticker(): Database {
    const db = new Database(":memory:");
    initSchema(db);
    initFTS(db);
    syncEventToSQLite(db, makeEvent({
      platform_message_id: "m1",
      timestamp: 1690000000000,
      content: { type: "sticker", sticker_id: "7432559", package_id: "5145", media_url: STICKER_URL },
      raw: { contentMetadata: { STKID: "7432559", STKPKGID: "5145" } },
    }));
    return db;
  }

  test("resolves a stored sticker row to a cached path", async () => {
    const db = seedSticker();
    const res = await handleGetMedia(
      db,
      fakeCache({ path: "/c/line/sticker/7432559.png", mime: "image/png" }),
      { message_id: "line:m1" },
    );
    expect(res).toEqual({ path: "/c/line/sticker/7432559.png", mime: "image/png" });
    db.close();
  });

  test("answers unavailable rather than throwing for an unknown message", async () => {
    const db = new Database(":memory:");
    initSchema(db);
    initFTS(db);
    const res = await handleGetMedia(db, fakeCache(null), { message_id: "line:nope" });
    expect(res).toEqual({ unavailable: "no_adapter" });
    db.close();
  });
});

describe("read_messages: media_url exposure (gap 2b)", () => {
  test("passes media_url through, and omits the key when there is none", () => {
    const db = new Database(":memory:");
    initSchema(db);
    initFTS(db);
    syncEventToSQLite(db, makeEvent({
      platform_message_id: "m1",
      timestamp: 1690000000000,
      content: {
        type: "sticker",
        sticker_id: "7432559",
        media_url:
          "https://stickershop.line-scdn.net/stickershop/v1/sticker/7432559/android/sticker.png",
      },
    }));
    syncEventToSQLite(db, makeEvent({
      platform_message_id: "m2",
      timestamp: 1690000001000,
      content: { type: "text", text: "hi" },
    }));

    const res = handleReadMessages(db, { chat_id: "line:c_alice" });
    const sticker = res.messages.find((m: any) => m.id === "line:m1")!;
    const text = res.messages.find((m: any) => m.id === "line:m2")!;
    expect((sticker.content as any).media_url).toContain("7432559");
    expect("media_url" in (text.content as any)).toBe(false);
    db.close();
  });
});
