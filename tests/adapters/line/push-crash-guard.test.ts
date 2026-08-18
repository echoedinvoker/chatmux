import { describe, it, expect } from "bun:test";
import {
  isPushStreamFailure,
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

  it("still crashes on the same error once we are logged in", () => {
    const proc = fakeProc();
    const seen: string[] = [];
    installPushCrashGuard({
      proc: proc as any,
      onStreamFailure: () => seen.push("stream"),
      onFatal: () => seen.push("fatal"),
      onLoginWindowNetworkError: () => seen.push("login"),
      isLoggedIn: () => true,
    });
    proc.emitRejection(dnsErr());
    expect(seen).toEqual(["fatal"]);
  });
});
