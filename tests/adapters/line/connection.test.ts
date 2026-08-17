/**
 * Two fakes live in this file, and picking the wrong one silently voids the test.
 *
 * `createMockPushSource` models the *container* only: its `renew()` swaps in a
 * fresh ReadableStream, which is a faithful copy of `opStream.renew()`
 * (`@evex/linejs/base/push/connManager.ts:116-135`) — and of nothing else. It has
 * no notion of a *connection*, so inside it "swap the container" and "recover"
 * are the same event. In the real world they are not: `renew()` never touches the
 * socket, so the new container has nobody feeding it.
 *
 * Consequence: the three `markStreamDead` tests below (`markStreamDead() demotes
 * immediately and then reconnects` :341, `returns to connected on real stream
 * evidence...` :382, `recovers event flow after a suspend-triggered stream death`
 * :437 — line numbers as of 2026-08-17) are pass-through. They were green the
 * whole time F78 was happening on the user's machine: no new LINE messages for
 * minutes after a long suspend. Their greenness is not evidence that recovery
 * works.
 *
 * Anything asserting on *recovery* must therefore use `createConnAwarePushSource`,
 * which keeps container and connection apart.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  ConnectionManager,
  createPushSource,
  type PushSource,
  type ConnectionState,
  type ConnectionManagerOptions,
} from "../../../src/adapters/line/push.js";

const TEST_OPTS: ConnectionManagerOptions = {
  networkRetryMs: 10,
  streamRetryMs: 10,
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function createMockPushSource(options?: {
  initBehavior?: () => Promise<void>;
}) {
  let controller: ReadableStreamDefaultController<any> | null = null;
  let currentStream = new ReadableStream<any>({
    start(c) {
      controller = c;
    },
  });

  const source: PushSource = {
    get stream() {
      return currentStream;
    },
    renew() {
      currentStream = new ReadableStream<any>({
        start(c) {
          controller = c;
        },
      });
    },
    killConnection() {
      // No connection layer in this fake, so there is nothing to tear down —
      // which is exactly why nothing asserting on recovery may use it (header).
    },
    async initLegyPusher() {
      if (options?.initBehavior) {
        await options.initBehavior();
      } else {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    },
  };

  return Object.assign(source, {
    enqueue(event: any) {
      controller?.enqueue(event);
    },
    closeStream() {
      controller?.close();
      controller = null;
    },
    errorStream(err: Error) {
      controller?.error(err);
      controller = null;
    },
  });
}

type MockPushSource = ReturnType<typeof createMockPushSource>;

/**
 * Connection-aware push source fake: the one to use for anything about recovery.
 *
 * It separates the two layers `createMockPushSource` collapses:
 *   - the **container** (`opStream`). `renew()` swaps it and nothing else, so it
 *     never restores the flow of events.
 *   - the **connection**. Only building one restores the flow. Rebuilding is
 *     modelled as linejs's own `initLegyPusher()` while-loop does it: after a
 *     read fails, sleep `reconnectDelayMs`, then connect. There is exactly one
 *     rebuilder here, on purpose — that is the invariant under test.
 *
 * Simulated time is driven by the injected clock via `advanceTo()`; no real timer
 * is ever armed, so undici's real 300s h2 timeout costs the suite nothing. The
 * caller must move its own clock variable first, then call `advanceTo(t)` — the
 * `advance()` helper in each test does both.
 *
 * `connectCount` counts *rebuilds*: the fake is born with the connection the
 * process started with, so a healthy run that never dies leaves it at 0.
 */
