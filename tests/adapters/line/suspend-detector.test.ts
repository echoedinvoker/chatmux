import { describe, it, expect } from "bun:test";
import { createSuspendDetector } from "../../../src/adapters/line/push.js";

describe("createSuspendDetector", () => {
  it("fires when wall-clock jumps beyond the threshold", () => {
    let clock = 1_000_000;
    const gaps: number[] = [];
    const det = createSuspendDetector({
      intervalMs: 30_000,
      thresholdMs: 90_000,
      now: () => clock,
      onSuspendDetected: (gap) => gaps.push(gap),
    });

    clock += 30_000;
    det.tick();
    expect(gaps).toHaveLength(0);

    clock += 600_000; // host slept for 10 minutes
    det.tick();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toBeGreaterThanOrEqual(600_000);
  });

  it("does not fire on ordinary ticks", () => {
    let clock = 0;
    const gaps: number[] = [];
    const det = createSuspendDetector({
      intervalMs: 30_000,
      thresholdMs: 90_000,
      now: () => clock,
      onSuspendDetected: (g) => gaps.push(g),
    });
    for (let i = 0; i < 20; i++) {
      clock += 30_000;
      det.tick();
    }
    expect(gaps).toHaveLength(0);
  });
});
