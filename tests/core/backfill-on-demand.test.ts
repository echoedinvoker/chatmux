import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../../src/core/storage/sqlite";
import {
  needsBackfill,
  backfillChat,
  isInFlight,
  markInFlight,
  clearInFlight,
  __resetBackfillState,
  PARTIAL_COOLDOWN_MS,
  UNAVAILABLE_COOLDOWN_MS,
  MAX_CONCURRENT_BACKFILLS,
  RECENTLY_BACKFILLED_TTL_MS,
  type BackfillDeps,
} from "../../src/core/backfill-on-demand";
import { syncEventToSQLite } from "../../src/core/storage/sqlite";

const NOW = 1_784_000_000_000;

function makeChat(
  db: Database,
  platformId: string,
  state: string | null,
  attemptedAt: number | null = null
): string {
  db.prepare(
    "INSERT INTO chats (platform, platform_id, type, name, backfill_state, backfill_attempted_at) VALUES ('line', ?, 'direct', ?, ?, ?)"
  ).run(platformId, platformId, state, attemptedAt);
  return `line:${platformId}`;
}

describe("needsBackfill", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    __resetBackfillState();
  });

  test("unknown (NULL state) → true", () => {
    const chatId = makeChat(db, "c_null", null);
    expect(needsBackfill(db, chatId, NOW)).toBe(true);
  });

  // `unknown` is now also where a stalled anchored chat lands, so it needs a cooldown or
  // an open buffer would re-ask the platform on every push.
  test("unknown that was just attempted → false", () => {
    const chatId = makeChat(db, "c_stalled", null, NOW - 1000);
    expect(needsBackfill(db, chatId, NOW)).toBe(false);
  });

  test("unknown past the partial cooldown → true", () => {
    const chatId = makeChat(db, "c_stalled2", null, NOW - PARTIAL_COOLDOWN_MS - 1000);
    expect(needsBackfill(db, chatId, NOW)).toBe(true);
  });

  test("exhausted → false, no matter how long ago", () => {
    const chatId = makeChat(db, "c_done", "exhausted", NOW - UNAVAILABLE_COOLDOWN_MS * 10);
    expect(needsBackfill(db, chatId, NOW)).toBe(false);
  });

  test("unavailable within the 24h cooldown → false", () => {
    const chatId = makeChat(db, "c_gone", "unavailable", NOW - UNAVAILABLE_COOLDOWN_MS + 1000);
    expect(needsBackfill(db, chatId, NOW)).toBe(false);
  });

  test("unavailable past the 24h cooldown → true (the platform may have changed)", () => {
    const chatId = makeChat(db, "c_gone2", "unavailable", NOW - UNAVAILABLE_COOLDOWN_MS - 1000);
    expect(needsBackfill(db, chatId, NOW)).toBe(true);
  });

  test("partial within the cooldown → false", () => {
    const chatId = makeChat(db, "c_more", "partial", NOW - PARTIAL_COOLDOWN_MS + 1000);
    expect(needsBackfill(db, chatId, NOW)).toBe(false);
  });

  test("partial past the cooldown → true", () => {
    const chatId = makeChat(db, "c_more2", "partial", NOW - PARTIAL_COOLDOWN_MS - 1000);
    expect(needsBackfill(db, chatId, NOW)).toBe(true);
  });

  test("a chat already in flight → false (never two backfills for one chat)", () => {
    const chatId = makeChat(db, "c_busy", null);
    markInFlight(chatId);

    expect(isInFlight(chatId)).toBe(true);
    expect(needsBackfill(db, chatId, NOW)).toBe(false);

    clearInFlight(chatId);
    expect(needsBackfill(db, chatId, NOW)).toBe(true);
  });

  test("global concurrency cap → false while other chats saturate it", () => {
    const chatId = makeChat(db, "c_waiting", null);
    for (let i = 0; i < MAX_CONCURRENT_BACKFILLS; i++) {
      markInFlight(makeChat(db, `c_other${i}`, null));
    }

    expect(needsBackfill(db, chatId, NOW)).toBe(false);
  });

  test("an unknown chat id → false (nothing to anchor on)", () => {
    expect(needsBackfill(db, "line:c_not_in_db", NOW)).toBe(false);
  });
});

