import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../../src/core/storage/sqlite";
import { handleProbeLatest, type ProbeDeps } from "../../src/core/mcp/tools";

// F23 1.2b：H2 的 adapter 端反查探針。
// 目的是繞過 core 的 on-demand backfill（它 anchor 在最舊訊息、往回分頁，
// 抓不到「比最後落地訊息更新」的那則缺口訊息）。探針必須：
//   1. 送 backfill 且「不帶 before_message_id」→ adapter 端會 fallback 到
//      box.lastDeliveredMessageId，回該室最新 N 則（index.ts:286-299 既有行為）
//   2. 唯讀：原樣回傳 events，不呼叫 ingest（R12：Phase 1 全程不寫 DB）

function makeAdapterEvent(id: string, timestamp: number, contentType = "text") {
  return {
    type: "message",
    platform: "line",
    platform_message_id: id,
    chat: { platform_id: "c_probe", type: "direct" },
    sender: { platform_id: "u_friend" },
    timestamp,
    content: { type: contentType, ...(contentType === "text" ? { text: "hi" } : {}) },
    raw: {},
  };
}

function createDeps(
  db: Database,
  onRequest: (platform: string, method: string, params: any) => Promise<unknown>,
): ProbeDeps {
  return {
    db,
    sendRequest: onRequest,
  };
}

describe("probe_latest tool (F23 dev-only read-only probe)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
  });

  test("sends backfill WITHOUT before_message_id so the adapter returns the newest N", async () => {
    const calls: { method: string; params: any }[] = [];
    const deps = createDeps(db, async (_platform, method, params) => {
      calls.push({ method, params });
      return { events: [], has_more: false };
    });

    await handleProbeLatest(deps, { chat_id: "line:c_probe", count: 20 });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("backfill");
    expect(calls[0].params.chat_id).toBe("c_probe");
    expect(calls[0].params.count).toBe(20);
    // 關鍵斷言：缺席才會走 lastDeliveredMessageId fallback
    expect(calls[0].params.before_message_id).toBeUndefined();
  });

  test("returns the adapter events unchanged", async () => {
    const events = [
      makeAdapterEvent("m_old", 1784000000000),
      makeAdapterEvent("m_new", 1784786488132, "sticker"),
    ];
    const deps = createDeps(db, async () => ({ events, has_more: false }));

    const result = await handleProbeLatest(deps, { chat_id: "line:c_probe", count: 20 });

    expect(result.events).toEqual(events);
  });

  test("does NOT ingest — messages row count is unchanged (R12)", async () => {
    const events = [makeAdapterEvent("m_new", 1784786488132)];
    const deps = createDeps(db, async () => ({ events, has_more: false }));

    const before = db.query<{ n: number }, []>("SELECT count(*) AS n FROM messages").get()!.n;
    await handleProbeLatest(deps, { chat_id: "line:c_probe", count: 20 });
    const after = db.query<{ n: number }, []>("SELECT count(*) AS n FROM messages").get()!.n;

    expect(before).toBe(0);
    expect(after).toBe(0);
  });

  test("splits the composite chat id into platform + platform_id", async () => {
    const calls: { platform: string; params: any }[] = [];
    const deps = createDeps(db, async (platform, _method, params) => {
      calls.push({ platform, params });
      return { events: [], has_more: false };
    });

    await handleProbeLatest(deps, { chat_id: "line:u3c490b819d9cbc0fa75bfcc44817e2bf", count: 5 });

    expect(calls[0].platform).toBe("line");
    expect(calls[0].params.chat_id).toBe("u3c490b819d9cbc0fa75bfcc44817e2bf");
  });
});
