import { describe, it, expect, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import type { SpawnResult } from "../../src/core/adapter-runner.js";
import { AdapterManager } from "../../src/core/adapter-manager.js";
import type { AdapterConfig } from "../../src/core/config.js";

function createMockSpawn(platform: string, opts?: { crashAfterMs?: number }) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exitHandler: ((code: number) => void) | null = null;
  let killed = false;
  let buf = "";

  const proc: SpawnResult = {
    stdin,
    stdout,
    stderr,
    pid: 10000 + Math.floor(Math.random() * 10000),
    kill: () => { killed = true; },
    onExit: (fn) => { exitHandler = fn; },
  };

  stdin.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          setImmediate(() => stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            result: {
              platform,
              supported_events: ["message"],
              can_send: true,
              can_backfill: true,
            },
          }) + "\n"));
        } else if (msg.method === "shutdown") {
          setImmediate(() => {
            stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
            setTimeout(() => exitHandler?.(0), 10);
          });
        } else if (msg.method === "send_message") {
          setImmediate(() => stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            result: { message_id: `${platform}-msg-1`, timestamp: 1700000000000 },
          }) + "\n"));
        } else if (msg.method === "get_contacts") {
          setImmediate(() => stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            result: { contacts: [{ platform_id: `${platform}-user-1`, display_name: `${platform} User` }] },
          }) + "\n"));
        } else if (msg.method === "get_chats") {
          setImmediate(() => stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            result: { chats: [{ platform_id: `${platform}-chat-1`, type: "direct", name: `${platform} Chat` }] },
          }) + "\n"));
        } else {
          setImmediate(() => stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id, result: {},
          }) + "\n"));
        }
      } catch {}
    }
  });

  if (opts?.crashAfterMs !== undefined) {
    setTimeout(() => exitHandler?.(1), opts.crashAfterMs);
  }

  return {
    proc,
    stdout,
    triggerExit: (code: number) => exitHandler?.(code),
    sendEvent: (params: unknown) => {
      stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "event", params }) + "\n");
    },
    sendStatus: (state: string) => {
      stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "status", params: { state } }) + "\n");
    },
    isKilled: () => killed,
  };
}