function makeEvent(platformId: string, messageId: string, timestamp: number) {
  return {
    type: "message",
    platform: "line",
    platform_message_id: messageId,
    chat: { platform_id: platformId, type: "direct", name: platformId },
    sender: { platform_id: "u_friend", display_name: "Friend" },
    timestamp,
    content: { type: "text", text: `msg ${messageId}` },
    raw: {},
    source: "backfill",
  };
}

function makeDeps(
  db: Database,
  reply: (params: any) => { events: unknown[]; has_more: boolean } | Promise<never>,
  notified: string[]
): BackfillDeps & { calls: any[] } {
  const calls: any[] = [];
  return {
    db,
    calls,
    async sendRequest(_platform, _method, params) {
      calls.push(params);
      return reply(params);
    },
    ingest(_platform, event) {
      syncEventToSQLite(db, event as any);
      return "landed";
    },
    notify(chatId) {
      notified.push(chatId);
    },
    now: () => NOW,
    log: () => {},
  };
}

describe("backfillChat state machine", () => {
  let db: Database;
  let notified: string[];

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    __resetBackfillState();
    notified = [];
  });

  function stateOf(platformId: string) {
    return db
      .query<{ backfill_state: string | null; backfill_attempted_at: number | null }, [string]>(
        "SELECT backfill_state, backfill_attempted_at FROM chats WHERE platform_id = ?"
      )
      .get(platformId)!;
  }

  test("no anchor and nothing returned → unavailable (the platform declines)", async () => {
    const chatId = makeChat(db, "c_empty", null);

    await backfillChat(makeDeps(db, () => ({ events: [], has_more: false }), notified), chatId);

    expect(stateOf("c_empty").backfill_state).toBe("unavailable");
    expect(notified).toEqual([chatId]);
  });

  test("older messages arrive with has_more → partial", async () => {
    const chatId = makeChat(db, "c_more", null);

    await backfillChat(
      makeDeps(
        db,
        () => ({
          events: [makeEvent("c_more", "m_100", 1000), makeEvent("c_more", "m_101", 2000)],
          has_more: true,
        }),
        notified
      ),
      chatId
    );

    expect(stateOf("c_more").backfill_state).toBe("partial");
    expect(notified).toEqual([chatId]);
  });

  test("older messages arrive without has_more → exhausted", async () => {
    const chatId = makeChat(db, "c_done", null);

    await backfillChat(
      makeDeps(db, () => ({ events: [makeEvent("c_done", "m_1", 1000)], has_more: false }), notified),
      chatId
    );

    expect(stateOf("c_done").backfill_state).toBe("exhausted");
  });

  // One call cannot tell "the chat bottoms out here" from "the platform withheld the
  // rest": both come back as the anchor echoed with nothing older. Claiming `exhausted`
  // picks one and shows the user "this is everything" — the exact lie this feature exists
  // to remove. So we claim nothing.
  test("an anchored chat that returns only the anchor → unknown, never exhausted", async () => {
    const chatId = makeChat(db, "c_bottom", null);
    syncEventToSQLite(db, makeEvent("c_bottom", "m_only", 5000) as any);

    await backfillChat(
      makeDeps(
        db,
        () => ({ events: [makeEvent("c_bottom", "m_only", 5000)], has_more: false }),
        notified
      ),
      chatId
    );

    expect(stateOf("c_bottom").backfill_state).toBe("unknown");
    // Nothing landed and nothing was learned — pushing would only restart the loop.
    expect(notified).toEqual([]);
  });

  test("a chat with no anchor at all still reports unavailable", async () => {
    const chatId = makeChat(db, "c_void", null);

    await backfillChat(
      makeDeps(db, () => ({ events: [], has_more: false }), notified),
      chatId
    );

    expect(stateOf("c_void").backfill_state).toBe("unavailable");
  });

  test("exhausted still means exhausted when history actually moved", async () => {
    const chatId = makeChat(db, "c_walked", null);
    syncEventToSQLite(db, makeEvent("c_walked", "m_9", 9000) as any);

    await backfillChat(
      makeDeps(
        db,
        () => ({ events: [makeEvent("c_walked", "m_1", 1000)], has_more: false }),
        notified
      ),
      chatId
    );

    expect(stateOf("c_walked").backfill_state).toBe("exhausted");
  });

  test("a request that throws never writes unavailable — only the attempt time moves", async () => {
    const chatId = makeChat(db, "c_offline", null);

    await backfillChat(
      makeDeps(db, () => Promise.reject(new Error("adapter not connected")), notified),
      chatId
    );

    const row = stateOf("c_offline");
    expect(row.backfill_state).toBeNull();
    expect(row.backfill_attempted_at).toBe(NOW);
    expect(notified).toEqual([]);
  });

  test("a failed attempt releases the in-flight slot", async () => {
    const chatId = makeChat(db, "c_offline2", null);

    await backfillChat(
      makeDeps(db, () => Promise.reject(new Error("boom")), notified),
      chatId
    );

    expect(isInFlight(chatId)).toBe(false);
  });

  test("the request carries the real anchor of that chat", async () => {
    const chatId = makeChat(db, "c_anchor", null);
    syncEventToSQLite(db, makeEvent("c_anchor", "623300721831838042", 7000) as any);
    const deps = makeDeps(db, () => ({ events: [], has_more: false }), notified);

    await backfillChat(deps, chatId);

    expect(deps.calls[0].chat_id).toBe("c_anchor");
    expect(deps.calls[0].before_message_id).toBe("623300721831838042");
    expect(deps.calls[0].count).toBe(50);
  });
});