function createConnAwarePushSource(opts: {
  h2TimeoutMs: number;
  reconnectDelayMs: number;
  now: () => number;
}) {
  let controller: ReadableStreamDefaultController<any> | null = null;

  function newStream() {
    return new ReadableStream<any>({
      start(c) {
        controller = c;
      },
    });
  }

  let currentStream = newStream();
  // A live connection is attached to `currentStream` and events can land.
  let feeding = true;
  // Mirrors `Conn.resStream` being assigned (`conn.ts:133`): the handshake is
  // done, so tearing the connection down is safe.
  let handshakeComplete = true;
  let connectCount = 0;
  let h2DeadlineAt: number | null = null;
  /**
   * How many `initLegyPusher()` while-loops exist. Each one rebuilds the
   * connection after a failed read, so two of them mean two LEGY connections for
   * one account — the outcome `T-EXACTLY-ONCE` exists to forbid. chatmux calling
   * `initLegyPusher()` a second time is what would produce that here, and in
   * production.
   */
  let rebuilders = 0;
  let pendingReconnects: number[] = [];

  function connect(): void {
    connectCount++;
    feeding = true;
    handshakeComplete = true;
  }

  /**
   * The parked read fails right now, and every rebuilder starts its sleep. A
   * second teardown while those sleeps are pending does *not* add more — the
   * same reason two `Conn.close()` calls produce one reconnect in reality.
   */
  function tearDown(at: number, err: Error): void {
    controller?.error(err);
    controller = null;
    feeding = false;
    h2DeadlineAt = null;
    if (pendingReconnects.length === 0) {
      for (let i = 0; i < rebuilders; i++) {
        pendingReconnects.push(at + opts.reconnectDelayMs);
      }
    }
  }

  return {
    get stream() {
      return currentStream;
    },
    renew() {
      // Swapping the container neither starts nor stops the feed: linejs's
      // writer closure (`connManager.ts:116-135`) keeps writing into whichever
      // controller is current. A live connection follows the swap; a dead one
      // stays dead, which is the whole point — `renew()` cannot recover anything.
      currentStream = newStream();
    },
    killConnection() {
      // R9 guard, mirrored: aborting mid-handshake produces an orphan rejection
      // that kills the adapter process. Skip this round instead.
      if (!handshakeComplete) return;
      tearDown(opts.now(), new Error("terminated"));
    },
    async initLegyPusher() {
      // Real shape: it goes in and never comes back — having first started the
      // while-loop that owns rebuilding.
      rebuilders++;
      // A second loop does not wait politely behind the first: its opening move
      // is `initializeConn()` with no sleep in front of it
      // (`@evex/linejs/base/polling/mod.ts:153-157`), so it builds another
      // connection there and then. The first call is the connection the process
      // was already running on, which is why it does not count as a rebuild.
      //
      // linejs's sticky `islisten` flag happens to short-circuit a second call
      // today, but the forbidden move is precisely to clear that flag to force a
      // rebuild, so the fake models the unguarded case on purpose.
      if (rebuilders > 1) connect();
      await new Promise<void>(() => {});
    },

    get connectCount() {
      return connectCount;
    },
    /** The host slept: the peer dropped us and nobody said so locally. */
    dieSilently() {
      feeding = false;
      handshakeComplete = true;
      h2DeadlineAt = opts.now() + opts.h2TimeoutMs;
    },
    /** Mid-handshake: `resStream` is not assigned yet. */
    setHandshakeComplete(done: boolean) {
      handshakeComplete = done;
    },
    enqueue(event: any) {
      if (!feeding) return;
      controller?.enqueue(event);
    },
    closeStream() {
      controller?.close();
      controller = null;
      feeding = false;
    },
    errorStream(err: Error) {
      controller?.error(err);
      controller = null;
      feeding = false;
    },
    advanceTo(t: number) {
      for (;;) {
        pendingReconnects.sort((a, b) => a - b);
        const timeoutDue = h2DeadlineAt !== null && h2DeadlineAt <= t;
        const reconnectDue =
          pendingReconnects.length > 0 && pendingReconnects[0]! <= t;
        if (!timeoutDue && !reconnectDue) return;
        if (
          timeoutDue &&
          (!reconnectDue || h2DeadlineAt! <= pendingReconnects[0]!)
        ) {
          tearDown(h2DeadlineAt!, new Error("terminated")); // undici's h2 timeout
        } else {
          pendingReconnects.shift();
          connect();
        }
      }
    },
  };
}

