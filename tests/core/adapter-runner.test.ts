import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import { AdapterProtocol, AdapterRunner } from "../../src/core/adapter-runner.js";
import type { AdapterRunnerConfig, SpawnResult } from "../../src/core/adapter-runner.js";

function createMockStreams() {
  const toAdapter = new PassThrough();
  const fromAdapter = new PassThrough();
  return { toAdapter, fromAdapter };
}

function writeLine(stream: PassThrough, obj: unknown) {
  stream.write(JSON.stringify(obj) + "\n");
}

describe("AdapterProtocol", () => {
  let protocol: AdapterProtocol;
  let toAdapter: PassThrough;
  let fromAdapter: PassThrough;

  beforeEach(() => {
    const streams = createMockStreams();
    toAdapter = streams.toAdapter;
    fromAdapter = streams.fromAdapter;
    protocol = new AdapterProtocol(toAdapter, fromAdapter);
  });

  afterEach(() => {
    protocol.destroy();
    toAdapter.destroy();
    fromAdapter.destroy();
  });

  describe("request/response", () => {
    it("sends a request and resolves with the response", async () => {
      const reqPromise = protocol.request("initialize", { data_dir: "/tmp", platform: "line" });

      // Simulate adapter writing response
      await new Promise((r) => setTimeout(r, 10));

      // Read what was written to toAdapter (core → adapter)
      const written = toAdapter.read();
      expect(written).not.toBeNull();
      const sent = JSON.parse(written!.toString().trim());
      expect(sent.jsonrpc).toBe("2.0");
      expect(sent.method).toBe("initialize");
      expect(sent.params).toEqual({ data_dir: "/tmp", platform: "line" });
      expect(typeof sent.id).toBe("number");

      // Write response back
      writeLine(fromAdapter, {
        jsonrpc: "2.0",
        id: sent.id,
        result: { platform: "line", can_send: true },
      });

      const result = await reqPromise;
      expect(result).toEqual({ platform: "line", can_send: true });
    });

    it("rejects on error response", async () => {
      const reqPromise = protocol.request("send_message", { chat_id: "c123", content: { type: "text", text: "hi" } });

      await new Promise((r) => setTimeout(r, 10));
      const written = toAdapter.read();
      const sent = JSON.parse(written!.toString().trim());

      writeLine(fromAdapter, {
        jsonrpc: "2.0",
        id: sent.id,
        error: { code: -32001, message: "recipient not found" },
      });

      await expect(reqPromise).rejects.toThrow("recipient not found");
    });

    it("matches responses to correct requests by id", async () => {
      const req1 = protocol.request("get_contacts", {});
      const req2 = protocol.request("get_chats", {});

      await new Promise((r) => setTimeout(r, 10));

      // Read both requests
      const data = toAdapter.read()!.toString();
      const lines = data.trim().split("\n").map((l: string) => JSON.parse(l));
      expect(lines.length).toBe(2);

      // Respond in reverse order
      writeLine(fromAdapter, {
        jsonrpc: "2.0",
        id: lines[1].id,
        result: { chats: [] },
      });
      writeLine(fromAdapter, {
        jsonrpc: "2.0",
        id: lines[0].id,
        result: { contacts: [{ platform_id: "u1" }] },
      });

      const [r1, r2] = await Promise.all([req1, req2]);
      expect(r1).toEqual({ contacts: [{ platform_id: "u1" }] });
      expect(r2).toEqual({ chats: [] });
    });
  });

  describe("notifications", () => {
    it("routes adapter notifications to listener", async () => {
      const events: unknown[] = [];
      protocol.onNotification("event", (params) => events.push(params));

      writeLine(fromAdapter, {
        jsonrpc: "2.0",
        method: "event",
        params: { type: "message", platform: "line", content: { type: "text", text: "hello" } },
      });

      await new Promise((r) => setTimeout(r, 20));
      expect(events.length).toBe(1);
      expect((events[0] as any).type).toBe("message");
    });

    it("routes different notification methods separately", async () => {
      const events: unknown[] = [];
      const statuses: unknown[] = [];
      protocol.onNotification("event", (params) => events.push(params));
      protocol.onNotification("status", (params) => statuses.push(params));

      writeLine(fromAdapter, {
        jsonrpc: "2.0",
        method: "event",
        params: { type: "message" },
      });
      writeLine(fromAdapter, {
        jsonrpc: "2.0",
        method: "status",
        params: { state: "connected" },
      });

      await new Promise((r) => setTimeout(r, 20));
      expect(events.length).toBe(1);
      expect(statuses.length).toBe(1);
    });

    it("ignores notifications with no registered listener", async () => {
      // Should not throw
      writeLine(fromAdapter, {
        jsonrpc: "2.0",
        method: "unknown_method",
        params: {},
      });

      await new Promise((r) => setTimeout(r, 20));
    });
  });

  describe("request timeout", () => {
    it("rejects if no response within timeout", async () => {
      const reqPromise = protocol.request("initialize", {}, { timeoutMs: 50 });
      await expect(reqPromise).rejects.toThrow(/timeout/i);
    });
  });
});

