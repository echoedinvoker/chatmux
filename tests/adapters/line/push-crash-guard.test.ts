import { describe, it, expect } from "bun:test";
import {
  isPushStreamFailure,
  isTransientResolverFailure,
  installPushCrashGuard,
} from "../../../src/adapters/line/push.js";

function m4Replica(): Error {
  const cause = new Error('HTTP/2: "stream timeout after 300000"');
  cause.name = "InformationalError";
  const err = new TypeError("fetch failed");
  (err as any).cause = cause;
  return err;
}

describe("isPushStreamFailure", () => {
  it("matches the M4 undici h2 stream timeout shape", () => {
    expect(isPushStreamFailure(m4Replica())).toBe(true);
  });

  it("matches a plain socket-level network error", () => {
    const err = new Error("read ECONNRESET");
    (err as any).code = "ECONNRESET";
    expect(isPushStreamFailure(err)).toBe(true);
  });

  it("does NOT match an ordinary programming bug", () => {
    expect(isPushStreamFailure(new TypeError("x is not a function"))).toBe(false);
  });

  it("does NOT match a non-Error rejection value", () => {
    expect(isPushStreamFailure(null)).toBe(false);
    expect(isPushStreamFailure("boom")).toBe(false);
  });

  it("does NOT match a fetch failure with an unrelated cause", () => {
    const err = new TypeError("fetch failed");
    (err as any).cause = new Error("certificate has expired");
    expect(isPushStreamFailure(err)).toBe(false);
  });
});

describe("isTransientResolverFailure", () => {
  it("matches EAI_AGAIN on the error itself", () => {
    expect(
      isTransientResolverFailure(Object.assign(new Error("getaddrinfo EAI_AGAIN x"), { code: "EAI_AGAIN" })),
    ).toBe(true);
  });

  it("matches EAI_AGAIN nested as a cause, which is the shape F85 arrived in", () => {
    const cause = Object.assign(new Error("getaddrinfo EAI_AGAIN x"), { code: "EAI_AGAIN" });
    const err = new TypeError("fetch failed");
    (err as any).cause = cause;
    expect(isTransientResolverFailure(err)).toBe(true);
  });

  it("does NOT match ENOTFOUND — a name that does not exist is not transient", () => {
    expect(
      isTransientResolverFailure(Object.assign(new Error("getaddrinfo ENOTFOUND typo"), { code: "ENOTFOUND" })),
    ).toBe(false);
  });

  it("does NOT match on message text alone, without the code", () => {
    expect(isTransientResolverFailure(new Error("getaddrinfo EAI_AGAIN legy.line-apps.com"))).toBe(false);
    expect(isTransientResolverFailure(new TypeError("fetch failed"))).toBe(false);
  });

  it("does NOT match an ordinary bug or a non-Error value", () => {
    expect(isTransientResolverFailure(new TypeError("x is not a function"))).toBe(false);
    expect(isTransientResolverFailure(null)).toBe(false);
    expect(isTransientResolverFailure("boom")).toBe(false);
  });

  it("terminates on a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b");
    (a as any).cause = b;
    (b as any).cause = a;
    expect(isTransientResolverFailure(a)).toBe(false);
  });
});

function fakeProc() {
  const handlers: ((reason: unknown) => void)[] = [];
  return {
    on(event: string, fn: (reason: unknown) => void) {
      if (event === "unhandledRejection") handlers.push(fn);
      return this;
    },
    emitRejection(reason: unknown) {
      for (const fn of handlers) fn(reason);
    },
  };
}

describe("installPushCrashGuard", () => {
  it("routes a push stream failure to reconnect, not to fatal", () => {
    const proc = fakeProc();
    const streamFailures: unknown[] = [];
    const fatals: unknown[] = [];
    installPushCrashGuard({
      proc: proc as any,
      onStreamFailure: (e) => streamFailures.push(e),
      onFatal: (e) => fatals.push(e),
    });

    proc.emitRejection(m4Replica());

    expect(streamFailures).toHaveLength(1);
    expect(fatals).toHaveLength(0);
  });

  it("re-raises an unrelated rejection so real bugs still fail fast", () => {
    const proc = fakeProc();
    const streamFailures: unknown[] = [];
    const fatals: unknown[] = [];
    installPushCrashGuard({
      proc: proc as any,
      onStreamFailure: (e) => streamFailures.push(e),
      onFatal: (e) => fatals.push(e),
    });

    proc.emitRejection(new TypeError("x is not a function"));

    expect(streamFailures).toHaveLength(0);
    expect(fatals).toHaveLength(1);
  });
});

