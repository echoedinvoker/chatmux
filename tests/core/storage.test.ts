import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initSchema } from "../../src/core/storage/sqlite";
import { initFTS, searchFTS } from "../../src/core/storage/fts";
import { JsonlWriter, type JsonlEvent } from "../../src/core/storage/jsonl";
import { syncEventToSQLite } from "../../src/core/storage/sqlite";
import {
  searchMessages,
  getMessages,
  listChats,
  getStatus,
} from "../../src/core/storage/query";

describe("FTS5 2-char CJK recall", () => {
  let db: Database;

  const twoCharTerms = [
    "午餐", "開會", "晚安", "冥想", "散步",
    "早安", "下班", "加班", "健身", "跑步",
    "晚餐", "上班", "感謝", "確認", "請假",
    "報告", "打卡", "聚餐", "回家", "出門",
  ];

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    initFTS(db);

    const insertChat = db.prepare(
      "INSERT INTO chats (platform, platform_id, type, name) VALUES (?, ?, ?, ?)"
    );
    insertChat.run("line", "c_test", "direct", "Test Chat");

    const insertContact = db.prepare(
      "INSERT INTO contacts (platform, platform_id, display_name) VALUES (?, ?, ?)"
    );
    insertContact.run("line", "u_test", "Tester");

    const insertMsg = db.prepare(
      `INSERT INTO messages (platform, platform_message_id, chat_id, sender_id, timestamp, content_type, content_text, source)
       VALUES (?, ?, 1, 1, ?, 'text', ?, 'live')`
    );

    for (let i = 0; i < twoCharTerms.length; i++) {
      const term = twoCharTerms[i];
      insertMsg.run("line", `m_${i}`, Date.now() + i, `今天${term}了，感覺不錯`);
    }
  });

  afterEach(() => {
    db.close();
  });

  test("should recall ≥ 80% of 2-char Chinese terms (16/20)", () => {
    let hits = 0;
    for (const term of twoCharTerms) {
      const results = searchFTS(db, term);
      if (results.length > 0) hits++;
    }
    const recall = hits / twoCharTerms.length;
    expect(recall).toBeGreaterThanOrEqual(0.8);
    expect(hits).toBeGreaterThanOrEqual(16);
  });

  test("should return matching content_text in results", () => {
    const results = searchFTS(db, "午餐");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content_text).toContain("午餐");
  });

  test("should handle 3+ char CJK via trigram", () => {
    const results = searchFTS(db, "感覺不錯");
    expect(results.length).toBe(twoCharTerms.length);
  });
});

describe("JSONL writer", () => {
  let tmpDir: string;
  let writer: JsonlWriter;
  let filePath: string;

  const sampleEvent: JsonlEvent = {
    type: "message",
    platform: "line",
    platform_message_id: "m_001",
    chat: { platform_id: "c_001", type: "direct", name: "Alice" },
    sender: { platform_id: "u_001", display_name: "Alice" },
    timestamp: 1690000000000,
    content: { type: "text", text: "你好！" },
    raw: {},
    source: "live",
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "chatmux-test-"));
    filePath = join(tmpDir, "events.jsonl");
    writer = new JsonlWriter(filePath);
  });

  afterEach(async () => {
    writer.close();
    await rm(tmpDir, { recursive: true });
  });

  test("should append event as one JSON line with received_at", async () => {
    writer.append(sampleEvent);
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("message");
    expect(parsed.platform).toBe("line");
    expect(parsed.platform_message_id).toBe("m_001");
    expect(parsed.received_at).toBeNumber();
  });

  test("should append multiple events as separate lines", async () => {
    writer.append(sampleEvent);
    writer.append({ ...sampleEvent, platform_message_id: "m_002" });
    writer.append({ ...sampleEvent, platform_message_id: "m_003" });
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(3);
  });

  test("should read back appended lines", async () => {
    writer.append(sampleEvent);
    writer.append({ ...sampleEvent, platform_message_id: "m_002" });
    const lines = writer.readLines();
    expect(lines.length).toBe(2);
    expect(lines[0].platform_message_id).toBe("m_001");
    expect(lines[1].platform_message_id).toBe("m_002");
  });
});

