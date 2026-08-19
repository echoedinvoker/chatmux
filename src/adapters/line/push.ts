import type { Client } from "@evex/linejs";
import { classifyLoginFailure } from "./login-supervisor.js";

export type ConnectionState = "connected" | "reconnecting" | "killed";

export interface PushSource {
  readonly stream: ReadableStream<any>;
  renew(): void;
  initLegyPusher(): Promise<void>;
  /**
   * Tear the underlying LEGY connection down. Never builds one: rebuilding
   * belongs to linejs's `initLegyPusher()` while-loop and nowhere else. See
   * `docs/line-adapter.md`, "Who rebuilds the LEGY connection".
   */
  killConnection(): void;
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

/**
 * "The resolver could not answer *right now*" — and nothing else.
 *
 * F85, 2026-08-19: the host woke from suspend before the network interface came
 * back, a fetch to legy.line-apps.com rejected with EAI_AGAIN nested one level
 * down as a `cause`, and because that happens *after* login the guard below sent
 * it to onFatal and the whole adapter died.
 *
 * The set is exactly one code, and that narrowness is the whole design:
 *
 *  - `EAI_AGAIN` is the resolver saying "temporary failure, try again". No
 *    programming bug and no misconfiguration produces it; only a resolver that
 *    is unreachable this instant does.
 *  - `ENOTFOUND` / `EAI_NONAME` are deliberately NOT here even though a waking
 *    host can emit them. They mean "this name does not exist", which is
 *    indistinguishable at the code level from someone mistyping a hostname —
 *    treating those as transient would turn a permanent misconfiguration into an
 *    infinite quiet reconnect loop.
 *
 * Message text is never consulted, for the same reason `isPushStreamFailure`
 * refuses to: "fetch failed" is also what an expired TLS certificate says.
 */
const TRANSIENT_RESOLVER_CODES = new Set(["EAI_AGAIN"]);

export function isTransientResolverFailure(err: unknown): boolean {
  let current: unknown = err;
  // Bounded like the two walkers above, so a cyclic `cause` cannot hang us.
  for (let depth = 0; depth < 3; depth++) {
    if (!(current instanceof Error)) return false;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_RESOLVER_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
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
  /**
   * Both optional, and when neither is passed the guard behaves exactly as it
   * did before — the existing tests in this file are that guarantee.
   */
  isLoggedIn?: () => boolean;
  onLoginWindowNetworkError?: (err: unknown) => void;
  /**
   * A transient resolver failure that needs the *reconnect* path, not a crash.
   * `consecutive` counts these since process start and never resets: a resolver
   * that never comes back shows up as a number that keeps climbing, which is the
   * only difference between "recovering" and "stuck forever" that a log can
   * carry. When this is not wired the guard falls back to `onStreamFailure` —
   * the same recovery action — never to `onFatal`.
   */
  onRecoverableNetworkError?: (err: unknown, consecutive: number) => void;
}

/**
 * The undici h2 stream timeout arrives as an *orphan* rejection: linejs builds
 * the push connection inside an un-awaited async IIFE, so no try/catch in this
 * file can ever see it. The only interception point is process level.
 *
 * Anything we do not positively recognise is handed to `onFatal`, which must
 * keep today's fail-fast behaviour — trading a crash for a silent log would just
 * swap one silence for another. Every exception below is therefore a *positively
 * identified* class with a named recovery action, never a widening of the
 * default: "we could not explain it" still means "be loud".
 */
export function installPushCrashGuard(deps: PushCrashGuardDeps): void {
  let transientRecoveries = 0;

  deps.proc.on("unhandledRejection", (reason) => {
    if (isPushStreamFailure(reason)) {
      deps.onStreamFailure(reason);
      return;
    }
    // The one place the fail-fast rule bends, and only here: before login has
    // ever succeeded, a network rejection is the wake-from-suspend DNS failure
    // that used to kill the whole process (2026-08-18). The login supervisor is
    // already retrying it, so crashing helps nobody. Once we are logged in the
    // strict behaviour comes straight back — a rejection we cannot explain must
    // still be loud.
    if (deps.isLoggedIn?.() === false && classifyLoginFailure(reason) === "network") {
      deps.onLoginWindowNetworkError?.(reason);
      return;
    }
    // F85. The strict rule above is unchanged in substance — it just stops
    // covering a case it was never reasoning about. A DNS "try again later"
    // after login is not an unexplained rejection: it is explained, precisely,
    // and the explanation says the stream is gone and needs rebuilding. So it
    // takes the *same* recovery the push-stream-failure branch takes rather than
    // a new branch that logs and returns. Note this classifier looks only at
    // EAI_AGAIN, never at message text, so an unexplained "fetch failed" still
    // falls through to onFatal below.
    if (isTransientResolverFailure(reason)) {
      transientRecoveries += 1;
      if (deps.onRecoverableNetworkError) {
        deps.onRecoverableNetworkError(reason, transientRecoveries);
      } else {
        deps.onStreamFailure(reason);
      }
      return;
    }
    deps.onFatal(reason);
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
    killConnection() {
      // linejs reaches its own connection the same way (`connManager.ts:491`
      // closes `conns[0]` when the auth token changes), so this is a published
      // path, not a private one we invented. Optional chaining throughout:
      // after a suspend the connection object may already be gone, and a throw
      // here would land in the suspend detector's tick with nobody to catch it.
      const conn = (client.base.push as any).conns?.[0];

      // `resStream` is assigned only once the fetch inside `Conn.new()` has come
      // back (`@evex/linejs/base/push/conn.ts:133`), which makes it the signal
      // that the handshake finished. Aborting before that rejects a fetch living
      // in an un-awaited IIFE with no catch anywhere: an AbortError, which
      // `isPushStreamFailure()` does not recognise, so the crash guard rethrows
      // it and the adapter process dies. Skipping instead costs at most one
      // slower recovery — linejs's loop retries a failed handshake by itself —
      // and that trade is deliberate.
      if (!conn?.resStream) return;

      // `Conn.close()` is async and swallows its own errors, but a rejected
      // promise here would become the very unhandled rejection we are avoiding.
      Promise.resolve(conn.close?.()).catch(() => {});
    },
  };
}

export interface SuspendDetectorDeps {
  intervalMs: number;
  thresholdMs: number;
  now: () => number;
  onSuspendDetected: (gapMs: number) => void;
}

export interface SuspendDetector {
  tick(): void;
  start(): void;
  stop(): void;
}

/**
 * Detects that the host was suspended by watching for wall-clock jumps between
 * ticks. Waiting for undici's own 300s h2 timeout means ~7-10 minutes of
 * claiming `connected` over a stream that is already gone; this notices within
 * one tick instead.
 *
 * tick() is separate from the timer so tests can drive it synchronously.
 */
export function createSuspendDetector(deps: SuspendDetectorDeps): SuspendDetector {
  let lastTickAt = deps.now();
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = () => {
    const now = deps.now();
    const gap = now - lastTickAt;
    lastTickAt = now;
    if (gap > deps.thresholdMs) deps.onSuspendDetected(gap);
  };

  return {
    tick,
    start() {
      if (timer) return;
      lastTickAt = deps.now();
      timer = setInterval(tick, deps.intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export interface ConnectionManagerOptions {
  networkRetryMs?: number;
  streamRetryMs?: number;
  now?: () => number;
  livenessReportMs?: number;
  onLivenessReport?: (
    state: ConnectionState,
    lastLivenessEvidenceAt: number | null,
  ) => void;
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
  private livenessReportMs: number;
  private onLivenessReport?: (
    state: ConnectionState,
    lastLivenessEvidenceAt: number | null,
  ) => void;
  private lastLivenessReportAt: number | null = null;

  constructor(private push: PushSource, opts?: ConnectionManagerOptions) {
    this.networkRetryMs = opts?.networkRetryMs ?? 5000;
    this.streamRetryMs = opts?.streamRetryMs ?? 1000;
    this.now = opts?.now ?? Date.now;
    this.livenessReportMs = opts?.livenessReportMs ?? 30_000;
    this.onLivenessReport = opts?.onLivenessReport;
  }

  private noteLivenessEvidence(): void {
    const at = this.now();
    this.lastLivenessEvidenceAt = at;

    // The stream producing data is the only thing that earns `connected` back.
    // pushLoop cannot do it: initLegyPusher never resolves in the real client,
    // so it declares connected exactly once in its lifetime.
    if (this.state !== "connected") this.setState("connected");

    // Status notifications only fire on a *change* of state, so in the steady
    // case (connected, ops flowing) this timestamp would never leave the
    // process. Report it on a throttle instead — an honest field nobody can
    // read is no better than no field at all.
    if (
      this.lastLivenessReportAt === null ||
      at - this.lastLivenessReportAt >= this.livenessReportMs
    ) {
      this.lastLivenessReportAt = at;
      this.onLivenessReport?.(this.state, at);
    }
  }

  /**
   * Declare the push stream dead from the outside (crash guard, suspend
   * detector).
   *
   * Cancelling the reader only unwinds consumeLoop off the old container — it
   * does nothing to the connection, and `renew()` does not either. After a long
   * suspend the connection is already gone, and the read parked on it cannot
   * fail until undici's 300s h2 timeout fires: that wait was F78, minutes of new
   * messages not arriving with nothing on screen to say so. `killConnection()`
   * detonates that timeout early. It only tears down; linejs's own loop is the
   * sole rebuilder (`docs/line-adapter.md`).
   */
  markStreamDead(reason: string): void {
    console.error(`[LINE] push liveness: marked dead (${reason})`);
    this.setState("reconnecting");
    this.push.killConnection();
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
        // In the real client this never returns. When it does return promptly,
        // linejs's `islisten` guard bailed out early (it is sticky-true once the
        // inner loop starts), and looping straight back would burn a core.
        await sleep(this.streamRetryMs, signal);
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