describe("backfillChat idempotence and self-feeding", () => {
  let db: Database;
  let notified: string[];

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    __resetBackfillState();
    notified = [];
  });

  test("running twice over the same batch does not duplicate messages", async () => {
    const chatId = makeChat(db, "c_dup", null);
    const batch = [
      makeEvent("c_dup", "m_1", 1000),
      makeEvent("c_dup", "m_2", 2000),
      makeEvent("c_dup", "m_3", 3000),
    ];
    const deps = makeDeps(db, () => ({ events: batch, has_more: true }), notified);

    await backfillChat(deps, chatId);
    const afterFirst = db.query<{ n: number }, []>("SELECT count(*) n FROM messages").get()!.n;

    __resetBackfillState(); // let it through the self-feed guard on purpose
    await backfillChat(deps, chatId);
    const afterSecond = db.query<{ n: number }, []>("SELECT count(*) n FROM messages").get()!.n;

    expect(afterFirst).toBe(3);
    expect(afterSecond).toBe(3);
    expect(
      db
        .query(
          "SELECT platform_message_id, count(*) c FROM messages GROUP BY 1 HAVING count(*) > 1"
        )
        .all()
    ).toEqual([]);
  });

  test("the push a backfill triggers cannot trigger another backfill", async () => {
    const chatId = makeChat(db, "c_loop", null);
    let seq = 0;
    const deps = makeDeps(
      db,
      () => {
        seq++;
        return {
          events: Array.from({ length: 50 }, (_, i) =>
            makeEvent("c_loop", `m_${seq}_${i}`, 1_000_000 - seq * 1000 - i)
          ),
          has_more: true,
        };
      },
      notified
    );

    await backfillChat(deps, chatId);

    expect(deps.calls.length).toBe(1);
    expect(notified).toEqual([chatId]);
    // The consumer re-reads as a result of that push — the trigger must decline.
    expect(needsBackfill(db, chatId, NOW)).toBe(false);
    expect(needsBackfill(db, chatId, NOW + RECENTLY_BACKFILLED_TTL_MS - 1)).toBe(false);
  });

  test("a hanging adapter never delays the read that triggered it", async () => {
    const chatId = makeChat(db, "c_hang", null);
    const deps = makeDeps(db, () => new Promise<never>(() => {}), notified);

    const started = performance.now();
    void backfillChat(deps, chatId).catch(() => {});
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(100);
    expect(isInFlight(chatId)).toBe(true); // still running, and still holding its slot
  });

  test("after the TTL a partial chat may be backfilled again", async () => {
    const chatId = makeChat(db, "c_loop2", null);
    const deps = makeDeps(
      db,
      () => ({ events: [makeEvent("c_loop2", "m_a", 1000)], has_more: true }),
      notified
    );

    await backfillChat(deps, chatId);

    expect(needsBackfill(db, chatId, NOW + RECENTLY_BACKFILLED_TTL_MS + 1)).toBe(true);
  });
});