describe("AdapterManager", () => {
  let manager: AdapterManager;

  afterEach(async () => {
    if (manager) await manager.shutdownAll();
  });

  it("spawns and initializes multiple adapters", async () => {
    const mockLine = createMockSpawn("line");
    const mockTelegram = createMockSpawn("telegram");

    const configs: AdapterConfig[] = [
      { platform: "line", command: ["node", "line-adapter.js"] },
      { platform: "telegram", command: ["python", "telegram-adapter.py"] },
    ];

    manager = new AdapterManager(configs, {
      spawn: (platform) => (cmd) => {
        if (platform === "line") return mockLine.proc;
        return mockTelegram.proc;
      },
    });

    await manager.startAll();

    const statuses = manager.getStatuses();
    expect(Object.keys(statuses)).toHaveLength(2);
    expect(statuses.line).toBeDefined();
    expect(statuses.telegram).toBeDefined();
  });

  it("routes send_message to the correct adapter by platform prefix", async () => {
    const mockLine = createMockSpawn("line");
    const mockTelegram = createMockSpawn("telegram");

    manager = new AdapterManager(
      [
        { platform: "line", command: ["node", "line.js"] },
        { platform: "telegram", command: ["python", "tg.py"] },
      ],
      {
        spawn: (platform) => (cmd) =>
          platform === "line" ? mockLine.proc : mockTelegram.proc,
      },
    );

    await manager.startAll();

    const lineResult = await manager.sendRequest("line", "send_message", {
      chat_id: "line:c123",
      content: { type: "text", text: "hello" },
    }) as any;
    expect(lineResult.message_id).toBe("line-msg-1");

    const tgResult = await manager.sendRequest("telegram", "send_message", {
      chat_id: "telegram:456",
      content: { type: "text", text: "hello" },
    }) as any;
    expect(tgResult.message_id).toBe("telegram-msg-1");
  });

  it("throws when routing to unknown platform", async () => {
    manager = new AdapterManager(
      [{ platform: "line", command: ["node", "line.js"] }],
      {
        spawn: () => () => createMockSpawn("line").proc,
      },
    );
    await manager.startAll();

    expect(() => manager.sendRequest("whatsapp", "send_message", {})).toThrow(/unknown platform/i);
  });

  it("one adapter crash does not affect another", async () => {
    const mockLine = createMockSpawn("line");
    const mockTelegram = createMockSpawn("telegram");

    manager = new AdapterManager(
      [
        { platform: "line", command: ["node", "line.js"] },
        { platform: "telegram", command: ["python", "tg.py"] },
      ],
      {
        spawn: (platform) => (cmd) =>
          platform === "line" ? mockLine.proc : mockTelegram.proc,
        crashTracker: { initialBackoffMs: 1, maxBackoffMs: 5, killThreshold: 5, stabilityMs: 50 },
      },
    );

    await manager.startAll();

    // Crash line adapter
    mockLine.triggerExit(1);
    await new Promise((r) => setTimeout(r, 50));

    // Telegram should still work
    const tgResult = await manager.sendRequest("telegram", "send_message", {
      chat_id: "telegram:456",
      content: { type: "text", text: "still alive" },
    }) as any;
    expect(tgResult.message_id).toBe("telegram-msg-1");
  });

  it("shutdown stops all adapters", async () => {
    const mockLine = createMockSpawn("line");
    const mockTelegram = createMockSpawn("telegram");

    manager = new AdapterManager(
      [
        { platform: "line", command: ["node", "line.js"] },
        { platform: "telegram", command: ["python", "tg.py"] },
      ],
      {
        spawn: (platform) => (cmd) =>
          platform === "line" ? mockLine.proc : mockTelegram.proc,
      },
    );

    await manager.startAll();
    await manager.shutdownAll();

    // Both should have received shutdown
    expect(mockLine.isKilled()).toBe(false); // graceful shutdown, not killed
    expect(mockTelegram.isKilled()).toBe(false);
  });

  it("forwards events from each adapter with platform tag", async () => {
    const mockLine = createMockSpawn("line");
    const mockTelegram = createMockSpawn("telegram");

    const events: Array<{ platform: string; params: unknown }> = [];

    manager = new AdapterManager(
      [
        { platform: "line", command: ["node", "line.js"] },
        { platform: "telegram", command: ["python", "tg.py"] },
      ],
      {
        spawn: (platform) => (cmd) =>
          platform === "line" ? mockLine.proc : mockTelegram.proc,
      },
    );

    manager.onEvent((platform, params) => events.push({ platform, params }));
    await manager.startAll();

    mockLine.sendEvent({ type: "message", content: { type: "text", text: "from line" } });
    mockTelegram.sendEvent({ type: "message", content: { type: "text", text: "from telegram" } });

    await new Promise((r) => setTimeout(r, 50));

    expect(events).toHaveLength(2);
    expect(events[0].platform).toBe("line");
    expect(events[1].platform).toBe("telegram");
  });

  it("tracks connected state per adapter via status notifications", async () => {
    const mockLine = createMockSpawn("line");
    const mockTelegram = createMockSpawn("telegram");

    manager = new AdapterManager(
      [
        { platform: "line", command: ["node", "line.js"] },
        { platform: "telegram", command: ["python", "tg.py"] },
      ],
      {
        spawn: (platform) => (cmd) =>
          platform === "line" ? mockLine.proc : mockTelegram.proc,
      },
    );

    await manager.startAll();

    mockLine.sendStatus("connected");
    await new Promise((r) => setTimeout(r, 30));

    const statuses = manager.getStatuses();
    expect(statuses.line.connected).toBe(true);
    expect(statuses.telegram.connected).toBe(false);

    mockTelegram.sendStatus("connected");
    await new Promise((r) => setTimeout(r, 30));

    const statuses2 = manager.getStatuses();
    expect(statuses2.telegram.connected).toBe(true);
  });
});