describe("ConnectionManager", () => {
  let push: MockPushSource;
  let conn: ConnectionManager;

  beforeEach(() => {
    push = createMockPushSource();
    conn = new ConnectionManager(push, TEST_OPTS);
  });

  it("receives events from the stream", async () => {
    const received: any[] = [];
    conn.onEvent((event) => {
      received.push(event);
    });

    conn.start();
    await sleep(10);

    push.enqueue({ type: "SEND_MESSAGE", text: "hello" });
    push.enqueue({ type: "RECEIVE_MESSAGE", text: "world" });
    await sleep(50);

    expect(received).toHaveLength(2);
    expect(received[0].text).toBe("hello");
    expect(received[1].text).toBe("world");

    conn.stop();
  });

  it("reconnects after stream timeout (close)", async () => {
    const states: ConnectionState[] = [];
    conn.onStateChange((s) => states.push(s));

    conn.start();
    await sleep(10);

    push.closeStream();
    await sleep(100);

    expect(states.includes("connected")).toBe(true);

    conn.stop();
  });

  it("auto-retries on network error without triggering onError", async () => {
    let callCount = 0;
    const networkError = new Error("fetch failed");
    (networkError as any).code = "ECONNREFUSED";

    const pushWithNetError = createMockPushSource({
      initBehavior: async () => {
        callCount++;
        if (callCount <= 2) throw networkError;
        await sleep(50);
      },
    });

    const errors: Error[] = [];
    const mgr = new ConnectionManager(pushWithNetError, TEST_OPTS);
    mgr.onError(async (err) => {
      errors.push(err);
    });

    mgr.start();
    await sleep(300);

    expect(errors).toHaveLength(0);
    expect(callCount).toBeGreaterThanOrEqual(3);

    mgr.stop();
  });

  it("reports server rejection (non-network error) via onError", async () => {
    let callCount = 0;
    const serverError = new Error("INVALID_TOKEN");

    const pushWithServerError = createMockPushSource({
      initBehavior: async () => {
        callCount++;
        if (callCount === 1) throw serverError;
        await sleep(50);
      },
    });

    const errors: Error[] = [];
    const mgr = new ConnectionManager(pushWithServerError, TEST_OPTS);
    mgr.onError(async (err) => {
      errors.push(err);
    });

    mgr.start();
    await sleep(200);

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("INVALID_TOKEN");

    mgr.stop();
  });

  it("retries after initializeConn failure", async () => {
    let callCount = 0;

    const pushWithInitFail = createMockPushSource({
      initBehavior: async () => {
        callCount++;
        if (callCount === 1) {
          const err = new Error("initializeConn failed");
          (err as any).code = "ECONNREFUSED";
          throw err;
        }
        await sleep(50);
      },
    });

    const mgr = new ConnectionManager(pushWithInitFail, TEST_OPTS);
    mgr.start();
    await sleep(300);

    expect(callCount).toBeGreaterThanOrEqual(2);

    mgr.stop();
  });

  it("stops all loops on abort", async () => {
    const received: any[] = [];
    conn.onEvent((event) => {
      received.push(event);
    });

    conn.start();
    await sleep(10);

    push.enqueue({ type: "BEFORE_STOP" });
    await sleep(50);
    expect(received).toHaveLength(1);

    conn.stop();
    await sleep(50);

    push.renew();
    push.enqueue({ type: "LATE_EVENT" });
    await sleep(50);

    expect(received).toHaveLength(1);
  });

  it("transitions state correctly: connected → reconnecting → connected", async () => {
    let callCount = 0;
    const pushWithTimeout = createMockPushSource({
      initBehavior: async () => {
        callCount++;
        if (callCount === 2) {
          const err = new Error("network timeout");
          (err as any).code = "ETIMEDOUT";
          throw err;
        }
        await sleep(50);
      },
    });

    const states: ConnectionState[] = [];
    const mgr = new ConnectionManager(pushWithTimeout, TEST_OPTS);
    mgr.onStateChange((s) => states.push(s));

    mgr.start();
    await sleep(400);

    expect(states[0]).toBe("connected");
    const reconnIdx = states.indexOf("reconnecting");
    expect(reconnIdx).toBeGreaterThan(0);
    const connAfterReconn = states.slice(reconnIdx + 1).includes("connected");
    expect(connAfterReconn).toBe(true);

    mgr.stop();
  });

  it("restart() rebuilds AbortController and restarts loops", async () => {
    const received: any[] = [];
    conn.onEvent((event) => {
      received.push(event);
    });

    conn.start();
    await sleep(10);

    push.enqueue({ type: "BEFORE_RESTART" });
    await sleep(50);

    conn.stop("killed");
    await sleep(50);

    conn.restart();
    await sleep(50);

    push.enqueue({ type: "AFTER_RESTART" });
    await sleep(50);

    expect(received.some((e) => e.type === "BEFORE_RESTART")).toBe(true);
    expect(received.some((e) => e.type === "AFTER_RESTART")).toBe(true);

    conn.stop();
  });

  it("awaits onError handler before retrying (backoff delay)", async () => {
    let callCount = 0;
    const timestamps: number[] = [];

    const pushWithError = createMockPushSource({
      initBehavior: async () => {
        callCount++;
        timestamps.push(Date.now());
        if (callCount <= 2) throw new Error("server error");
        await sleep(50);
      },
    });

    const mgr = new ConnectionManager(pushWithError, TEST_OPTS);
    mgr.onError(async () => {
      await sleep(100);
    });

    mgr.start();
    await sleep(500);

    if (timestamps.length >= 2) {
      const gap = timestamps[1]! - timestamps[0]!;
      expect(gap).toBeGreaterThanOrEqual(90);
    }

    mgr.stop();
  });

  it("sets state to 'killed' when stop('killed') is called", async () => {
    const states: ConnectionState[] = [];
    conn.onStateChange((s) => states.push(s));

    conn.start();
    await sleep(10);

    conn.stop("killed");
    await sleep(50);

    expect(states.includes("killed")).toBe(true);
    // `killed` is terminal: the consume loop unwinding afterwards must not
    // demote it back to `reconnecting`.
    expect(states.at(-1)).toBe("killed");
  });

  it("demotes to reconnecting when the stream dies, instead of silently renewing", async () => {
    // Real shape: initLegyPusher never resolves, so pushLoop cannot re-declare
    // connected. Recovery has to come from stream evidence.
    const realistic = createMockPushSource({
      initBehavior: () => new Promise<void>(() => {}),
    });
    const states: ConnectionState[] = [];
    const mgr = new ConnectionManager(realistic, TEST_OPTS);
    mgr.onStateChange((s) => states.push(s));

    mgr.start();
    await sleep(20);
    expect(states[0]).toBe("connected");

    realistic.errorStream(new Error("boom"));
    // errorStream() drops the controller, so the revival event has to wait for
    // consumeLoop to renew the stream before it has anywhere to land.
    await sleep(40);
    realistic.enqueue({ type: "SEND_MESSAGE", text: "revived" });
    await sleep(40);

    const reconnIdx = states.indexOf("reconnecting");
    expect(reconnIdx).toBeGreaterThan(0);
    expect(states.slice(reconnIdx + 1).includes("connected")).toBe(true);

    conn.stop();
  });

  it("markStreamDead() demotes immediately and then reconnects", async () => {
    const realistic = createMockPushSource({
      initBehavior: () => new Promise<void>(() => {}),
    });
    const states: ConnectionState[] = [];
    const mgr = new ConnectionManager(realistic, TEST_OPTS);
    mgr.onStateChange((s) => states.push(s));

    mgr.start();
    await sleep(20);
    expect(states.at(-1)).toBe("connected");

    mgr.markStreamDead("push-stream-failure");
    expect(states.at(-1)).toBe("reconnecting");

    await sleep(40);
    realistic.enqueue({ type: "SEND_MESSAGE", text: "revived" });
    await sleep(80);
    expect(states.at(-1)).toBe("connected");

    mgr.stop();
  });

  it("advances the liveness timestamp only on real evidence", async () => {
    let clock = 1_000_000;
    const mgr = new ConnectionManager(push, { ...TEST_OPTS, now: () => clock });

    mgr.start();
    await sleep(20);
    const afterConnect = mgr.lastLivenessEvidenceAt;

    clock = 2_000_000;
    push.enqueue({ type: "SEND_MESSAGE", text: "hi" });
    await sleep(40);

    expect(mgr.lastLivenessEvidenceAt).toBe(2_000_000);
    expect(afterConnect).not.toBe(2_000_000);

    mgr.stop();
  });

  it("returns to connected on real stream evidence, even when initLegyPusher never resolves", async () => {
    // Copy the real linejs shape: initLegyPusher goes in and never comes back.
    const realistic = createMockPushSource({
      initBehavior: () => new Promise<void>(() => {}),
    });
    const states: ConnectionState[] = [];
    const mgr = new ConnectionManager(realistic, TEST_OPTS);
    mgr.onStateChange((s) => states.push(s));

    mgr.start();
    await sleep(20);
    expect(states.at(-1)).toBe("connected");

    mgr.markStreamDead("suspend-gap");
    expect(states.at(-1)).toBe("reconnecting");

    await sleep(60);
    realistic.enqueue({ type: "SEND_MESSAGE", text: "back-alive" });
    await sleep(60);

    expect(states.at(-1)).toBe("connected");
    mgr.stop();
  });

  it("reports liveness on a throttle, so a steady stream does not spam core", async () => {
    let clock = 1_000_000;
    const reports: { state: ConnectionState; at: number | null }[] = [];
    const mgr = new ConnectionManager(push, {
      ...TEST_OPTS,
      now: () => clock,
      livenessReportMs: 30_000,
      onLivenessReport: (state, at) => reports.push({ state, at }),
    });

    mgr.start();
    await sleep(20);

    push.enqueue({ type: "SEND_MESSAGE", text: "a" });
    await sleep(20);
    push.enqueue({ type: "SEND_MESSAGE", text: "b" });
    await sleep(20);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.at).toBe(1_000_000);

    clock = 1_040_000; // past the throttle window
    push.enqueue({ type: "SEND_MESSAGE", text: "c" });
    await sleep(20);

    expect(reports).toHaveLength(2);
    expect(reports[1]!.at).toBe(1_040_000);
    expect(reports[1]!.state).toBe("connected");

    mgr.stop();
  });

  it("recovers event flow after a suspend-triggered stream death", async () => {
    const received: any[] = [];
    conn.onEvent((e) => received.push(e));
    conn.start();
    await sleep(20);

    conn.markStreamDead("suspend-gap");
    await sleep(120);

    push.enqueue({ type: "SEND_MESSAGE", text: "after-resume" });
    await sleep(60);

    expect(received.some((e) => e.text === "after-resume")).toBe(true);
    conn.stop();
  });

  it("does not hot-spin when initLegyPusher returns immediately (islisten sticky)", async () => {
    let calls = 0;
    const instant = createMockPushSource({
      initBehavior: async () => {
        calls++;
      },
    });
    const mgr = new ConnectionManager(instant, TEST_OPTS);
    mgr.start();
    await sleep(200);
    mgr.stop();

    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(50); // throttled; unguarded this is thousands
  });

  // T-RECOVERY-LATENCY — the F78 assertion. Uses the connection-aware fake, so
  // "the container was swapped" cannot pass for "the connection came back".
  it("T-RECOVERY-LATENCY: rebuilds the connection within 15s of a suspend-gap death", async () => {
    let clock = 1_000_000;
    const push = createConnAwarePushSource({
      h2TimeoutMs: 300_000, // undici's real h2 timeout
      reconnectDelayMs: 4_000, // linejs's sleep(4000) between rebuild attempts
      now: () => clock,
    });
    const advance = (to: number) => {
      clock = to;
      push.advanceTo(to);
    };

    const states: ConnectionState[] = [];
    const mgr = new ConnectionManager(push, { ...TEST_OPTS, now: () => clock });
    mgr.onStateChange((s) => states.push(s));

    mgr.start();
    await sleep(20);
    push.enqueue({ type: "SEND_MESSAGE", text: "before-sleep" });
    await sleep(20);
    expect(states.at(-1)).toBe("connected");

    // The host slept. Nothing errors locally: the peer is gone and the parked
    // read cannot know it until undici gives up, 300 simulated seconds away.
    push.dieSilently();
    mgr.markStreamDead("suspend-gap");
    await sleep(50);

    advance(1_015_000); // 15 simulated seconds later
    await sleep(50);

    expect(push.connectCount).toBe(1);

    push.enqueue({ type: "SEND_MESSAGE", text: "after-resume" });
    await sleep(30);
    expect(states.at(-1)).toBe("connected");

    mgr.stop();
  });

  // T-EXACTLY-ONCE — the sole-rebuilder invariant. chatmux only ever tears the
  // connection down; building it back belongs to linejs's `initLegyPusher()`
  // loop and to nothing else. Two rebuilders would mean two LEGY connections on
  // one account: no error, no log, just duplicated or reordered messages.
  it("T-EXACTLY-ONCE: two death declarations still rebuild the connection once", async () => {
    let clock = 1_000_000;
    const push = createConnAwarePushSource({
      h2TimeoutMs: 300_000,
      reconnectDelayMs: 4_000,
      now: () => clock,
    });
    const advance = (to: number) => {
      clock = to;
      push.advanceTo(to);
    };

    const mgr = new ConnectionManager(push, { ...TEST_OPTS, now: () => clock });
    mgr.start();
    await sleep(20);
    push.enqueue({ type: "SEND_MESSAGE", text: "before-sleep" });
    await sleep(20);

    push.dieSilently();
    // The suspend detector and the crash guard both notice the same death and
    // both call in. They are separate code paths and neither knows about the
    // other, so this ordering is the normal case, not an edge case.
    mgr.markStreamDead("suspend-gap");
    mgr.markStreamDead("push-stream-failure");
    await sleep(50);

    advance(1_015_000);
    await sleep(50);

    expect(push.connectCount).toBe(1);

    mgr.stop();
  });
});