describe("installPushCrashGuard during the login window", () => {
  const dnsErr = () => Object.assign(new Error("getaddrinfo EAI_AGAIN legy.line-apps.com"), {
    code: "EAI_AGAIN",
  });

  it("hands a DNS failure to the login retry instead of killing the process", () => {
    const proc = fakeProc();
    const seen: string[] = [];
    installPushCrashGuard({
      proc: proc as any,
      onStreamFailure: () => seen.push("stream"),
      onFatal: () => seen.push("fatal"),
      onLoginWindowNetworkError: () => seen.push("login"),
      isLoggedIn: () => false,
    });
    proc.emitRejection(dnsErr());
    expect(seen).toEqual(["login"]);
  });

  it("still crashes on an unexplained rejection before login", () => {
    const proc = fakeProc();
    const seen: string[] = [];
    installPushCrashGuard({
      proc: proc as any,
      onStreamFailure: () => seen.push("stream"),
      onFatal: () => seen.push("fatal"),
      onLoginWindowNetworkError: () => seen.push("login"),
      onRecoverableNetworkError: () => seen.push("recover"),
      isLoggedIn: () => false,
    });
    proc.emitRejection(new TypeError("x is not a function"));
    expect(seen).toEqual(["fatal"]);
  });
});

/**
 * F85, 2026-08-19: waking from suspend with DNS not yet back killed the adapter
 * outright. The rejection arrives *after* login, so the login-window exemption
 * above does not apply and it went straight to onFatal.
 *
 * These lock the fix in one direction and its own limit in the other: a DNS
 * "try again later" recovers, and anything we cannot explain still crashes.
 */
describe("installPushCrashGuard after login, on a transient resolver failure", () => {
  /** The exact shape from the journal: the code lives on the *cause*. */
  const f85Replica = () => {
    const cause = Object.assign(new Error("getaddrinfo EAI_AGAIN legy.line-apps.com"), {
      code: "EAI_AGAIN",
    });
    const err = new TypeError("fetch failed");
    (err as any).cause = cause;
    return err;
  };

  function guard(seen: string[], opts: { withRecoveryDep: boolean }) {
    const proc = fakeProc();
    installPushCrashGuard({
      proc: proc as any,
      onStreamFailure: () => seen.push("stream"),
      onFatal: () => seen.push("fatal"),
      onLoginWindowNetworkError: () => seen.push("login"),
      isLoggedIn: () => true,
      ...(opts.withRecoveryDep
        ? { onRecoverableNetworkError: () => seen.push("recover") }
        : {}),
    });
    return proc;
  }

  it("recovers from the journal's nested EAI_AGAIN instead of killing the process", () => {
    const seen: string[] = [];
    guard(seen, { withRecoveryDep: true }).emitRejection(f85Replica());
    expect(seen).toEqual(["recover"]);
  });

  it("recovers when the code sits on the top-level error", () => {
    const seen: string[] = [];
    guard(seen, { withRecoveryDep: true }).emitRejection(
      Object.assign(new Error("getaddrinfo EAI_AGAIN legy.line-apps.com"), {
        code: "EAI_AGAIN",
      }),
    );
    expect(seen).toEqual(["recover"]);
  });

  it("reports how many times it has recovered, so a stuck resolver is visible", () => {
    const counts: number[] = [];
    const proc = fakeProc();
    installPushCrashGuard({
      proc: proc as any,
      onStreamFailure: () => {},
      onFatal: () => {},
      isLoggedIn: () => true,
      onRecoverableNetworkError: (_err, consecutive) => counts.push(consecutive),
    });
    proc.emitRejection(f85Replica());
    proc.emitRejection(f85Replica());
    expect(counts).toEqual([1, 2]);
  });

  it("falls back to the reconnect path when no recovery handler is wired", () => {
    const seen: string[] = [];
    guard(seen, { withRecoveryDep: false }).emitRejection(f85Replica());
    expect(seen).toEqual(["stream"]);
  });

  // The regression locks. If any of these ever go green by recovering instead of
  // crashing, the fix has been widened into the silence it was meant to avoid.
  it("still crashes on an unexplained rejection once we are logged in", () => {
    const seen: string[] = [];
    guard(seen, { withRecoveryDep: true }).emitRejection(new TypeError("x is not a function"));
    expect(seen).toEqual(["fatal"]);
  });

  it("still crashes on a fetch failure whose cause is NOT a resolver failure", () => {
    const seen: string[] = [];
    const err = new TypeError("fetch failed");
    (err as any).cause = new Error("certificate has expired");
    guard(seen, { withRecoveryDep: true }).emitRejection(err);
    expect(seen).toEqual(["fatal"]);
  });

  it("still crashes on a name that does not exist (ENOTFOUND is not transient)", () => {
    const seen: string[] = [];
    guard(seen, { withRecoveryDep: true }).emitRejection(
      Object.assign(new Error("getaddrinfo ENOTFOUND legy.line-apps.example"), {
        code: "ENOTFOUND",
      }),
    );
    expect(seen).toEqual(["fatal"]);
  });

  it("still crashes on a non-Error rejection value", () => {
    const seen: string[] = [];
    const proc = guard(seen, { withRecoveryDep: true });
    proc.emitRejection(null);
    proc.emitRejection("boom");
    expect(seen).toEqual(["fatal", "fatal"]);
  });
});
