import { describe, it, expect } from "bun:test";
import {
  RateLimiter,
  ErrorTracker,
  KillSwitch,
  SafetyRail,
  isNetworkError,
} from "../../src/core/safety.js";

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

const FAST = { initialBackoffMs: 1, maxBackoffMs: 5 };

describe("RateLimiter", () => {
  it("allows up to maxPerMinute calls immediately", async () => {
    const rl = new RateLimiter(3);
    const t0 = Date.now();
    await rl.acquire();
    await rl.acquire();
    await rl.acquire();
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("queues the call beyond maxPerMinute until window slides", async () => {
    const rl = new RateLimiter(2);
    await rl.acquire();
    await rl.acquire();

    let resolved = false;
    const p = rl.acquire().then(() => {
      resolved = true;
    });

    await sleep(50);
    expect(resolved).toBe(false);
  });

  it("getCount returns current window count", async () => {
    const rl = new RateLimiter(5);
    expect(rl.getCount()).toBe(0);
    await rl.acquire();
    await rl.acquire();
    expect(rl.getCount()).toBe(2);
  });

  it("setMaxPerMinute adjusts the limit", async () => {
    const rl = new RateLimiter(5);
    rl.setMaxPerMinute(2);
    await rl.acquire();
    await rl.acquire();

    let resolved = false;
    rl.acquire().then(() => {
      resolved = true;
    });

    await sleep(50);
    expect(resolved).toBe(false);
  });
});

describe("ErrorTracker", () => {
  it("returns 'retry' for errors below threshold", async () => {
    const et = new ErrorTracker(3, FAST);
    const r1 = await et.recordError(new Error("fail"));
    expect(r1).toBe("retry");
    const r2 = await et.recordError(new Error("fail"));
    expect(r2).toBe("retry");
  });

  it("returns 'kill' on the 3rd consecutive error", async () => {
    const et = new ErrorTracker(3, FAST);
    await et.recordError(new Error("1"));
    await et.recordError(new Error("2"));
    const result = await et.recordError(new Error("3"));
    expect(result).toBe("kill");
  });

  it("keeps returning 'kill' after threshold (backoff capped)", async () => {
    const et = new ErrorTracker(3, FAST);
    await et.recordError(new Error("1"));
    await et.recordError(new Error("2"));
    await et.recordError(new Error("3"));
    const r4 = await et.recordError(new Error("4"));
    expect(r4).toBe("kill");
  });

  it("backoff increases: 5 → 10 → 20(cap)", async () => {
    const delays: number[] = [];
    const et = new ErrorTracker(5, {
      initialBackoffMs: 50,
      maxBackoffMs: 200,
    });

    const t1 = Date.now();
    await et.recordError(new Error("1"));
    delays.push(Date.now() - t1);

    const t2 = Date.now();
    await et.recordError(new Error("2"));
    delays.push(Date.now() - t2);

    expect(delays[0]!).toBeGreaterThanOrEqual(40);
    expect(delays[1]!).toBeGreaterThanOrEqual(80);
    expect(delays[1]!).toBeGreaterThan(delays[0]!);
  });

  it("reset clears count and backoff", async () => {
    const et = new ErrorTracker(3, FAST);
    await et.recordError(new Error("1"));
    await et.recordError(new Error("2"));
    et.reset();
    const result = await et.recordError(new Error("after-reset"));
    expect(result).toBe("retry");
  });
});

describe("KillSwitch", () => {
  it("is killed after threshold anomalies", () => {
    const ks = new KillSwitch(1);
    expect(ks.isKilled).toBe(false);
    ks.recordAnomaly("test");
    expect(ks.isKilled).toBe(true);
  });

  it("recordNormal resets anomaly count", () => {
    const ks = new KillSwitch(2);
    ks.recordAnomaly("first");
    expect(ks.isKilled).toBe(false);
    ks.recordNormal();
    ks.recordAnomaly("after-reset");
    expect(ks.isKilled).toBe(false);
  });

  it("fires onKill listeners when killed", () => {
    const ks = new KillSwitch(1);
    let called = false;
    ks.onKill(() => { called = true; });
    ks.recordAnomaly("test");
    expect(called).toBe(true);
  });
});

describe("isNetworkError", () => {
  it("returns true for ECONNREFUSED", () => {
    const err = new Error("connection refused");
    (err as any).code = "ECONNREFUSED";
    expect(isNetworkError(err)).toBe(true);
  });

  it("returns true for fetch failed message", () => {
    expect(isNetworkError(new Error("fetch failed"))).toBe(true);
  });

  it("returns false for non-network errors", () => {
    expect(isNetworkError(new Error("server reject"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isNetworkError("string error")).toBe(false);
    expect(isNetworkError(null)).toBe(false);
  });
});

describe("SafetyRail", () => {
  it("filters out network errors", async () => {
    const sr = new SafetyRail(FAST);
    const err = new Error("fetch failed");
    (err as any).code = "ECONNREFUSED";
    await sr.recordError(err);
    expect(sr.errorTracker.count).toBe(0);
  });

  it("integration: 3 server errors → onKill called", async () => {
    const sr = new SafetyRail(FAST);
    let killed = false;
    sr.onKill(() => {
      killed = true;
    });

    await sr.recordError(new Error("server reject 1"));
    await sr.recordError(new Error("server reject 2"));
    await sr.recordError(new Error("server reject 3"));

    expect(killed).toBe(true);
  });

  // The switch latches and blocks every send until the daemon restarts, and it used to do
  // that without writing a line anywhere. The only way to find out was elimination against
  // the source — so the trip has to leave a trace at the moment it happens.
  it("logs the trip, its cause, and that sending stays blocked", async () => {
    const sr = new SafetyRail(FAST);
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      await sr.recordError(new Error("upstream reject 1"));
      await sr.recordError(new Error("upstream reject 2"));
      await sr.recordError(new Error("upstream reject 3"));
    } finally {
      console.error = original;
    }

    const trip = lines.find((l) => /kill switch/i.test(l));
    expect(trip).toBeDefined();
    expect(trip!).toMatch(/upstream reject 3/);
    expect(trip!).toMatch(/restart/i);
  });

  it("remembers why the kill switch tripped", async () => {
    const sr = new SafetyRail(FAST);
    const original = console.error;
    console.error = () => {};
    try {
      await sr.recordError(new Error("upstream reject 1"));
      await sr.recordError(new Error("upstream reject 2"));
      await sr.recordError(new Error("upstream reject 3"));
    } finally {
      console.error = original;
    }
    expect(sr.killSwitch.isKilled).toBe(true);
    expect(sr.killSwitch.killDetail).toBe("upstream reject 3");
  });

  it("has no kill detail before the switch trips", () => {
    const ks = new KillSwitch(2);
    expect(ks.killDetail).toBeUndefined();
    ks.recordAnomaly("first anomaly, below threshold");
    expect(ks.killDetail).toBeUndefined();
  });

  it("recordSuccess resets ErrorTracker and KillSwitch", async () => {
    const sr = new SafetyRail(FAST);
    await sr.recordError(new Error("err1"));
    await sr.recordError(new Error("err2"));
    sr.recordSuccess();
    expect(sr.errorTracker.count).toBe(0);
  });

  it("reset after kill-switch allows fresh counting", async () => {
    const sr = new SafetyRail(FAST);
    let killCount = 0;
    sr.onKill(() => killCount++);

    await sr.recordError(new Error("1"));
    await sr.recordError(new Error("2"));
    await sr.recordError(new Error("3"));
    expect(killCount).toBe(1);

    sr.reset();
    await sr.recordError(new Error("after-reset-1"));
    expect(killCount).toBe(1);
  });

  it("applyPlatformLimits uses stricter rate", async () => {
    const sr = new SafetyRail(FAST);
    sr.applyPlatformLimits({ send: { max: 3, windowSeconds: 60 } });

    await sr.rateLimiter.acquire();
    await sr.rateLimiter.acquire();
    await sr.rateLimiter.acquire();

    let resolved = false;
    sr.rateLimiter.acquire().then(() => { resolved = true; });

    await sleep(50);
    expect(resolved).toBe(false);
  });

  it("applyPlatformLimits ignores looser rate", async () => {
    const sr = new SafetyRail(FAST);
    sr.applyPlatformLimits({ send: { max: 10, windowSeconds: 60 } });

    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await sr.rateLimiter.acquire();
    expect(Date.now() - t0).toBeLessThan(50);

    let resolved = false;
    sr.rateLimiter.acquire().then(() => { resolved = true; });

    await sleep(50);
    expect(resolved).toBe(false);
  });
});
