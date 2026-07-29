import { describe, it, expect } from "bun:test";
import { createReconnectCatchupTrigger } from "../../src/core/reconnect-catchup.js";

describe("createReconnectCatchupTrigger", () => {
  it("fires only on a re-connect, never on the first connect", async () => {
    const runs: string[] = [];
    const trigger = createReconnectCatchupTrigger({
      runCatchup: async (p) => {
        runs.push(p);
      },
    });

    await trigger.onStatus("line", "connected");
    expect(runs).toHaveLength(0);

    await trigger.onStatus("line", "reconnecting");
    await trigger.onStatus("line", "connected");
    expect(runs).toEqual(["line"]);

    await trigger.onStatus("line", "connected");
    expect(runs).toEqual(["line"]);
  });

  it("does not run two catch-ups for the same platform concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const trigger = createReconnectCatchupTrigger({
      runCatchup: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 30));
        active--;
      },
    });

    await trigger.onStatus("line", "reconnecting");
    const a = trigger.onStatus("line", "connected");
    await trigger.onStatus("line", "reconnecting");
    const b = trigger.onStatus("line", "connected");
    await Promise.all([a, b]);

    expect(maxActive).toBe(1);
  });
});
