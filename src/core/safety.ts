export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as any).code;
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENETUNREACH" ||
    code === "EPIPE"
  )
    return true;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("socket hang up") ||
    msg.includes("econnrefused")
  );
}

export interface ErrorTrackerOptions {
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export class RateLimiter {
  private timestamps: number[] = [];
  private queue: Array<{ resolve: () => void }> = [];
  private draining = false;

  constructor(private maxPerMinute: number = 5) {}

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);

    if (this.timestamps.length < this.maxPerMinute) {
      this.timestamps.push(now);
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push({ resolve });
      if (!this.draining) this.drain();
    });
  }

  getCount(): number {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
    return this.timestamps.length;
  }

  setMaxPerMinute(max: number): void {
    this.maxPerMinute = max;
  }

  private async drain() {
    this.draining = true;
    while (this.queue.length > 0) {
      const oldest = this.timestamps[0] ?? 0;
      const waitMs = 60_000 - (Date.now() - oldest) + 50;
      if (waitMs > 0) await sleep(waitMs);

      this.timestamps = this.timestamps.filter((t) => Date.now() - t < 60_000);
      if (
        this.timestamps.length < this.maxPerMinute &&
        this.queue.length > 0
      ) {
        this.timestamps.push(Date.now());
        this.queue.shift()!.resolve();
      }
    }
    this.draining = false;
  }
}

export class ErrorTracker {
  private consecutiveErrors = 0;
  private backoffMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly killThreshold: number;

  constructor(killThreshold: number = 3, opts?: ErrorTrackerOptions) {
    this.killThreshold = killThreshold;
    this.initialBackoffMs = opts?.initialBackoffMs ?? 5_000;
    this.maxBackoffMs = opts?.maxBackoffMs ?? 20_000;
    this.backoffMs = this.initialBackoffMs;
  }

  reset() {
    this.consecutiveErrors = 0;
    this.backoffMs = this.initialBackoffMs;
  }

  async recordError(err: unknown): Promise<"retry" | "kill"> {
    this.consecutiveErrors++;

    if (this.consecutiveErrors >= this.killThreshold) {
      return "kill";
    }

    await sleep(this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    return "retry";
  }

  get count() {
    return this.consecutiveErrors;
  }
}

export class KillSwitch {
  private consecutiveAnomalies = 0;
  private readonly threshold: number;
  private killed = false;
  private killListeners: (() => void)[] = [];

  constructor(threshold: number = 1) {
    this.threshold = threshold;
  }

  recordAnomaly(detail: string) {
    this.consecutiveAnomalies++;
    if (this.consecutiveAnomalies >= this.threshold && !this.killed) {
      this.killed = true;
      for (const fn of this.killListeners) fn();
    }
  }

  recordNormal() {
    this.consecutiveAnomalies = 0;
  }

  get isKilled() {
    return this.killed;
  }

  reset() {
    this.killed = false;
    this.consecutiveAnomalies = 0;
  }

  onKill(fn: () => void) {
    this.killListeners.push(fn);
  }
}

export class SafetyRail {
  readonly rateLimiter: RateLimiter;
  readonly errorTracker: ErrorTracker;
  readonly killSwitch: KillSwitch;

  constructor(errorTrackerOpts?: ErrorTrackerOptions) {
    this.rateLimiter = new RateLimiter(5);
    this.errorTracker = new ErrorTracker(3, errorTrackerOpts);
    this.killSwitch = new KillSwitch(1);
  }

  async recordError(err: unknown): Promise<void> {
    if (isNetworkError(err)) return;
    const action = await this.errorTracker.recordError(err);
    if (action === "kill") {
      this.killSwitch.recordAnomaly(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  recordSuccess(): void {
    this.errorTracker.reset();
    this.killSwitch.recordNormal();
  }

  reset(): void {
    this.errorTracker.reset();
    this.killSwitch.reset();
  }

  onKill(fn: () => void) {
    this.killSwitch.onKill(fn);
  }

  applyPlatformLimits(limits: { send?: { max: number; windowSeconds: number } }): void {
    if (limits.send) {
      const platformMax = limits.send.max;
      const currentMax = 5;
      if (platformMax < currentMax) {
        this.rateLimiter.setMaxPerMinute(platformMax);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
