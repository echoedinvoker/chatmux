/**
 * Phase 0 spike, kept as reference: proves a foreign-language (Python) adapter can
 * complete the stdio JSON-RPC handshake against AdapterRunner. This is the smallest
 * possible worked example for anyone writing an adapter in a non-JS language — the
 * real Telegram adapter (chatmux-adapter-telegram) grew from exactly this shape.
 *
 * Skipped when `python` is not on PATH, so it never fails a contributor's `bun test`.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { AdapterRunner } from "../../src/core/adapter-runner.js";
import type { SpawnResult } from "../../src/core/adapter-runner.js";

const PYTHON_ADAPTER = resolve(import.meta.dir, "python_adapter.py");
const HAS_PYTHON = spawnSync("python", ["--version"]).status === 0;

describe.skipIf(!HAS_PYTHON)("Python subprocess handshake", () => {
  let runner: AdapterRunner;

  afterEach(async () => {
    if (runner) await runner.stop();
  });

  it("spawns Python, receives capabilities and fake event", async () => {
    const events: unknown[] = [];

    runner = new AdapterRunner({
      command: ["python", PYTHON_ADAPTER],
      platform: "python-spike",
      dataDir: "/tmp/chatmux-spike-test",
      spawn: (command: string[]) => {
        const [cmd, ...args] = command;
        const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });

        return {
          stdin: child.stdin!,
          stdout: child.stdout!,
          stderr: child.stderr!,
          pid: child.pid!,
          kill: () => child.kill("SIGTERM"),
          onExit: (fn) => child.on("exit", (code) => fn(code ?? 1)),
        } satisfies SpawnResult;
      },
    });

    runner.onEvent((params) => events.push(params));

    await runner.start();

    expect(runner.capabilities).toEqual({
      platform: "python-spike",
      supported_events: ["message"],
      can_send: false,
      can_backfill: false,
    });

    // Wait for the fake event notification
    await new Promise((r) => setTimeout(r, 100));

    expect(events.length).toBe(1);
    const evt = events[0] as any;
    expect(evt.type).toBe("message");
    expect(evt.content.text).toBe("Hello from Python spike! 中文測試");
    expect(evt.sender.display_name).toBe("測試用戶");
  }, 10_000);
});