describe("JSONL→SQLite sync", () => {
  let db: Database;

  const makeEvent = (id: string, text: string): JsonlEvent => ({
    type: "message",
    platform: "line",
    platform_message_id: id,
    chat: { platform_id: "c_001", type: "direct", name: "Alice" },
    sender: { platform_id: "u_001", display_name: "Alice" },
    timestamp: 1690000000000,
    content: { type: "text", text },
    raw: {},
    source: "live",
  });

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    initFTS(db);
  });

  afterEach(() => {
    db.close();
  });

  test("should upsert contact, chat, and insert message", () => {
    syncEventToSQLite(db, makeEvent("m_001", "你好"));

    const contacts = db.query("SELECT * FROM contacts").all();
    expect(contacts.length).toBe(1);

    const chats = db.query("SELECT * FROM chats").all();
    expect(chats.length).toBe(1);

    const messages = db.query("SELECT * FROM messages").all();
    expect(messages.length).toBe(1);
  });

  test("should dedup: same event twice → SQLite has 1 row", () => {
    const event = makeEvent("m_001", "重複測試");
    syncEventToSQLite(db, event);
    syncEventToSQLite(db, event);

    const messages = db.query("SELECT * FROM messages").all();
    expect(messages.length).toBe(1);
  });

  test("should update last_message_at on chat", () => {
    syncEventToSQLite(db, { ...makeEvent("m_001", "第一條"), timestamp: 1000 });
    syncEventToSQLite(db, { ...makeEvent("m_002", "第二條"), timestamp: 2000 });

    const chat = db.query<{ last_message_at: number }, []>(
      "SELECT last_message_at FROM chats WHERE platform_id = 'c_001'"
    ).get();
    expect(chat!.last_message_at).toBe(2000);
  });

  test("should reuse existing contact on same platform_id", () => {
    syncEventToSQLite(db, makeEvent("m_001", "一"));
    syncEventToSQLite(db, makeEvent("m_002", "二"));

    const contacts = db.query("SELECT * FROM contacts").all();
    expect(contacts.length).toBe(1);
  });

  test("synced messages should be searchable via FTS", () => {
    syncEventToSQLite(db, makeEvent("m_001", "今天午餐吃拉麵"));

    const results = searchFTS(db, "午餐");
    expect(results.length).toBe(1);
    expect(results[0].content_text).toContain("午餐");
  });
});

