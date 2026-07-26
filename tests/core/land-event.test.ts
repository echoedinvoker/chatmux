import { describe, test, expect } from "bun:test";
import { makeLandEvent } from "../../src/core/storage/land-event";
import type { JsonlEvent } from "../../src/core/storage/jsonl";

function makeEvent(overrides: Partial<JsonlEvent> = {}): JsonlEvent {
  return {
    type: "message",
    platform: "line",
    platform_message_id: "m1",
    chat: { platform_id: "c1", type: "direct" },
    sender: { platform_id: "u1", display_name: "Me" },
    timestamp: 1690000000000,
    content: { type: "text", text: "hi" },
    raw: {},
    source: "live",
    ...overrides,
  };
}

function makeDeps(over: { appendThrows?: boolean; syncThrows?: boolean } = {}) {
  const appended: JsonlEvent[] = [];
  const synced: JsonlEvent[] = [];
  const notified: string[] = [];
  return {
    appended,
    synced,
    notified,
    deps: {
      jsonl: {
        append: (e: JsonlEvent) => {
          if (over.appendThrows) throw new Error("jsonl boom");
          appended.push(e);
        },
      },
      syncToSQLite: (e: JsonlEvent) => {
        if (over.syncThrows) throw new Error("sqlite boom");
        synced.push(e);
      },
      subscriptions: { notifyMessageReceived: (id: string) => { notified.push(id); } },
    },
  };
}

describe("landEvent", () => {
  test("lands once and dedupes the same key", () => {
    const { appended, synced, notified, deps } = makeDeps();
    const landEvent = makeLandEvent(deps);

    expect(landEvent(makeEvent())).toBe(true);
    expect(landEvent(makeEvent())).toBe(false);

    expect(appended.length).toBe(1);
    expect(synced.length).toBe(1);
    expect(notified).toEqual(["line:c1"]);
  });

  test("same message id in two different chats: both land (F16)", () => {
    const { appended, synced, notified, deps } = makeDeps();
    const landEvent = makeLandEvent(deps);

    const inChat = (chatId: string) =>
      makeEvent({ platform: "telegram", platform_message_id: "20445", chat: { platform_id: chatId, type: "direct" } });

    expect(landEvent(inChat("chat_A"))).toBe(true);
    expect(landEvent(inChat("chat_B"))).toBe(true);

    expect(appended.length).toBe(2);
    expect(synced.length).toBe(2);
    expect(notified).toEqual(["telegram:chat_A", "telegram:chat_B"]);
  });

  test("same message id in the same chat still dedupes (F16 must not widen the key too far)", () => {
    const { appended, deps } = makeDeps();
    const landEvent = makeLandEvent(deps);

    const evt = makeEvent({ platform: "telegram", platform_message_id: "20445", chat: { platform_id: "chat_A", type: "direct" } });
    expect(landEvent(evt)).toBe(true);
    expect(landEvent(evt)).toBe(false);
    expect(appended.length).toBe(1);
  });

  test("restores the key when JSONL append throws, and rethrows", () => {
    const { deps } = makeDeps({ appendThrows: true });
    const landEvent = makeLandEvent(deps);

    expect(() => landEvent(makeEvent())).toThrow("jsonl boom");
    // key 必須被復原，否則這則訊息永久消失
    expect(() => landEvent(makeEvent())).toThrow("jsonl boom");
  });

  test("keeps the key when SQLite sync throws, and still returns true", () => {
    const { appended, notified, deps } = makeDeps({ syncThrows: true });
    const landEvent = makeLandEvent(deps);

    expect(landEvent(makeEvent())).toBe(true);
    expect(appended.length).toBe(1);
    expect(notified.length).toBe(1);
    // key 保留：另一條路徑再來時必須被擋掉，否則 JSONL 會有兩行
    expect(landEvent(makeEvent())).toBe(false);
    expect(appended.length).toBe(1);
  });

  test("notifies subscribers for every event that changes stored state", () => {
    const { appended, notified, deps } = makeDeps();
    const landEvent = makeLandEvent(deps);

    expect(landEvent(makeEvent({ type: "unsend", platform_message_id: "u1" }))).toBe(true);
    expect(landEvent(makeEvent({ type: "edit", platform_message_id: "e1" }))).toBe(true);
    expect(landEvent(makeEvent({ platform_message_id: "m9" }))).toBe(true);

    expect(notified).toEqual(["line:c1", "line:c1", "line:c1"]);
    expect(appended.length).toBe(3);
  });

  test("does not notify subscribers for read_receipt", () => {
    const { notified, deps } = makeDeps();
    const landEvent = makeLandEvent(deps);

    expect(landEvent(makeEvent({ type: "read_receipt", platform_message_id: "r1" }))).toBe(true);
    expect(notified).toEqual([]);
  });

  test("consecutive edits of the same message all land (streaming bot)", () => {
    const { appended, notified, deps } = makeDeps();
    const landEvent = makeLandEvent(deps);

    // 串流 bot 在 60s TTL 窗口內反覆編輯同一則訊息；dedup 只該防 message 的雙路徑回吐
    for (let i = 0; i < 5; i++) {
      expect(
        landEvent(makeEvent({ type: "edit", platform_message_id: "4484", content: { type: "text", text: `chunk ${i}` } })),
      ).toBe(true);
    }

    expect(appended.length).toBe(5);
    expect(notified.length).toBe(5);
  });

  test("repeated unsends of the same message are not swallowed by dedup", () => {
    const { appended, deps } = makeDeps();
    const landEvent = makeLandEvent(deps);

    expect(landEvent(makeEvent({ type: "unsend", platform_message_id: "777" }))).toBe(true);
    expect(landEvent(makeEvent({ type: "unsend", platform_message_id: "777" }))).toBe(true);

    // 落地兩行是可接受的代價：套用是冪等的，SQLite 結果不變
    expect(appended.length).toBe(2);
  });

  test("an unsend is not shadowed by the message it retracts", () => {
    const { appended, notified, deps } = makeDeps();
    const landEvent = makeLandEvent(deps);

    // Telegram 的 unsend 重用被收回訊息的 ID，兩者在同一個 60s TTL 窗口內
    expect(landEvent(makeEvent({ platform: "telegram", platform_message_id: "999" }))).toBe(true);
    expect(
      landEvent(makeEvent({ type: "unsend", platform: "telegram", platform_message_id: "999" })),
    ).toBe(true);

    expect(appended.length).toBe(2);
    expect(notified.length).toBe(2);
  });

  test("treats different platform_message_id as distinct events", () => {
    const { appended, deps } = makeDeps();
    const landEvent = makeLandEvent(deps);

    expect(landEvent(makeEvent({ platform_message_id: "m1" }))).toBe(true);
    expect(landEvent(makeEvent({ platform_message_id: "m2" }))).toBe(true);
    expect(appended.length).toBe(2);
  });
});