function createMockSpawn(opts?: {
  initializeResult?: unknown;
  crashAfterMs?: number;
  exitCode?: number;
}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;
  let exitHandler: ((code: number) => void) | null = null;
  let buf = "";

  const proc: SpawnResult = {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    kill: () => { killed = true; },
    onExit: (fn) => { exitHandler = fn; },
  };

  // Auto-respond to requests via raw data events
  // Uses setImmediate because Bun's readline doesn't process data written
  // synchronously within another stream's data handler
  stdin.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          const result = opts?.initializeResult ?? {
            platform: "line",
            supported_events: ["message"],
            can_send: true,
            can_backfill: true,
            platform_rate_limits: { send: { max: 5, window_seconds: 60 } },
          };
          setImmediate(() => stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n"));
        } else if (msg.method === "shutdown") {
          setImmediate(() => {
            stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
            setTimeout(() => exitHandler?.(0), 10);
          });
        }
      } catch {}
    }
  });

  if (opts?.crashAfterMs !== undefined) {
    setTimeout(() => {
      exitHandler?.(opts.exitCode ?? 1);
    }, opts.crashAfterMs);
  }

  return {
    proc,
    stdin,
    stdout,
    stderr,
    triggerExit: (code: number) => {
      exitHandler?.(code);
    },
    sendEvent: (params: unknown) => {
      stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "event", params }) + "\n");
    },
    isKilled: () => killed,
  };
}

