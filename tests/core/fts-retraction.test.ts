import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, syncEventToSQLite } from "../../src/core/storage/sqlite";
import { initFTS } from "../../src/core/storage/fts";
import { searchMessages } from "../../src/core/storage/query";
import type { JsonlEvent } from "../../src/core/storage/jsonl";

function messageEvent(id: string, text: string, timestamp: number): JsonlEvent {
  return {
    type: "message",
    platform: "telegram",
    platform_message_id: id,
    chat: { platform_id: "-100123", type: "group", name: "Room" },
    sender: { platform_id: "u_1", display_name: "Alice" },
    timestamp,
    content: { type: "text", text },
    raw: {},
    source: "live",
  };
}

function editEvent(id: string, text: string, timestamp: number): JsonlEvent {
  return {
    type: "edit",
    platform: "telegram",
    platform_message_id: id,
    chat: { platform_id: "-100123", type: "unknown" },
    timestamp,
    content: { type: "text", text },
    raw: {},
    source: "live",
  } as unknown as JsonlEvent;
}

function unsendEvent(id: string, timestamp: number): JsonlEvent {
  return {
    type: "unsend",
    platform: "telegram",
    platform_message_id: id,
    chat: { platform_id: "-100123", type: "unknown" },
    timestamp,
    content: { type: "unsend" },
    raw: {},
    source: "live",
    received_at: 1_700_000_900_000,
  } as unknown as JsonlEvent;
}

describe("FTS index tracks content changes", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    initFTS(db);
    syncEventToSQLite(db, messageEvent("400", "秘密的暗號是紫色兔子", 1_700_000_000_000));
    syncEventToSQLite(db, messageEvent("401", "無關的另一則訊息", 1_700_000_001_000));
  });

  afterEach(() => {
    db.close();
  });

  test("a retracted message is no longer searchable by its original text", () => {
    expect(searchMessages(db, "紫色兔子").length).toBe(1);

    syncEventToSQLite(db, unsendEvent("400", 1_700_000_002_000));

    expect(searchMessages(db, "紫色兔子").length).toBe(0);
  });

  test("an edited message is searchable by its new text, not the old one", () => {
    syncEventToSQLite(db, editEvent("400", "改成綠色烏龜了", 1_700_000_003_000));

    expect(searchMessages(db, "綠色烏龜").length).toBe(1);
    expect(searchMessages(db, "紫色兔子").length).toBe(0);
  });

  test("changes do not disturb the index of other messages", () => {
    syncEventToSQLite(db, unsendEvent("400", 1_700_000_004_000));

    expect(searchMessages(db, "無關的").length).toBe(1);
  });
});
