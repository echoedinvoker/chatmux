import { describe, it, expect, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import type { SpawnResult } from "../../src/core/adapter-runner.js";
import { AdapterManager } from "../../src/core/adapter-manager.js";
import { makeIngestEvent } from "../../src/core/ingest.js";
import type { JsonlEvent } from "../../src/core/storage/jsonl.js";

function createMockSpawn(platform: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exitHandler: ((code: number) => void) | null = null;
  let buf = "";

  const proc: SpawnResult = {
    stdin,
    stdout,
    stderr,
    pid: 20000 + Math.floor(Math.random() * 10000),
    kill: () => {},
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
            result: { platform, supported_events: ["message", "unsend"], can_send: true, can_backfill: false },
          }) + "\n"));
        } else if (msg.method === "shutdown") {
          setImmediate(() => {
            stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
            setTimeout(() => exitHandler?.(0), 10);
          });
        } else {
          setImmediate(() => stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n"));
        }
      } catch {}
    }
  });

  return {
    proc,
    sendEvent: (params: unknown) => {
      stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "event", params }) + "\n");
    },
  };
}

describe("daemon live event path", () => {
  let manager: AdapterManager;

  afterEach(async () => {
    if (manager) await manager.shutdownAll();
  });

  it("a sender-less event does not produce an unhandled rejection and still lands", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on("unhandledRejection", onRejection);

    try {
      const landed: JsonlEvent[] = [];
      const ingest = makeIngestEvent({
        land: (e) => { landed.push(e); return true; },
        log: () => {},
      });

      const mock = createMockSpawn("telegram");
      manager = new AdapterManager(
        [{ platform: "telegram", command: ["python", "tg.py"] }],
        { spawn: () => () => mock.proc },
      );

      // daemon.ts 修好後的寫法：同步 handler，結構上不可能產生 promise
      const handler = (p: string, params: unknown) => { ingest(p, params, "live"); };
      expect(handler.constructor.name).not.toBe("AsyncFunction");
      manager.onEvent(handler);

      await manager.startAll();

      mock.sendEvent({
        type: "unsend",
        platform: "telegram",
        chat: { platform_id: "-100123" },
        content: { message_id: "999" },
        platform_message_id: "999",
        timestamp: 0,
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(rejections).toEqual([]);
      expect(landed.length).toBe(1);
      expect(landed[0]!.type).toBe("unsend");
      expect(landed[0]!.platform_message_id).toBe("999");
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
