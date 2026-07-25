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

  test("treats different platform_message_id as distinct events", () => {
    const { appended, deps } = makeDeps();
    const landEvent = makeLandEvent(deps);

    expect(landEvent(makeEvent({ platform_message_id: "m1" }))).toBe(true);
    expect(landEvent(makeEvent({ platform_message_id: "m2" }))).toBe(true);
    expect(appended.length).toBe(2);
  });
});
