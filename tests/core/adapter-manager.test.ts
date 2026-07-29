import { describe, it, expect } from "bun:test";
import { PassThrough } from "node:stream";
import type { SpawnResult } from "../../src/core/adapter-runner.js";
import { AdapterManager } from "../../src/core/adapter-manager.js";

function minimalSpawn(platform: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buf = "";
  stdin.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line);
        setImmediate(() =>
          stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                platform,
                supported_events: ["message"],
                can_send: true,
                can_backfill: true,
              },
            }) + "\n",
          ),
        );
      } catch {}
    }
  });
  const proc: SpawnResult = {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    kill: () => {},
    onExit: () => {},
  };
  return {
    proc,
    emitStatus(params: Record<string, unknown>) {
      stdout.write(
        JSON.stringify({ jsonrpc: "2.0", method: "status", params }) + "\n",
      );
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("AdapterStatus.lastLivenessEvidenceAt", () => {
  it("keeps the adapter's liveness timestamp and never regresses it to undefined", async () => {
    const mock = minimalSpawn("line");
    const manager = new AdapterManager([{ platform: "line", command: ["fake"] }], {
      spawn: () => () => mock.proc,
    });
    await manager.startAll();

    mock.emitStatus({ state: "connected", last_liveness_evidence_at: 1234 });
    await sleep(20);
    expect(manager.getStatuses().line!.lastLivenessEvidenceAt).toBe(1234);

    mock.emitStatus({ state: "reconnecting" });
    await sleep(20);
    expect(manager.getStatuses().line!.lastLivenessEvidenceAt).toBe(1234);

    await manager.shutdownAll(); // stabilityTimer is not unref'd; leaving it dangles a timer
  });

  it("maps a reconnecting adapter to the daemon-facing string 'disconnected'", async () => {
    const mock = minimalSpawn("line");
    const manager = new AdapterManager([{ platform: "line", command: ["fake"] }], {
      spawn: () => () => mock.proc,
    });
    await manager.startAll();

    mock.emitStatus({ state: "connected", last_liveness_evidence_at: 1 });
    await sleep(20);
    expect(manager.isConnected("line")).toBe(true);

    mock.emitStatus({ state: "reconnecting" });
    await sleep(20);
    expect(manager.isConnected("line")).toBe(false);
    expect(manager.isKilled("line")).toBe(false);

    // daemon.ts's ternary: connected ? "connected" : isKilled ? "killed" : "disconnected"
    const s = manager.getStatuses().line!;
    const daemonFacing = s.connected
      ? "connected"
      : manager.isKilled("line")
        ? "killed"
        : "disconnected";
    expect(daemonFacing).toBe("disconnected");

    await manager.shutdownAll();
  });
});
