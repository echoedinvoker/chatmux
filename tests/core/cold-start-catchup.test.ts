import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { initSchema, syncEventToSQLite } from "../../src/core/storage/sqlite";
import {
  catchUpAdapter,
  PER_CHAT_BATCH,
  MAX_CATCHUP_BATCHES,
  type CatchupDeps,
} from "../../src/core/cold-start-catchup";
import type { JsonlEvent } from "../../src/core/storage/jsonl";

const T0 = 1_784_000_000_000;

function insertChat(db: Database, platformId: string, lastActivityAt: number | null = null): number {
  db.prepare(
    "INSERT INTO chats (platform, platform_id, type, name, last_activity_at) VALUES ('line', ?, 'direct', ?, ?)"
  ).run(platformId, platformId, lastActivityAt);
  return db.query<{ id: number }, [string]>(
    "SELECT id FROM chats WHERE platform = 'line' AND platform_id = ?"
  ).get(platformId)!.id;
}

function insertMessage(db: Database, chatId: number, platformMessageId: string, timestamp: number): void {
  db.prepare(`
    INSERT INTO messages
      (platform, platform_message_id, chat_id, timestamp, content_type, content_text, source, seq)
    VALUES ('line', ?, ?, ?, 'text', ?, 'backfill', (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages))
  `).run(platformMessageId, chatId, timestamp, platformMessageId);
}

function makeEvent(chatPlatformId: string, id: string, timestamp: number): JsonlEvent {
  return {
    type: "message",
    platform: "line",
    platform_message_id: id,
    chat: { platform_id: chatPlatformId, type: "direct" },
    sender: { platform_id: "u_peer", display_name: "peer" },
    timestamp,
    content: { type: "text", text: id },
    raw: {},
    source: "backfill",
  };
}

interface BackfillRequest {
  chat_id: string;
  before_timestamp: number;
  before_message_id?: string;
  count: number;
}

/**
 * Stands in for the LINE adapter's paging semantics (see 背景知識三):
 * - no before_message_id → the platform's newest `count` messages (messageBoxes fallback)
 * - with before_message_id → the `count` messages immediately older than that anchor
 */
function makeAdapter(timeline: Map<string, JsonlEvent[]>) {
  const requests: BackfillRequest[] = [];

  const sendRequest = async (_platform: string, method: string, params: unknown) => {
    expect(method).toBe("backfill");
    const p = params as BackfillRequest;
    requests.push(p);

    const all = timeline.get(p.chat_id) ?? [];
    const ascending = [...all].sort((a, b) => a.timestamp - b.timestamp);

    let end = ascending.length;
    if (p.before_message_id != null) {
      const idx = ascending.findIndex((e) => e.platform_message_id === p.before_message_id);
      end = idx === -1 ? ascending.length : idx;
    }
    const start = Math.max(0, end - p.count);
    return { events: ascending.slice(start, end), has_more: start > 0 };
  };

  return { requests, sendRequest };
}

