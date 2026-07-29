import { AdapterRunner, type SpawnResult } from "./adapter-runner.js";
import type { AdapterConfig } from "./config.js";
import type { SafetyRail } from "./safety.js";

export interface AdapterStatus {
  connected: boolean;
  startTime: number;
  killed: boolean;
  /**
   * Last time the adapter had evidence its stream was alive. `connected` alone
   * only means "no evidence of death"; this is the field to trust.
   */
  lastLivenessEvidenceAt?: number;
}

export interface AdapterManagerOpts {
  spawn: (platform: string) => (command: string[]) => SpawnResult;
  dataDir?: string;
  safetyRail?: SafetyRail;
  crashTracker?: {
    initialBackoffMs?: number;
    maxBackoffMs?: number;
    killThreshold?: number;
    stabilityMs?: number;
  };
}

export class AdapterManager {
  private runners = new Map<string, AdapterRunner>();
  private statuses = new Map<string, AdapterStatus>();
  private eventListeners: ((platform: string, params: unknown) => void)[] = [];
  private statusListeners: ((platform: string, params: unknown) => void)[] = [];
  private errorListeners: ((platform: string, params: unknown) => void)[] = [];

  constructor(
    private configs: AdapterConfig[],
    private opts: AdapterManagerOpts,
  ) {}

  async startAll(): Promise<void> {
    const startPromises: Promise<void>[] = [];

    for (const config of this.configs) {
      const runner = new AdapterRunner({
        command: config.command,
        platform: config.platform,
        dataDir: this.opts.dataDir ?? "/tmp/chatmux",
        spawn: this.opts.spawn(config.platform),
        safetyRail: this.opts.safetyRail,
        crashTracker: this.opts.crashTracker,
      });

      this.statuses.set(config.platform, { connected: false, startTime: 0, killed: false });

      runner.onEvent((params) => {
        for (const fn of this.eventListeners) fn(config.platform, params);
      });

      runner.onStatus((params) => {
        const status = params as {
          state: string;
          last_liveness_evidence_at?: number;
        };
        const s = this.statuses.get(config.platform)!;
        // Only ever move it forward: a status without a timestamp says nothing
        // about liveness, so it must not erase what we already knew.
        if (typeof status.last_liveness_evidence_at === "number") {
          s.lastLivenessEvidenceAt = status.last_liveness_evidence_at;
        }
        if (status.state === "connected") {
          s.connected = true;
          s.startTime = Date.now();
        } else {
          s.connected = false;
        }
        for (const fn of this.statusListeners) fn(config.platform, params);
      });

      runner.onError((params) => {
        for (const fn of this.errorListeners) fn(config.platform, params);
      });

      runner.onKill(() => {
        const s = this.statuses.get(config.platform);
        if (s) {
          s.connected = false;
          s.killed = true;
        }
      });

      this.runners.set(config.platform, runner);
      startPromises.push(runner.start());
    }

    await Promise.all(startPromises);
  }

  async shutdownAll(): Promise<void> {
    const stops = Array.from(this.runners.values()).map((r) => r.stop());
    await Promise.all(stops);
  }

  sendRequest(platform: string, method: string, params: unknown): Promise<unknown> {
    const runner = this.runners.get(platform);
    if (!runner) throw new Error(`Unknown platform: ${platform}`);
    return runner.sendRequest(method, params);
  }

  getRunner(platform: string): AdapterRunner | undefined {
    return this.runners.get(platform);
  }

  getStatuses(): Record<string, AdapterStatus> {
    const result: Record<string, AdapterStatus> = {};
    for (const [platform, status] of this.statuses) {
      result[platform] = { ...status };
    }
    return result;
  }

  isConnected(platform: string): boolean {
    return this.statuses.get(platform)?.connected ?? false;
  }

  isKilled(platform: string): boolean {
    return this.runners.get(platform)?.isKilled ?? false;
  }

  get platforms(): string[] {
    return Array.from(this.runners.keys());
  }

  onEvent(fn: (platform: string, params: unknown) => void): void {
    this.eventListeners.push(fn);
  }

  onStatus(fn: (platform: string, params: unknown) => void): void {
    this.statusListeners.push(fn);
  }

  onError(fn: (platform: string, params: unknown) => void): void {
    this.errorListeners.push(fn);
  }
}
