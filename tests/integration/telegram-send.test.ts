import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { AdapterRunner, type SpawnResult } from "../../src/core/adapter-runner.js";
import { SafetyRail } from "../../src/core/safety.js";
import { handleSendMessage, type SendDeps } from "../../src/core/mcp/tools.js";

const LIVE = process.env.CHATMUX_LIVE_TEST === "1";
const CHAT_ID = process.env.CHATMUX_TEST_CHAT_ID ?? "";
const DATA_DIR = process.env.CHATMUX_DATA_DIR ?? resolve(process.env.HOME!, ".local/share/chatmux");

const TELEGRAM_COMMAND = process.env.CHATMUX_TELEGRAM_PYTHON ?? "";
const TELEGRAM_ARGS = [process.env.CHATMUX_TELEGRAM_MAIN ?? ""];
const TELEGRAM_ENV: Record<string, string> = {
  TELEGRAM_API_ID: process.env.TELEGRAM_API_ID ?? "",
  TELEGRAM_API_HASH: process.env.TELEGRAM_API_HASH ?? "",
};

describe.skipIf(!LIVE)("Telegram live send", () => {
  let runner: AdapterRunner;
  let safetyRail: SafetyRail;

  beforeAll(async () => {
    if (!CHAT_ID) throw new Error("CHATMUX_TEST_CHAT_ID env required");
    if (!TELEGRAM_COMMAND || !TELEGRAM_ARGS[0])
      throw new Error("CHATMUX_TELEGRAM_PYTHON and CHATMUX_TELEGRAM_MAIN env required");
    if (!TELEGRAM_ENV.TELEGRAM_API_ID || !TELEGRAM_ENV.TELEGRAM_API_HASH)
      throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH env required");

    safetyRail = new SafetyRail();

    runner = new AdapterRunner({
      command: [TELEGRAM_COMMAND, ...TELEGRAM_ARGS],
      platform: "telegram",
      dataDir: DATA_DIR,
      spawn: (cmd) => {
        const proc = spawn(cmd[0], cmd.slice(1), {
          stdio: ["pipe", "pipe", "inherit"],
          env: { ...process.env, ...TELEGRAM_ENV },
        });
        const exitListeners: ((code: number) => void)[] = [];
        proc.on("exit", (code) => {
          for (const fn of exitListeners) fn(code ?? 1);
        });
        return {
          stdin: proc.stdin!,
          stdout: proc.stdout!,
          stderr: proc.stderr!,
          pid: proc.pid!,
          kill: () => proc.kill(),
          onExit: (fn: (code: number) => void) => { exitListeners.push(fn); },
        } satisfies SpawnResult;
      },
      safetyRail,
    });

    await runner.start();

    // Wait for status:connected (Telethon auth may take time)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Telegram adapter did not connect within 120s")), 120_000);
      runner.onStatus((params) => {
        const status = params as { state: string };
        if (status.state === "connected") {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  }, 130_000);

  afterAll(async () => {
    await runner.stop();
  });

  test("send text message to self", async () => {
    const deps: SendDeps = {
      safetyRail,
      sendToAdapter: (method, params) => runner.sendRequest(method, params),
      isAdapterReachable: () => true,
    };

    const result = await handleSendMessage(deps, {
      chat_id: CHAT_ID,
      text: `chatmux live test — telegram adapter ${new Date().toISOString()}`,
    });

    expect(result.success).toBe(true);
    expect(result.message_id).toBeTruthy();
    expect(typeof result.timestamp).toBe("number");
  }, 30_000);
});