/**
 * Contract test, not a behaviour test: it pins the interface chatmux depends on
 * inside linejs (`Conn.close()` at `@evex/linejs/base/push/conn.ts:312`, reached
 * through `client.base.push.conns[0]`). Asserting that a specific method gets
 * called is the point — if a linejs upgrade renames or drops it, this goes red
 * instead of F78 coming back silently. Do not delete it on the grounds that
 * behaviour tests should not assert on calls.
 */
describe("createPushSource().killConnection()", () => {
  function makeClient(conn?: unknown) {
    return {
      base: {
        createPolling: () => ({ initLegyPusher: async () => {} }),
        push: {
          opStream: {
            stream: new ReadableStream<any>({ start() {} }),
            renew() {},
          },
          conns: conn === undefined ? [] : [conn],
        },
      },
    } as any;
  }

  it("T-KILL-USES-CONN-CLOSE: tears the live connection down through Conn.close()", () => {
    let closed = 0;
    const source = createPushSource(
      makeClient({
        resStream: {},
        close: () => {
          closed++;
        },
      }),
    );

    source.killConnection();

    expect(closed).toBe(1);
  });

  it("T-KILL-USES-CONN-CLOSE: having no connection object left is not an error", () => {
    // Waking from suspend, `conns` can be empty; a throw here would surface
    // inside the suspend detector's tick, where nothing catches it.
    const source = createPushSource(makeClient());

    expect(() => source.killConnection()).not.toThrow();
  });

  it("T-KILL-USES-CONN-CLOSE: leaves a half-built connection alone (R9)", () => {
    // `resStream` unset means `Conn.new()`'s un-awaited fetch is still in
    // flight. Aborting it produces a rejection nobody catches, which the crash
    // guard rethrows — the adapter process dies. Skipping costs one round of
    // slower recovery; linejs's own loop retries a failed handshake anyway.
    let closed = 0;
    const source = createPushSource(
      makeClient({
        resStream: undefined,
        close: () => {
          closed++;
        },
      }),
    );

    source.killConnection();

    expect(closed).toBe(0);
  });
});
