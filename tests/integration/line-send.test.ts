import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { SafetyRail } from "../../src/core/safety.js";
import { AdapterRunner, type SpawnResult } from "../../src/core/adapter-runner.js";
import { handleSendMessage, type SendDeps } from "../../src/core/mcp/tools.js";

const LIVE = process.env.CHATMUX_LIVE_TEST === "1";
const TEST_CHAT_ID = process.env.CHATMUX_TEST_CHAT_ID;
const DATA_DIR = process.env.CHATMUX_DATA_DIR ?? resolve(homedir(), ".local/share/chatmux");

describe.skipIf(!LIVE)("LINE adapter live send", () => {
  let runner: AdapterRunner;
  let safetyRail: SafetyRail;

  beforeAll(async () => {
    if (!TEST_CHAT_ID) {
      throw new Error(
        "CHATMUX_TEST_CHAT_ID is required for live tests. " +
        "Set it to your LINE MID with platform prefix, e.g. line:ufa7728a..."
      );
    }

    safetyRail = new SafetyRail();

    runner = new AdapterRunner({
      command: ["node", "--import", "tsx", resolve(__dirname, "../../src/adapters/line/index.ts")],
      platform: "line",
      dataDir: DATA_DIR,
      spawn: (cmd) => {
        const proc = spawn(cmd[0], cmd.slice(1), {
          stdio: ["pipe", "pipe", "inherit"],
          cwd: resolve(__dirname, "../.."),
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

    let connectedTimeout: ReturnType<typeof setTimeout>;
    const connected = new Promise<void>((res, rej) => {
      connectedTimeout = setTimeout(() => rej(new Error("LINE login timeout (120s)")), 120_000);
      runner.onStatus((params: any) => {
        if (params.state === "connected") { clearTimeout(connectedTimeout); res(); }
      });
    });

    try {
      await runner.start();
      await connected;
    } catch (e) {
      clearTimeout(connectedTimeout!);
      throw e;
    }
  }, 180_000);

  afterAll(async () => {
    if (runner) await runner.stop();
  }, 15_000);

  test("should send a real message through the full daemon→adapter→linejs chain", async () => {
    const deps: SendDeps = {
      safetyRail,
      sendToAdapter: (method, params) => runner.sendRequest(method, params),
      isAdapterReachable: () => true,
    };

    const timestamp = new Date().toISOString();
    const result = await handleSendMessage(deps, {
      chat_id: TEST_CHAT_ID!,
      text: `chatmux live test ${timestamp}`,
    });

    expect(result.success).toBe(true);
    expect(result.message_id).toBeDefined();
    expect(result.message_id).not.toBe("");
    expect(result.timestamp).toBeDefined();
    expect(typeof result.timestamp).toBe("number");
  }, 30_000);
});