describe("AdapterRunner", () => {
  it("spawns adapter, sends initialize, and receives capabilities", async () => {
    let spawnCalled = false;
    const mock = createMockSpawn();

    const runner = new AdapterRunner({
      command: ["node", "fake-adapter.js"],
      platform: "line",
      dataDir: "/tmp/test",
      spawn: () => {
        spawnCalled = true;
        return mock.proc;
      },
      crashTracker: { initialBackoffMs: 1, maxBackoffMs: 5, killThreshold: 5, stabilityMs: 50 },
    });

    await runner.start();
    expect(spawnCalled).toBe(true);
    expect(runner.capabilities).toEqual({
      platform: "line",
      supported_events: ["message"],
      can_send: true,
      can_backfill: true,
      platform_rate_limits: { send: { max: 5, window_seconds: 60 } },
    });

    await runner.stop();
  });

  it("routes event notifications from adapter", async () => {
    const mock = createMockSpawn();
    const events: unknown[] = [];

    const runner = new AdapterRunner({
      command: ["node", "fake-adapter.js"],
      platform: "line",
      dataDir: "/tmp/test",
      spawn: () => mock.proc,
      crashTracker: { initialBackoffMs: 1, maxBackoffMs: 5, killThreshold: 5, stabilityMs: 50 },
    });

    runner.onEvent((params) => events.push(params));
    await runner.start();

    mock.sendEvent({ type: "message", platform: "line", content: { type: "text", text: "hi" } });
    await new Promise((r) => setTimeout(r, 30));

    expect(events.length).toBe(1);
    expect((events[0] as any).content.text).toBe("hi");

    await runner.stop();
  });

  it("restarts adapter on crash with backoff", async () => {
    let spawnCount = 0;
    const mocks: ReturnType<typeof createMockSpawn>[] = [];

    const runner = new AdapterRunner({
      command: ["node", "fake-adapter.js"],
      platform: "line",
      dataDir: "/tmp/test",
      spawn: () => {
        spawnCount++;
        const mock = createMockSpawn();
        mocks.push(mock);
        return mock.proc;
      },
      crashTracker: { initialBackoffMs: 10, maxBackoffMs: 50, killThreshold: 5, stabilityMs: 100 },
    });

    await runner.start();
    expect(spawnCount).toBe(1);

    // Crash the adapter
    mocks[0]!.triggerExit(1);
    await new Promise((r) => setTimeout(r, 80));

    // Should have restarted
    expect(spawnCount).toBe(2);

    await runner.stop();
  });

  it("stops restarting after killThreshold consecutive crashes", async () => {
    let spawnCount = 0;
    let killCalled = false;

    const runner = new AdapterRunner({
      command: ["node", "fake-adapter.js"],
      platform: "line",
      dataDir: "/tmp/test",
      spawn: () => {
        spawnCount++;
        const mock = createMockSpawn({ crashAfterMs: 20 });
        return mock.proc;
      },
      crashTracker: { initialBackoffMs: 1, maxBackoffMs: 5, killThreshold: 3, stabilityMs: 1000 },
    });

    runner.onKill(() => { killCalled = true; });
    await runner.start();

    // Wait for crashes + restarts + kill
    await new Promise((r) => setTimeout(r, 500));

    expect(spawnCount).toBeLessThanOrEqual(4);
    expect(killCalled).toBe(true);
    expect(runner.isKilled).toBe(true);

    runner.destroy();
  });

  it("resets crash counter on successful start", async () => {
    let spawnCount = 0;
    let crashFirst = true;

    const runner = new AdapterRunner({
      command: ["node", "fake-adapter.js"],
      platform: "line",
      dataDir: "/tmp/test",
      spawn: () => {
        spawnCount++;
        if (crashFirst && spawnCount <= 2) {
          return createMockSpawn({ crashAfterMs: 20 }).proc;
        }
        crashFirst = false;
        return createMockSpawn().proc;
      },
      crashTracker: { initialBackoffMs: 1, maxBackoffMs: 5, killThreshold: 5, stabilityMs: 50 },
    });

    await runner.start();
    // Let it crash twice then stabilize; stability timer (50ms) resets counter
    await new Promise((r) => setTimeout(r, 300));

    expect(spawnCount).toBeGreaterThanOrEqual(3);
    expect(runner.isKilled).toBe(false);

    await runner.stop();
  });

  it("applies stricter platform rate limits to SafetyRail", async () => {
    const mock = createMockSpawn({
      initializeResult: {
        platform: "line",
        supported_events: ["message"],
        can_send: true,
        can_backfill: true,
        platform_rate_limits: { send: { max: 3, window_seconds: 60 } },
      },
    });

    const { SafetyRail } = await import("../../src/core/safety.js");
    const safetyRail = new SafetyRail({ initialBackoffMs: 1, maxBackoffMs: 5 });

    const runner = new AdapterRunner({
      command: ["node", "fake-adapter.js"],
      platform: "line",
      dataDir: "/tmp/test",
      spawn: () => mock.proc,
      crashTracker: { initialBackoffMs: 1, maxBackoffMs: 5, killThreshold: 5, stabilityMs: 50 },
      safetyRail,
    });

    await runner.start();

    // SafetyRail should now use 3/min (adapter's stricter limit)
    await safetyRail.rateLimiter.acquire();
    await safetyRail.rateLimiter.acquire();
    await safetyRail.rateLimiter.acquire();

    let resolved = false;
    safetyRail.rateLimiter.acquire().then(() => { resolved = true; });

    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false); // 4th should be queued (limit is 3)

    await runner.stop();
  });

  it("ignores platform rate limits looser than core default", async () => {
    const mock = createMockSpawn({
      initializeResult: {
        platform: "line",
        supported_events: ["message"],
        can_send: true,
        can_backfill: true,
        platform_rate_limits: { send: { max: 10, window_seconds: 60 } },
      },
    });

    const { SafetyRail } = await import("../../src/core/safety.js");
    const safetyRail = new SafetyRail({ initialBackoffMs: 1, maxBackoffMs: 5 });

    const runner = new AdapterRunner({
      command: ["node", "fake-adapter.js"],
      platform: "line",
      dataDir: "/tmp/test",
      spawn: () => mock.proc,
      crashTracker: { initialBackoffMs: 1, maxBackoffMs: 5, killThreshold: 5, stabilityMs: 50 },
      safetyRail,
    });

    await runner.start();

    // SafetyRail should still use 5/min (core default, stricter than adapter's 10)
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await safetyRail.rateLimiter.acquire();
    expect(Date.now() - t0).toBeLessThan(50);

    let resolved = false;
    safetyRail.rateLimiter.acquire().then(() => { resolved = true; });

    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false); // 6th should be queued (limit is 5)

    await runner.stop();
  });
});
