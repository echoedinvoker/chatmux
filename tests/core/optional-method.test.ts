import { describe, it, expect, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import {
  AdapterProtocolError,
  isMethodNotFound,
  type SpawnResult,
} from "../../src/core/adapter-runner.js";
import { AdapterManager } from "../../src/core/adapter-manager.js";
import type { AdapterConfig } from "../../src/core/config.js";

/**
 * Fake adapter that declines a given method with a JSON-RPC error.
 * `declineWith` controls the exact error object returned, so tests can vary
 * the wording independently of the code.
 */
function createDecliningSpawn(
  platform: string,
  declineMethod: string,
  declineWith: { code: number; message: string },
) {
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
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (msg.method === declineMethod) {
        setImmediate(() => stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: msg.id, error: declineWith,
        }) + "\n"));
      } else if (msg.method === "initialize") {
        setImmediate(() => stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: msg.id,
          result: { platform, supported_events: ["message"], can_send: true, can_backfill: true },
        }) + "\n"));
      } else if (msg.method === "shutdown") {
        setImmediate(() => {
          stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
          setTimeout(() => exitHandler?.(0), 10);
        });
      } else {
        setImmediate(() => stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: msg.id, result: {},
        }) + "\n"));
      }
    }
  });

  return { proc };
}

describe("isMethodNotFound — optional-method detection", () => {
  it("recognises -32601 regardless of the adapter's wording", () => {
    // A third-party adapter is free to phrase the message however it likes;
    // the code is the contract.
    expect(isMethodNotFound(new AdapterProtocolError(-32601, "未知方法"))).toBe(true);
    expect(isMethodNotFound(new AdapterProtocolError(-32601, "no such handler"))).toBe(true);
    expect(isMethodNotFound(new AdapterProtocolError(-32601, "Method not found"))).toBe(true);
  });

  it("does NOT swallow errors whose code is not -32601", () => {
    // These are real failures. Treating them as "optional method absent"
    // would silently hide adapter bugs.
    expect(isMethodNotFound(new AdapterProtocolError(-32000, "Method not found in cache"))).toBe(false);
    expect(isMethodNotFound(new AdapterProtocolError(-32603, "internal error -32601 logged"))).toBe(false);
    expect(isMethodNotFound(new AdapterProtocolError(-32602, "Invalid params"))).toBe(false);
  });

  it("does NOT treat non-protocol errors as an absent optional method", () => {
    expect(isMethodNotFound(new Error("Request get_message_boxes (id=3) timeout after 30000ms"))).toBe(false);
    expect(isMethodNotFound(new Error("Method not found"))).toBe(false);
    expect(isMethodNotFound(new Error("-32601"))).toBe(false);
    expect(isMethodNotFound("Method not found")).toBe(false);
    expect(isMethodNotFound(undefined)).toBe(false);
  });
});

describe("declining adapter over the wire", () => {
  let manager: AdapterManager;

  afterEach(async () => {
    if (manager) await manager.shutdownAll();
  });

  it("surfaces a -32601 decline as a detectable optional-method error", async () => {
    const mock = createDecliningSpawn("declining", "get_message_boxes", {
      code: -32601,
      // Deliberately NOT the canonical wording, and no "-32601" in the text.
      message: "adapter does not implement this request",
    });

    const configs: AdapterConfig[] = [
      { platform: "declining", command: ["fake"] },
    ];
    manager = new AdapterManager(configs, {
      dataDir: "/tmp/chatmux-optional-method-test",
      spawn: () => () => mock.proc,
    });
    await manager.startAll();

    let caught: unknown;
    try {
      await manager.sendRequest("declining", "get_message_boxes", {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AdapterProtocolError);
    expect((caught as AdapterProtocolError).code).toBe(-32601);
    expect(isMethodNotFound(caught)).toBe(true);
  });

  it("does not mark a genuine adapter failure as an absent optional method", async () => {
    const mock = createDecliningSpawn("failing", "get_message_boxes", {
      code: -32603,
      // Wording that the old string-matching detector would have swallowed.
      message: "Method not found while loading dialog cache",
    });

    const configs: AdapterConfig[] = [
      { platform: "failing", command: ["fake"] },
    ];
    manager = new AdapterManager(configs, {
      dataDir: "/tmp/chatmux-optional-method-test",
      spawn: () => () => mock.proc,
    });
    await manager.startAll();

    let caught: unknown;
    try {
      await manager.sendRequest("failing", "get_message_boxes", {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AdapterProtocolError);
    expect(isMethodNotFound(caught)).toBe(false);
  });
});
