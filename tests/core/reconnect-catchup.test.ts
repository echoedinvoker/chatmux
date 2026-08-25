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

describe("createReconnectCatchupTrigger after a retried login", () => {
  it("runs one catch-up after a login that took several attempts", async () => {
    const runs: string[] = [];
    const trigger = createReconnectCatchupTrigger({
      runCatchup: async (p) => { runs.push(p); },
    });

    await trigger.onStatus("telegram", "reconnecting");
    await trigger.onStatus("telegram", "reconnecting");
    await trigger.onStatus("telegram", "connected");

    expect(runs).toEqual(["telegram"]);
  });
});

describe("the sequence the Telegram adapter now emits (F79)", () => {
  it("runs one catch-up per outage, and none for the connect that opens the process", async () => {
    // This exact list is what the adapter's liveness supervisor produces over a
    // process lifetime — see test_states_always_alternate_across_repeated_outages
    // in chatmux-adapter-telegram/tests/test_liveness.py. Before F79 the list was
    // just ["connected"], for 21 hours, while 211 messages waited.
    const runs: string[] = [];
    const trigger = createReconnectCatchupTrigger({
      runCatchup: async (p) => {
        runs.push(p);
      },
    });

    const emitted = ["connected", "reconnecting", "connected", "reconnecting", "connected"];
    for (const state of emitted) {
      await trigger.onStatus("telegram", state);
    }

    // Two outages, two catch-ups. The opening `connected` belongs to cold start,
    // so counting it here would fetch the same backlog twice on every boot.
    expect(runs).toEqual(["telegram", "telegram"]);
  });
});
