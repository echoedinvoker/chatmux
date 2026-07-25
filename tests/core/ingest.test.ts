import { describe, test, expect } from "bun:test";
import { makeIngestEvent } from "../../src/core/ingest";
import type { JsonlEvent } from "../../src/core/storage/jsonl";

function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message",
    platform: "line",
    platform_message_id: "m1",
    chat: { platform_id: "c1", type: "direct" },
    sender: { platform_id: "u1", display_name: "Me" },
    timestamp: 1690000000000,
    content: { type: "text", text: "hi" },
    raw: {},
    ...overrides,
  };
}

// 真實 Telegram unsend payload（chatmux-adapter-telegram events.py:78-93）
// 無 sender、無 chat.type、無 raw、無 source、content 不是 message 形狀
function realUnsendPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "unsend",
    platform: "telegram",
    chat: { platform_id: "-100123" },
    content: { message_id: "999" },
    platform_message_id: "999",
    timestamp: 0,
    ...overrides,
  };
}

function makeIngestDeps(over: { landThrows?: string; landReturns?: boolean } = {}) {
  const landed: JsonlEvent[] = [];
  const logs: string[] = [];
  return {
    landed,
    logs,
    deps: {
      land: (e: JsonlEvent) => {
        if (over.landThrows) throw new Error(over.landThrows);
        landed.push(e);
        return over.landReturns ?? true;
      },
      log: (msg: string, ...rest: unknown[]) => {
        logs.push([msg, ...rest.map((r) => String(r))].join(" "));
      },
    },
  };
}