describe("cold start catch-up loop", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
  });

  test("keeps paging until the batch reaches back to the newest known message", async () => {
    const chatId = insertChat(db, "c_gap", T0 + 200_000);
    // 已知的最新一則：catch-up 要往回接到這裡為止
    insertMessage(db, chatId, "m_000", T0);

    // 平台上有 120 則比它更新的訊息（停機期間抵達）
    const timeline = [makeEvent("c_gap", "m_000", T0)];
    for (let i = 1; i <= 120; i++) {
      timeline.push(makeEvent("c_gap", `m_${String(i).padStart(3, "0")}`, T0 + i * 1000));
    }

    const adapter = makeAdapter(new Map([["c_gap", timeline]]));
    const ingested: JsonlEvent[] = [];
    const deps: CatchupDeps = {
      db,
      sendRequest: adapter.sendRequest,
      // 真的投影進 SQLite，而不是只收進陣列 —— 「拉回來了」與「落地了」是兩件事
      ingest: (_platform, event) => {
        ingested.push(event as JsonlEvent);
        syncEventToSQLite(db, event as JsonlEvent);
      },
      log: () => {},
    };

    const results = await catchUpAdapter(deps, "line");

    // 120 則洞 ÷ 每批 50 ⇒ 三批才接得上
    expect(adapter.requests.length).toBe(3);
    expect(adapter.requests[0]!.count).toBe(PER_CHAT_BATCH);

    // batch 1 不帶 anchor（讓 adapter 走 messageBoxes fallback 取最新）
    expect("before_message_id" in adapter.requests[0]!).toBe(false);
    // batch 2+ 必須帶真實 anchor，否則永遠拉回同一批（背景知識三第 2 點）
    expect(adapter.requests[1]!.before_message_id).toBe("m_071");
    expect(adapter.requests[2]!.before_message_id).toBe("m_021");

    // 停機期間的 120 則全部落地
    const landedIds = new Set(ingested.map((e) => e.platform_message_id));
    for (let i = 1; i <= 120; i++) {
      expect(landedIds.has(`m_${String(i).padStart(3, "0")}`)).toBe(true);
    }

    // 已知的 m_000 + 停機期間的 120 則
    const rows = db.query<{ c: number }, [number]>(
      "SELECT count(*) c FROM messages WHERE chat_id = ?"
    ).get(chatId)!;
    expect(rows.c).toBe(121);

    // 補齊了就不該留下未閉合的記錄
    expect(results[0]!.outcome).toBe("joined");
  });

  // 洞大過每室批次上限：必須停下並「記下來」，不能靜默當作補完了
  test("a hole larger than MAX_CATCHUP_BATCHES stops and is recorded as gap-not-closed(max-batches)", async () => {
    const chatId = insertChat(db, "c_huge", T0 + 900_000);
    insertMessage(db, chatId, "h_000", T0);

    const timeline = [makeEvent("c_huge", "h_000", T0)];
    for (let i = 1; i <= 500; i++) {
      timeline.push(makeEvent("c_huge", `h_${String(i).padStart(3, "0")}`, T0 + i * 1000));
    }

    const adapter = makeAdapter(new Map([["c_huge", timeline]]));
    const results = await catchUpAdapter(
      { db, sendRequest: adapter.sendRequest, ingest: () => {}, log: () => {}, now: () => T0 + 500 },
      "line",
    );

    expect(adapter.requests.length).toBe(MAX_CATCHUP_BATCHES);
    expect(results[0]!.outcome).toBe("gap-not-closed");
    expect(results[0]!.reason).toBe("max-batches");
    expect(
      db.query<{ catchup_state: string | null }, []>(
        "SELECT catchup_state FROM chats WHERE platform_id = 'c_huge'"
      ).get()!.catchup_state
    ).toBe("gap-not-closed:max-batches");
  });

  // catch-up 的定義是「接上已知的最新」。沒有已知就沒有要接的東西 —— 那是 on-demand
  // 歷史路徑的工作，不是這裡的（誠實性約束 #1）。
  test("skips a chat that has no messages at all — zero backfill requests", async () => {
    insertChat(db, "c_empty", T0 + 200_000);

    const adapter = makeAdapter(new Map([["c_empty", [makeEvent("c_empty", "m_x", T0)]]]));
    const deps: CatchupDeps = {
      db,
      sendRequest: adapter.sendRequest,
      ingest: () => {},
      log: () => {},
    };

    await catchUpAdapter(deps, "line");

    expect(adapter.requests.length).toBe(0);
  });

  // 預算只夠服務少數室，所以順序決定誰被補到。`last_activity_at > last_message_at`
  // 是「這室有洞」的信號，比單純的「最近活躍」精確。
  test("serves chats with a gap signal before merely-recent chats", async () => {
    // 沒洞但最近活躍：last_message_at 追上 last_activity_at
    const recent = insertChat(db, "c_recent", T0 + 900_000);
    db.prepare("UPDATE chats SET last_message_at = ? WHERE id = ?").run(T0 + 900_000, recent);
    insertMessage(db, recent, "r_000", T0 + 900_000);

    // 有洞但活躍時間較舊
    const gap = insertChat(db, "c_gap", T0 + 100_000);
    db.prepare("UPDATE chats SET last_message_at = ? WHERE id = ?").run(T0, gap);
    insertMessage(db, gap, "g_000", T0);

    const timeline = new Map([
      ["c_recent", [makeEvent("c_recent", "r_000", T0 + 900_000)]],
      ["c_gap", [makeEvent("c_gap", "g_000", T0)]],
    ]);
    const adapter = makeAdapter(timeline);
    const deps: CatchupDeps = {
      db,
      sendRequest: adapter.sendRequest,
      ingest: () => {},
      log: () => {},
    };

    await catchUpAdapter(deps, "line");

    expect(adapter.requests.map((r) => r.chat_id)).toEqual(["c_gap", "c_recent"]);
  });

  // 約束 #2 的兜底：外層預算耗盡若裸 break，「還沒輪到就沒了」的洞不會出現在任何查詢裡，
  // K1 會把「沒被嘗試」誤讀成「沒有洞」。
  test("records chats the budget never reached as gap-not-closed(budget-exhausted)", async () => {
    const timeline = new Map<string, JsonlEvent[]>();

    // 前面幾室各自有巨大的洞，足以吃光 GLOBAL_TARGET
    for (let c = 0; c < 4; c++) {
      const id = `c_hog_${c}`;
      const chatId = insertChat(db, id, T0 + 900_000 - c);
      db.prepare("UPDATE chats SET last_message_at = ? WHERE id = ?").run(T0, chatId);
      insertMessage(db, chatId, `${id}_000`, T0);

      const events = [makeEvent(id, `${id}_000`, T0)];
      for (let i = 1; i <= 400; i++) {
        events.push(makeEvent(id, `${id}_${String(i).padStart(3, "0")}`, T0 + i * 1000));
      }
      timeline.set(id, events);
    }

    // 排在最後、預算輪不到它的有洞室
    const starved = insertChat(db, "c_starved", T0 + 1_000);
    db.prepare("UPDATE chats SET last_message_at = ? WHERE id = ?").run(T0, starved);
    insertMessage(db, starved, "s_000", T0);
    timeline.set("c_starved", [makeEvent("c_starved", "s_000", T0)]);

    const adapter = makeAdapter(timeline);
    const deps: CatchupDeps = {
      db,
      sendRequest: adapter.sendRequest,
      ingest: () => {},
      log: () => {},
    };

    const results = await catchUpAdapter(deps, "line");

    expect(adapter.requests.some((r) => r.chat_id === "c_starved")).toBe(false);

    const starvedResult = results.find((r) => r.chatPlatformId === "c_starved");
    expect(starvedResult).toBeDefined();
    expect(starvedResult!.outcome).toBe("gap-not-closed");
    expect(starvedResult!.reason).toBe("budget-exhausted");
  });
});

