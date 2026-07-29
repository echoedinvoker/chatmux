import { describe, it, expect, beforeEach } from "bun:test";
import {
  ConnectionManager,
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
});
