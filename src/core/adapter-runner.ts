import type { Writable, Readable } from "node:stream";
import { createInterface } from "node:readline";
import { ErrorTracker, KillSwitch, SafetyRail } from "./safety.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: unknown;
}

/** JSON-RPC 2.0 reserved error code for an unimplemented method. */
export const METHOD_NOT_FOUND = -32601;

export class AdapterProtocolError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = "AdapterProtocolError";
  }
}

/**
 * True when the adapter declined a request because it does not implement the
 * method (JSON-RPC "Method not found"). Optional protocol methods are detected
 * with this — never by matching the error message text, which every adapter is
 * free to word differently.
 */
export function isMethodNotFound(err: unknown): boolean {
  return err instanceof AdapterProtocolError && err.code === METHOD_NOT_FOUND;
}

export class AdapterProtocol {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer?: ReturnType<typeof setTimeout> }
  >();
  private notificationListeners = new Map<string, ((params: unknown) => void)[]>();
  private rl: ReturnType<typeof createInterface>;

  constructor(
    private stdin: Writable,
    stdout: Readable,
  ) {
    this.rl = createInterface({ input: stdout });
    this.rl.on("line", (line: string) => this.handleLine(line));
  }

  async request(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<unknown> {
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    this.stdin.write(JSON.stringify(msg) + "\n");

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (opts?.timeoutMs) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Request ${method} (id=${id}) timeout after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    const handlers = this.notificationListeners.get(method) ?? [];
    handlers.push(handler);
    this.notificationListeners.set(method, handlers);
  }

  destroy(): void {
    this.rl.close();
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error("Protocol destroyed"));
    }
    this.pending.clear();
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if ("id" in msg && (msg.result !== undefined || msg.error !== undefined)) {
      this.handleResponse(msg as JsonRpcResponse);
    } else if ("method" in msg && !("id" in msg)) {
      this.handleNotification(msg as JsonRpcNotification);
    }
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return;

    this.pending.delete(msg.id);
    if (entry.timer) clearTimeout(entry.timer);

    if (msg.error) {
      entry.reject(new AdapterProtocolError(msg.error.code, msg.error.message));
    } else {
      entry.resolve(msg.result);
    }
  }

  private handleNotification(msg: JsonRpcNotification): void {
    const handlers = this.notificationListeners.get(msg.method);
    if (!handlers) return;
    for (const fn of handlers) fn(msg.params);
  }
}

export interface SpawnResult {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid: number;
  kill: () => void;
  onExit: (fn: (code: number) => void) => void;
}

export interface AdapterRunnerConfig {
  command: string[];
  platform: string;
  dataDir: string;
  spawn: (command: string[]) => SpawnResult;
  safetyRail?: SafetyRail;
  crashTracker?: {
    initialBackoffMs?: number;
    maxBackoffMs?: number;
    killThreshold?: number;
    stabilityMs?: number;
  };
}

export class AdapterRunner {
  private config: AdapterRunnerConfig;
  private protocol: AdapterProtocol | null = null;
  private proc: SpawnResult | null = null;
  private eventListeners: ((params: unknown) => void)[] = [];
  private statusListeners: ((params: unknown) => void)[] = [];
  private errorListeners: ((params: unknown) => void)[] = [];
  private killListeners: (() => void)[] = [];
  private crashErrorTracker: ErrorTracker;
  private crashKillSwitch: KillSwitch;
  private _capabilities: unknown = null;
  private stopped = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly stabilityMs: number;

  constructor(config: AdapterRunnerConfig) {
    this.config = config;
    const ct = config.crashTracker ?? {};
    this.crashErrorTracker = new ErrorTracker(
      ct.killThreshold ?? 5,
      { initialBackoffMs: ct.initialBackoffMs ?? 5_000, maxBackoffMs: ct.maxBackoffMs ?? 20_000 },
    );
    this.crashKillSwitch = new KillSwitch(1);
    this.crashKillSwitch.onKill(() => {
      for (const fn of this.killListeners) fn();
    });
    this.stabilityMs = ct.stabilityMs ?? 30_000;
  }

