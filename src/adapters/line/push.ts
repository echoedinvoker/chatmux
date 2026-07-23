import type { Client } from "@evex/linejs";

export type ConnectionState = "connected" | "reconnecting" | "killed";

export interface PushSource {
  readonly stream: ReadableStream<any>;
  renew(): void;
  initLegyPusher(): Promise<void>;
}

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

export function createPushSource(client: Client): PushSource {
  const polling = client.base.createPolling();
  client.base.push.opStream.renew();
  return {
    get stream() {
      return client.base.push.opStream.stream;
    },
    renew() {
      client.base.push.opStream.renew();
    },
    initLegyPusher() {
      return polling.initLegyPusher();
    },
  };
}

export interface ConnectionManagerOptions {
  networkRetryMs?: number;
  streamRetryMs?: number;
}

export class ConnectionManager {
  private state: ConnectionState = "reconnecting";
  private stateListeners: ((s: ConnectionState) => void)[] = [];
  private errorListeners: ((err: Error) => Promise<void>)[] = [];
  private eventListeners: ((event: any) => void)[] = [];
  private abortController: AbortController | null = null;
  private networkRetryMs: number;
  private streamRetryMs: number;

  constructor(private push: PushSource, opts?: ConnectionManagerOptions) {
    this.networkRetryMs = opts?.networkRetryMs ?? 5000;
    this.streamRetryMs = opts?.streamRetryMs ?? 1000;
  }

  start(): void {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    Promise.all([this.pushLoop(signal), this.consumeLoop(signal)]).catch(
      (err) => this.emitError(err)
    );
  }

  restart(): void {
    this.stop();
    this.push.renew();
    this.start();
  }

  stop(reason: "graceful" | "killed" = "graceful"): void {
    if (reason === "killed") this.setState("killed");
    this.abortController?.abort();
    this.abortController = null;
  }

  onStateChange(fn: (s: ConnectionState) => void): void {
    this.stateListeners.push(fn);
  }

  onError(fn: (err: Error) => Promise<void>): void {
    this.errorListeners.push(fn);
  }

  onEvent(fn: (event: any) => void): void {
    this.eventListeners.push(fn);
  }

  offEvent(fn: (event: any) => void): void {
    const idx = this.eventListeners.indexOf(fn);
    if (idx !== -1) this.eventListeners.splice(idx, 1);
  }

  private setState(s: ConnectionState): void {
    if (this.state === s) return;
    this.state = s;
    for (const fn of this.stateListeners) fn(s);
  }

  private async emitError(err: unknown): Promise<void> {
    const error = err instanceof Error ? err : new Error(String(err));
    for (const fn of this.errorListeners) {
      await fn(error);
    }
  }

  private async pushLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        this.setState("connected");
        await this.push.initLegyPusher();
      } catch (err) {
        if (signal.aborted) return;
        this.setState("reconnecting");
        if (isNetworkError(err)) {
          await sleep(this.networkRetryMs, signal);
          continue;
        }
        await this.emitError(err);
      }
    }
  }

  private async consumeLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const reader = this.push.stream.getReader();
      const onAbort = () => {
        reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const fn of this.eventListeners) fn(value);
        }
      } catch {
        // reader cancelled or stream error
      } finally {
        signal.removeEventListener("abort", onAbort);
        reader.releaseLock();
      }
      if (signal.aborted) return;
      this.push.renew();
      await sleep(this.streamRetryMs, signal);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