describe("ingestEvent — 畸形事件不炸、不影響同批其他事件", () => {
  test("真實 Telegram unsend payload：不拋出、落地、log 可讀", () => {
    const { landed, logs, deps } = makeIngestDeps();
    const ingest = makeIngestEvent(deps);

    let result: string | undefined;
    expect(() => {
      result = ingest("telegram", realUnsendPayload(), "live");
    }).not.toThrow();

    expect(result).toBe("landed");
    expect(landed.length).toBe(1);
    expect(landed[0]!.platform_message_id).toBe("999");
    // log 印得出被收回的 message id，不是 undefined
    expect(logs.join("\n")).toContain("999");
    expect(logs.join("\n")).not.toContain("undefined");
  });

  test("未知 type：前向相容，落地並 WARN", () => {
    const { landed, logs, deps } = makeIngestDeps();
    const ingest = makeIngestEvent(deps);

    let result: string | undefined;
    expect(() => {
      result = ingest("line", makeEvent({ type: "totally_unknown_type" }), "live");
    }).not.toThrow();

    expect(result).toBe("landed");
    expect(landed.length).toBe(1);
    const joined = logs.join("\n");
    expect(joined).toContain("WARN");
    expect(joined).toContain("totally_unknown_type");
  });

  test("message 缺 content：丟棄，不落地", () => {
    const { landed, logs, deps } = makeIngestDeps();
    const ingest = makeIngestEvent(deps);

    let result: string | undefined;
    expect(() => {
      result = ingest("line", makeEvent({ content: undefined }), "live");
    }).not.toThrow();

    expect(result).toBe("dropped");
    expect(landed.length).toBe(0);
    expect(logs.join("\n")).toContain("WARN");
  });

  test("message 缺 sender：丟棄，不落地", () => {
    const { landed, deps } = makeIngestDeps();
    const ingest = makeIngestEvent(deps);

    expect(ingest("line", makeEvent({ sender: undefined }), "live")).toBe("dropped");
    expect(landed.length).toBe(0);
  });

  test("message 有 sender 但 display_name 空：照常落地並 WARN", () => {
    const { landed, logs, deps } = makeIngestDeps();
    const ingest = makeIngestEvent(deps);

    expect(
      ingest("line", makeEvent({ sender: { platform_id: "u1", display_name: "" } }), "live"),
    ).toBe("landed");
    expect(landed.length).toBe(1);
    expect(logs.join("\n")).toContain("display_name");
  });

  test("同批：壞、好、壞 → 只有好的那則落地", () => {
    const { landed, deps } = makeIngestDeps();
    const ingest = makeIngestEvent(deps);

    const results = [
      ingest("line", makeEvent({ platform_message_id: "m1", content: undefined }), "backfill"),
      ingest("line", makeEvent({ platform_message_id: "m2" }), "backfill"),
      ingest("line", makeEvent({ platform_message_id: "m3", chat: {} }), "backfill"),
    ];

    expect(results).toEqual(["dropped", "landed", "dropped"]);
    expect(landed.length).toBe(1);
    expect(landed[0]!.platform_message_id).toBe("m2");
  });

  test("content 整個缺席的 unsend：log 失敗不改變已落地的事實", () => {
    const { landed, deps } = makeIngestDeps();
    const ingest = makeIngestEvent(deps);

    const result = ingest(
      "telegram",
      { type: "unsend", platform: "telegram", chat: { platform_id: "c1" }, platform_message_id: "777" },
      "live",
    );

    expect(result).toBe("landed");
    expect(landed.length).toBe(1);
    expect(landed[0]!.platform_message_id).toBe("777");
  });

  test("非 message 缺 chat.type：填 unknown；sender 缺席就讓它缺席", () => {
    const { landed, deps } = makeIngestDeps();
    const ingest = makeIngestEvent(deps);

    ingest("telegram", realUnsendPayload(), "live");

    expect(landed[0]!.chat.type).toBe("unknown");
    expect(landed[0]!.sender).toBeUndefined();
  });

  test("normalize：補上 source 與 received_at", () => {
    const { landed, deps } = makeIngestDeps();
    const ingest = makeIngestEvent(deps);

    ingest("telegram", realUnsendPayload(), "live");

    expect(landed[0]!.source).toBe("live");
    expect(typeof landed[0]!.received_at).toBe("number");
  });

  test("land 拋出：不外逸，回 error 並 log", () => {
    const { logs, deps } = makeIngestDeps({ landThrows: "land boom" });
    const ingest = makeIngestEvent(deps);

    let result: string | undefined;
    expect(() => {
      result = ingest("line", makeEvent(), "live");
    }).not.toThrow();

    expect(result).toBe("error");
    expect(logs.join("\n")).toContain("land boom");
  });

  test("land 回 false（已去重）：回 deduped", () => {
    const { deps } = makeIngestDeps({ landReturns: false });
    const ingest = makeIngestEvent(deps);

    expect(ingest("line", makeEvent(), "live")).toBe("deduped");
  });

  test("缺 platform_message_id：丟棄", () => {
    const { landed, deps } = makeIngestDeps();
    const ingest = makeIngestEvent(deps);

    expect(ingest("line", makeEvent({ platform_message_id: undefined }), "live")).toBe("dropped");
    expect(landed.length).toBe(0);
  });

  test("edit 事件：無 sender 也落地，log 指出被更新的訊息", () => {
    const { landed, logs, deps } = makeIngestDeps();
    const ingest = makeIngestEvent(deps);

    const payload = {
      type: "edit",
      platform: "telegram",
      platform_message_id: "4484",
      chat: { platform_id: "-100123" },
      timestamp: 1753450000000,
      content: { type: "text", text: "最終答案" },
    };

    expect(ingest("telegram", payload, "live")).toBe("landed");
    expect(landed[0]!.content.text).toBe("最終答案");
    expect(logs.some((l) => l.includes("edit: message 4484 updated"))).toBe(true);
  });

  test("edit 缺 content.text（媒體 caption 編輯）：丟棄且不呼叫 land", () => {
    const { landed, logs, deps } = makeIngestDeps();
    const ingest = makeIngestEvent(deps);

    const payload = {
      type: "edit",
      platform: "telegram",
      platform_message_id: "4485",
      chat: { platform_id: "-100123" },
      timestamp: 1753450000000,
      content: { type: "image", media_url: null },
    };

    expect(ingest("telegram", payload, "live")).toBe("dropped");
    expect(landed.length).toBe(0);
    expect(logs.some((l) => l.includes("dropped edit 4485"))).toBe(true);
  });

  test("edit 完全沒有 content：丟棄", () => {
    const { landed, deps } = makeIngestDeps();
    const ingest = makeIngestEvent(deps);

    expect(
      ingest(
        "telegram",
        { type: "edit", platform: "telegram", platform_message_id: "4486", chat: { platform_id: "-100123" } },
        "live",
      ),
    ).toBe("dropped");
    expect(landed.length).toBe(0);
  });

  test("params 不是物件：丟棄，不拋出", () => {
    const { landed, deps } = makeIngestDeps();
    const ingest = makeIngestEvent(deps);

    expect(() => ingest("line", null, "live")).not.toThrow();
    expect(ingest("line", "garbage", "live")).toBe("dropped");
    expect(landed.length).toBe(0);
  });
});