describe("Query functions", () => {
  let db: Database;

  const makeEvent = (
    id: string,
    text: string,
    opts?: { chatId?: string; chatName?: string; senderName?: string; timestamp?: number }
  ): JsonlEvent => ({
    type: "message",
    platform: "line",
    platform_message_id: id,
    chat: { platform_id: opts?.chatId ?? "c_001", type: "direct", name: opts?.chatName ?? "Alice" },
    sender: { platform_id: "u_001", display_name: opts?.senderName ?? "Alice" },
    timestamp: opts?.timestamp ?? 1690000000000,
    content: { type: "text", text },
    raw: {},
    source: "live",
  });

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    initFTS(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("searchMessages", () => {
    test("should find messages by text query", () => {
      syncEventToSQLite(db, makeEvent("m_001", "今天午餐吃拉麵"));
      syncEventToSQLite(db, makeEvent("m_002", "明天開會討論"));

      const results = searchMessages(db, "午餐");
      expect(results.length).toBe(1);
      expect(results[0].content_text).toContain("午餐");
    });

    test("should return results with highlight snippet", () => {
      syncEventToSQLite(db, makeEvent("m_001", "今天午餐吃拉麵很好吃"));

      const results = searchMessages(db, "拉麵很好吃");
      expect(results.length).toBe(1);
      expect(results[0].snippet).toBeDefined();
    });

    test("should respect limit", () => {
      for (let i = 0; i < 10; i++) {
        syncEventToSQLite(db, makeEvent(`m_${i}`, `午餐第${i}天`, { timestamp: 1690000000000 + i }));
      }

      const results = searchMessages(db, "午餐", { limit: 3 });
      expect(results.length).toBe(3);
    });
  });

  describe("getMessages", () => {
    test("should return messages for a chat in descending timestamp order", () => {
      syncEventToSQLite(db, makeEvent("m_001", "第一條", { timestamp: 1000 }));
      syncEventToSQLite(db, makeEvent("m_002", "第二條", { timestamp: 2000 }));
      syncEventToSQLite(db, makeEvent("m_003", "第三條", { timestamp: 3000 }));

      const chatId = db.query<{ id: number }, []>("SELECT id FROM chats LIMIT 1").get()!.id;
      const results = getMessages(db, chatId);
      expect(results.length).toBe(3);
      expect(results[0].content_text).toBe("第三條");
      expect(results[2].content_text).toBe("第一條");
    });

    test("should support before cursor (pagination)", () => {
      syncEventToSQLite(db, makeEvent("m_001", "舊", { timestamp: 1000 }));
      syncEventToSQLite(db, makeEvent("m_002", "中", { timestamp: 2000 }));
      syncEventToSQLite(db, makeEvent("m_003", "新", { timestamp: 3000 }));

      const chatId = db.query<{ id: number }, []>("SELECT id FROM chats LIMIT 1").get()!.id;
      const results = getMessages(db, chatId, { before: 3000 });
      expect(results.length).toBe(2);
      expect(results[0].content_text).toBe("中");
    });

    test("should support after cursor", () => {
      syncEventToSQLite(db, makeEvent("m_001", "舊", { timestamp: 1000 }));
      syncEventToSQLite(db, makeEvent("m_002", "中", { timestamp: 2000 }));
      syncEventToSQLite(db, makeEvent("m_003", "新", { timestamp: 3000 }));

      const chatId = db.query<{ id: number }, []>("SELECT id FROM chats LIMIT 1").get()!.id;
      const results = getMessages(db, chatId, { after: 1000 });
      expect(results.length).toBe(2);
      expect(results[0].content_text).toBe("新");
    });
  });

  describe("listChats", () => {
    test("should return chats with last message preview", () => {
      syncEventToSQLite(db, makeEvent("m_001", "最後一條", { chatName: "Alice", timestamp: 2000 }));
      syncEventToSQLite(db, makeEvent("m_002", "另一聊天", { chatId: "c_002", chatName: "Bob", timestamp: 1000 }));

      const chats = listChats(db);
      expect(chats.length).toBe(2);
      expect(chats[0].name).toBe("Alice");
      expect(chats[0].last_message_text).toBe("最後一條");
    });

    test("should order by last_message_at descending", () => {
      syncEventToSQLite(db, makeEvent("m_001", "舊聊天", { chatId: "c_001", chatName: "Old", timestamp: 1000 }));
      syncEventToSQLite(db, makeEvent("m_002", "新聊天", { chatId: "c_002", chatName: "New", timestamp: 2000 }));

      const chats = listChats(db);
      expect(chats[0].name).toBe("New");
      expect(chats[1].name).toBe("Old");
    });
  });

  describe("getStatus", () => {
    test("should return message count and db stats", () => {
      syncEventToSQLite(db, makeEvent("m_001", "一"));
      syncEventToSQLite(db, makeEvent("m_002", "二"));

      const status = getStatus(db);
      expect(status.message_count).toBe(2);
      expect(status.chat_count).toBe(1);
      expect(status.contact_count).toBe(1);
    });

    test("should handle empty db", () => {
      const status = getStatus(db);
      expect(status.message_count).toBe(0);
      expect(status.oldest_message_at).toBeNull();
    });
  });
});

describe("Integration: JSONL → SQLite → FTS → query", () => {
  let db: Database;
  let tmpDir: string;
  let writer: JsonlWriter;

  const makeEvent = (
    id: string,
    text: string,
    opts?: { chatId?: string; chatName?: string; timestamp?: number; source?: string }
  ): JsonlEvent => ({
    type: "message",
    platform: "line",
    platform_message_id: id,
    chat: { platform_id: opts?.chatId ?? "c_001", type: "direct", name: opts?.chatName ?? "Alice" },
    sender: { platform_id: "u_001", display_name: "Alice" },
    timestamp: opts?.timestamp ?? 1690000000000,
    content: { type: "text", text },
    raw: {},
    source: opts?.source ?? "live",
  });

  beforeEach(async () => {
    db = new Database(":memory:");
    initSchema(db);
    initFTS(db);
    tmpDir = await mkdtemp(join(tmpdir(), "chatmux-int-"));
    writer = new JsonlWriter(join(tmpDir, "events.jsonl"));
  });

  afterEach(async () => {
    db.close();
    writer.close();
    await rm(tmpDir, { recursive: true });
  });

  test("full pipeline: write JSONL → sync SQLite → search FTS → paginated read", () => {
    const events = [
      makeEvent("m_001", "午餐吃拉麵", { timestamp: 1000 }),
      makeEvent("m_002", "下午開會討論", { timestamp: 2000 }),
      makeEvent("m_003", "晚上散步回家", { timestamp: 3000 }),
    ];

    for (const event of events) {
      writer.append(event);
      syncEventToSQLite(db, event);
    }

    const jsonlLines = writer.readLines();
    expect(jsonlLines.length).toBe(3);

    const ftsResults = searchMessages(db, "午餐");
    expect(ftsResults.length).toBe(1);
    expect(ftsResults[0].content_text).toContain("午餐");

    const chatId = db.query<{ id: number }, []>("SELECT id FROM chats LIMIT 1").get()!.id;
    const page1 = getMessages(db, chatId, { limit: 2 });
    expect(page1.length).toBe(2);
    expect(page1[0].content_text).toBe("晚上散步回家");

    const page2 = getMessages(db, chatId, { before: page1[1].timestamp, limit: 2 });
    expect(page2.length).toBe(1);
    expect(page2[0].content_text).toBe("午餐吃拉麵");

    const chats = listChats(db);
    expect(chats.length).toBe(1);
    expect(chats[0].last_message_text).toBe("晚上散步回家");
    expect(chats[0].message_count).toBe(3);
  });

  test("dedup: same event in JSONL twice → SQLite has 1 row, JSONL has 2 lines", () => {
    const event = makeEvent("m_dup", "重複訊息");
    writer.append(event);
    syncEventToSQLite(db, event);
    writer.append(event);
    syncEventToSQLite(db, event);

    const jsonlLines = writer.readLines();
    expect(jsonlLines.length).toBe(2);

    const messages = db.query<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM messages"
    ).get()!;
    expect(messages.count).toBe(1);
  });

  test("bulk write: 1000 events", () => {
    for (let i = 0; i < 1000; i++) {
      const event = makeEvent(`m_bulk_${i}`, `訊息 ${i}`, { timestamp: i });
      writer.append(event);
      syncEventToSQLite(db, event);
    }

    const jsonlLines = writer.readLines();
    expect(jsonlLines.length).toBe(1000);

    const status = getStatus(db);
    expect(status.message_count).toBe(1000);

    const searchResults = searchMessages(db, "訊息 500");
    expect(searchResults.length).toBeGreaterThan(0);
  });

  test("empty DB: all queries return empty/zero", () => {
    const status = getStatus(db);
    expect(status.message_count).toBe(0);

    const chats = listChats(db);
    expect(chats.length).toBe(0);

    const searchResults = searchMessages(db, "不存在");
    expect(searchResults.length).toBe(0);
  });

  test("backfill + live dedup: same message from both sources → 1 row", () => {
    const backfill = makeEvent("m_same", "同一條訊息", { source: "backfill", timestamp: 1000 });
    const live = makeEvent("m_same", "同一條訊息", { source: "live", timestamp: 1000 });

    writer.append(backfill);
    syncEventToSQLite(db, backfill);
    writer.append(live);
    syncEventToSQLite(db, live);

    const jsonlLines = writer.readLines();
    expect(jsonlLines.length).toBe(2);

    const msgCount = db.query<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM messages"
    ).get()!;
    expect(msgCount.count).toBe(1);

    const msg = db.query<{ source: string }, []>(
      "SELECT source FROM messages WHERE platform_message_id = 'm_same'"
    ).get()!;
    expect(msg.source).toBe("backfill");
  });

  test("concurrent backfill×live: interleaved events with overlapping IDs → each message_id once", () => {
    const backfillEvents = Array.from({ length: 20 }, (_, i) =>
      makeEvent(`m_overlap_${i}`, `backfill msg ${i}`, { source: "backfill", timestamp: 1000 + i })
    );
    const liveEvents = Array.from({ length: 10 }, (_, i) =>
      makeEvent(`m_overlap_${i + 10}`, `live msg ${i}`, { source: "live", timestamp: 1010 + i })
    );
    const liveOnly = Array.from({ length: 5 }, (_, i) =>
      makeEvent(`m_live_only_${i}`, `live only ${i}`, { source: "live", timestamp: 2000 + i })
    );

    for (let i = 0; i < Math.max(backfillEvents.length, liveEvents.length + liveOnly.length); i++) {
      if (i < backfillEvents.length) {
        writer.append(backfillEvents[i]);
        syncEventToSQLite(db, backfillEvents[i]);
      }
      if (i < liveEvents.length) {
        writer.append(liveEvents[i]);
        syncEventToSQLite(db, liveEvents[i]);
      }
      if (i >= liveEvents.length && i - liveEvents.length < liveOnly.length) {
        const lo = liveOnly[i - liveEvents.length];
        writer.append(lo);
        syncEventToSQLite(db, lo);
      }
    }

    const jsonlLines = writer.readLines();
    expect(jsonlLines.length).toBe(35);

    const uniqueIds = db.query<{ count: number }, []>(
      "SELECT COUNT(DISTINCT platform_message_id) as count FROM messages"
    ).get()!;
    expect(uniqueIds.count).toBe(25);

    const totalRows = db.query<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM messages"
    ).get()!;
    expect(totalRows.count).toBe(25);

    for (let i = 10; i < 20; i++) {
      const msg = db.query<{ platform_message_id: string }, [string]>(
        "SELECT platform_message_id FROM messages WHERE platform_message_id = ?"
      ).get(`m_overlap_${i}`);
      expect(msg).not.toBeNull();
    }

    for (let i = 0; i < 5; i++) {
      const msg = db.query<{ platform_message_id: string }, [string]>(
        "SELECT platform_message_id FROM messages WHERE platform_message_id = ?"
      ).get(`m_live_only_${i}`);
      expect(msg).not.toBeNull();
    }
  });
});