describe("catch-up outcome persistence", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
  });

  function readState(platformId: string) {
    return db.query<
      { catchup_state: string | null; catchup_checked_at: number | null; backfill_state: string | null },
      [string]
    >(
      "SELECT catchup_state, catchup_checked_at, backfill_state FROM chats WHERE platform = 'line' AND platform_id = ?"
    ).get(platformId)!;
  }

  // 誠實性約束 #3：batch 1 回空是「我們沒問對」（該室不在 messageBoxes 名單裡），
  // 不是「平台沒有」。寫成 exhausted 等於對使用者宣稱「你看到的就是全部」。
  test("an empty first batch is recorded as not-in-message-boxes, never exhausted", async () => {
    const chatId = insertChat(db, "c_invisible", T0 + 100_000);
    db.prepare("UPDATE chats SET last_message_at = ? WHERE id = ?").run(T0, chatId);
    insertMessage(db, chatId, "i_000", T0);

    // 平台對這室回空（不在 messageBoxes 內）
    const adapter = makeAdapter(new Map([["c_invisible", []]]));
    await catchUpAdapter(
      { db, sendRequest: adapter.sendRequest, ingest: () => {}, log: () => {}, now: () => T0 + 500 },
      "line",
    );

    const row = readState("c_invisible");
    expect(row.catchup_state).toBe("not-in-message-boxes");
    expect(row.catchup_checked_at).toBe(T0 + 500);
    // on-demand 路徑的欄位不可被 catch-up 覆寫
    expect(row.backfill_state).toBeNull();
  });

  test("a closed gap is recorded as joined", async () => {
    const chatId = insertChat(db, "c_ok", T0 + 100_000);
    db.prepare("UPDATE chats SET last_message_at = ? WHERE id = ?").run(T0, chatId);
    insertMessage(db, chatId, "o_000", T0);

    const timeline = [
      makeEvent("c_ok", "o_000", T0),
      makeEvent("c_ok", "o_001", T0 + 1000),
    ];
    const adapter = makeAdapter(new Map([["c_ok", timeline]]));
    await catchUpAdapter(
      { db, sendRequest: adapter.sendRequest, ingest: () => {}, log: () => {}, now: () => T0 + 500 },
      "line",
    );

    expect(readState("c_ok").catchup_state).toBe("joined");
  });

  // 分頁沒前進是 bug，預算不夠是容量問題。混成一類會讓「迴圈根本沒在前進」偽裝成「洞太大」。
  test("a non-advancing pager is recorded as gap-stalled, not gap-not-closed", async () => {
    const chatId = insertChat(db, "c_stall", T0 + 100_000);
    db.prepare("UPDATE chats SET last_message_at = ? WHERE id = ?").run(T0, chatId);
    insertMessage(db, chatId, "s_000", T0);

    // adapter 忽略 anchor，永遠回同一批最新的
    const newest = [
      makeEvent("c_stall", "s_010", T0 + 10_000),
      makeEvent("c_stall", "s_011", T0 + 11_000),
    ];
    const sendRequest = async () => ({ events: newest, has_more: true });

    const results = await catchUpAdapter(
      { db, sendRequest, ingest: () => {}, log: () => {}, now: () => T0 + 500 },
      "line",
    );

    expect(results[0]!.outcome).toBe("gap-stalled");
    // 第 2 輪就停 —— 不是跑滿 MAX_CATCHUP_BATCHES 再標成「洞太大」
    expect(results[0]!.batches).toBe(2);
    expect(readState("c_stall").catchup_state).toBe("gap-stalled");
  });
});

/**
 * The gap signal the ordering above relies on is only as fresh as `last_activity_at`, and that
 * column is refreshed exactly once per cold start by applyMessageBoxRecency. If the refresh ever
 * moved after the catch-up, the priority would silently be ordering on the PREVIOUS cold start's
 * view — a failure with no symptom other than serving the wrong rooms first.
 *
 * Asserted against the source text because importing daemon.ts opens the real database and
 * spawns adapter subprocesses.
 */
describe("cold start call order (catch-up priority precondition)", () => {
  test("applyMessageBoxRecency refreshes last_activity_at before backfillAdapter runs", () => {
    const source = readFileSync(
      new URL("../../src/core/daemon.ts", import.meta.url),
      "utf-8",
    );

    const refresh = source.indexOf("applyMessageBoxRecency(db, platform, boxes)");
    const catchUp = source.indexOf("await backfillAdapter(platform)");

    expect(refresh).toBeGreaterThan(-1);
    expect(catchUp).toBeGreaterThan(-1);
    expect(refresh).toBeLessThan(catchUp);
  });
});
