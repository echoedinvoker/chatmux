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

const SOCKET_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EPIPE",
]);

/**
 * Narrow classifier for "the push stream died" rejections.
 *
 * Deliberately NOT built on `isNetworkError`: that one also matches the generic
 * message "fetch failed", and the M4 crash *and* an unrelated TLS failure both
 * carry that exact top-level message. Matching on message would swallow real
 * bugs — which is the very silence this project exists to remove. Only the
 * error `code` and the `name` + "stream timeout" pair are considered, walked
 * down the cause chain (bounded, so a cyclic cause cannot hang us).
 */
export function isPushStreamFailure(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 3; depth++) {
    if (!(current instanceof Error)) return false;
    const code = (current as any).code;
    if (typeof code === "string" && SOCKET_ERROR_CODES.has(code)) return true;
    if (
      current.name === "InformationalError" &&
      current.message.toLowerCase().includes("stream timeout")
    )
      return true;
    current = (current as any).cause;
    if (current === undefined || current === null) return false;
  }
  return false;
}

export interface PushCrashGuardDeps {
  proc: {
    on(event: "unhandledRejection", fn: (reason: unknown) => void): unknown;
  };
  onStreamFailure: (err: unknown) => void;
  onFatal: (err: unknown) => void;
}

/**
 * The undici h2 stream timeout arrives as an *orphan* rejection: linejs builds
 * the push connection inside an un-awaited async IIFE, so no try/catch in this
 * file can ever see it. The only interception point is process level.
 *
 * Anything we do not positively recognise as a push stream failure is handed to
 * `onFatal`, which must keep today's fail-fast behaviour — trading a crash for
 * a silent log would just swap one silence for another.
 */
export function installPushCrashGuard(deps: PushCrashGuardDeps): void {
  deps.proc.on("unhandledRejection", (reason) => {
    if (isPushStreamFailure(reason)) deps.onStreamFailure(reason);
    else deps.onFatal(reason);
  });
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
  now?: () => number;
}

export class ConnectionManager {
  private state: ConnectionState = "reconnecting";
  private stateListeners: ((
    s: ConnectionState,
    lastLivenessEvidenceAt: number | null,
  ) => void)[] = [];
  private errorListeners: ((err: Error) => Promise<void>)[] = [];
  private eventListeners: ((event: any) => void)[] = [];
  private abortController: AbortController | null = null;
  private networkRetryMs: number;
  private streamRetryMs: number;
  // consumeLoop parks on `await reader.read()`; without a handle on the reader
  // there is no way to interrupt it from outside.
  private currentReader: ReadableStreamDefaultReader<any> | null = null;
  private now: () => number;
  /**
   * Last moment we had *evidence* the stream was alive. Only advanced by the
   * stream actually producing data — never by a state change, which is exactly
   * the lie this project removes.
   */
  lastLivenessEvidenceAt: number | null = null;

  constructor(private push: PushSource, opts?: ConnectionManagerOptions) {
    this.networkRetryMs = opts?.networkRetryMs ?? 5000;
    this.streamRetryMs = opts?.streamRetryMs ?? 1000;
    this.now = opts?.now ?? Date.now;
  }

  private noteLivenessEvidence(): void {
    this.lastLivenessEvidenceAt = this.now();
    // The stream producing data is the only thing that earns `connected` back.
    // pushLoop cannot do it: initLegyPusher never resolves in the real client,
    // so it declares connected exactly once in its lifetime.
    if (this.state !== "connected") this.setState("connected");
  }

  /**
   * Declare the push stream dead from the outside (crash guard, suspend
   * detector). Cancels the reader so consumeLoop unwinds; the renew is left to
   * consumeLoop's existing path so the stream is rebuilt exactly once.
   */
  markStreamDead(reason: string): void {
    console.error(`[LINE] push liveness: marked dead (${reason})`);
    this.setState("reconnecting");
    this.currentReader?.cancel().catch(() => {});
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

  onStateChange(
    fn: (s: ConnectionState, lastLivenessEvidenceAt: number | null) => void,
  ): void {
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
    for (const fn of this.stateListeners) fn(s, this.lastLivenessEvidenceAt);
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
      this.currentReader = reader;
      const onAbort = () => {
        reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.noteLivenessEvidence();
          for (const fn of this.eventListeners) fn(value);
        }
      } catch (err) {
        console.error(
          "[LINE] push liveness: stream ended/errored:",
          err instanceof Error ? err.message : err,
        );
      } finally {
        signal.removeEventListener("abort", onAbort);
        reader.releaseLock();
        this.currentReader = null;
      }
      if (signal.aborted) return;
      // Reached on both error and clean `done`: for a push stream, EOF is death,
      // not a normal ending. Must stay *after* the aborted check — stop("killed")
      // aborts, and demoting here would overwrite that terminal state.
      this.setState("reconnecting");
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