  get capabilities(): unknown {
    return this._capabilities;
  }

  get isKilled(): boolean {
    return this.crashKillSwitch.isKilled;
  }

  /**
   * The adapter process is up and its JSON-RPC channel is open, so a request can
   * be attempted. Says nothing about whatever long-lived stream the adapter keeps
   * to its platform — those are separate lifetimes, and conflating them refuses
   * request/response work that would have gone through fine.
   */
  get isRunning(): boolean {
    return this.protocol !== null;
  }

  onEvent(fn: (params: unknown) => void): void {
    this.eventListeners.push(fn);
  }

  onStatus(fn: (params: unknown) => void): void {
    this.statusListeners.push(fn);
  }

  onError(fn: (params: unknown) => void): void {
    this.errorListeners.push(fn);
  }

  onKill(fn: () => void): void {
    this.killListeners.push(fn);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.spawnAndInitialize();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.stabilityTimer) { clearTimeout(this.stabilityTimer); this.stabilityTimer = null; }
    const proto = this.protocol;
    const proc = this.proc;
    if (proto && proc) {
      try {
        await proto.request("shutdown", {}, { timeoutMs: 5_000 });
      } catch {
        proc.kill();
      }
    }
    this.cleanup();
  }

  destroy(): void {
    this.stopped = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.stabilityTimer) { clearTimeout(this.stabilityTimer); this.stabilityTimer = null; }
    if (this.proc) this.proc.kill();
    this.cleanup();
  }

  reset(): void {
    this.crashErrorTracker.reset();
    this.crashKillSwitch.reset();
  }

  /**
   * opts.timeoutMs overrides the default for callers whose work is legitimately slow —
   * fetching media, mainly. The default stays short so a wedged adapter is reported in
   * seconds; raising it globally would make every broken request take minutes to fail.
   */
  async sendRequest(
    method: string,
    params: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<unknown> {
    if (!this.protocol) throw new Error("Adapter not running");
    return this.protocol.request(method, params, { timeoutMs: opts?.timeoutMs ?? 30_000 });
  }

  private async spawnAndInitialize(): Promise<void> {
    this.proc = this.config.spawn(this.config.command);
    this.protocol = new AdapterProtocol(this.proc.stdin, this.proc.stdout);

    this.protocol.onNotification("event", (params) => {
      for (const fn of this.eventListeners) fn(params);
    });
    this.protocol.onNotification("status", (params) => {
      for (const fn of this.statusListeners) fn(params);
    });
    this.protocol.onNotification("error", (params) => {
      for (const fn of this.errorListeners) fn(params);
    });

    this.proc.onExit((code) => this.handleExit(code));

    const caps = await this.protocol.request(
      "initialize",
      { data_dir: this.config.dataDir, platform: this.config.platform },
      { timeoutMs: 10_000 },
    ) as any;
    this._capabilities = caps;

    if (this.config.safetyRail && caps?.platform_rate_limits) {
      this.config.safetyRail.applyPlatformLimits(caps.platform_rate_limits);
    }

    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = setTimeout(() => {
      this.crashErrorTracker.reset();
      this.crashKillSwitch.recordNormal();
    }, this.stabilityMs);
  }

  private async handleExit(code: number): Promise<void> {
    this.cleanup();

    if (this.stopped) return;
    if (this.crashKillSwitch.isKilled) return;

    if (code !== 0) {
      const action = await this.crashErrorTracker.recordError(new Error(`Adapter exited with code ${code}`));
      if (action === "kill") {
        this.crashKillSwitch.recordAnomaly(`Adapter crashed ${this.crashErrorTracker.count} times`);
        return;
      }
    }

    this.restartTimer = setTimeout(async () => {
      if (this.stopped || this.crashKillSwitch.isKilled) return;
      try {
        await this.spawnAndInitialize();
      } catch {
        this.handleExit(1);
      }
    }, 10);
  }

  private cleanup(): void {
    if (this.protocol) {
      this.protocol.destroy();
      this.protocol = null;
    }
    this.proc = null;
  }
}
