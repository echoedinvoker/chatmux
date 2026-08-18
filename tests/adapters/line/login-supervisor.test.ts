import { describe, it, expect } from "bun:test";
import { classifyLoginFailure } from "../../../src/adapters/line/login-supervisor.js";

describe("classifyLoginFailure", () => {
  it("calls a DNS temporary failure a network problem", () => {
    const err = Object.assign(new Error("getaddrinfo EAI_AGAIN legy.line-apps.com"), {
      code: "EAI_AGAIN",
    });
    expect(classifyLoginFailure(err)).toBe("network");
  });

  it("calls undici's bare 'fetch failed' a network problem", () => {
    expect(classifyLoginFailure(new Error("fetch failed"))).toBe("network");
  });

  it("calls the platform rejecting our token a credential problem", () => {
    expect(classifyLoginFailure(new Error("AUTHENTICATION_FAILED"))).toBe("credential");
  });

  it("refuses to guess for anything else", () => {
    expect(classifyLoginFailure(new Error("boom"))).toBe("unknown");
  });
});

import { createLoginSupervisor } from "../../../src/adapters/line/login-supervisor.js";

const netErr = () => Object.assign(new Error("fetch failed"), { code: "EAI_AGAIN" });

describe("createLoginSupervisor", () => {
  it("retries a network failure until the network comes back", async () => {
    const waits: number[] = [];
    let calls = 0;
    const sup = createLoginSupervisor({
      attemptLogin: async () => {
        calls++;
        if (calls < 3) throw netErr();
        return { ok: true } as any;
      },
      sleep: async (ms: number) => { waits.push(ms); },
      initialBackoffMs: 5_000,
      maxBackoffMs: 300_000,
      unknownAttemptLimit: 10,
    });

    const result = await sup.run();
    expect(result.outcome).toBe("logged-in");
    expect(calls).toBe(3);
    expect(waits).toEqual([5_000, 10_000]);
  });

  it("does not retry when the platform rejected the credentials", async () => {
    let calls = 0;
    const sup = createLoginSupervisor({
      attemptLogin: async () => { calls++; throw new Error("AUTHENTICATION_FAILED"); },
      sleep: async () => {},
      initialBackoffMs: 5_000,
      maxBackoffMs: 300_000,
      unknownAttemptLimit: 10,
    });

    const result = await sup.run();
    expect(result.outcome).toBe("needs-human");
    expect(result.kind).toBe("credential");
    expect(calls).toBe(1);
  });

  it("gives up on an unrecognised failure after the attempt limit", async () => {
    let calls = 0;
    const sup = createLoginSupervisor({
      attemptLogin: async () => { calls++; throw new Error("boom"); },
      sleep: async () => {},
      initialBackoffMs: 5_000,
      maxBackoffMs: 300_000,
      unknownAttemptLimit: 10,
    });

    const result = await sup.run();
    expect(result.outcome).toBe("needs-human");
    expect(calls).toBe(10);
  });

  it("caps how hard it hammers LINE while the network stays down", async () => {
    const waits: number[] = [];
    let calls = 0;
    const sup = createLoginSupervisor({
      attemptLogin: async () => {
        calls++;
        if (calls > 20) return { ok: true } as any;
        throw netErr();
      },
      sleep: async (ms: number) => { waits.push(ms); },
      initialBackoffMs: 5_000,
      maxBackoffMs: 300_000,
      unknownAttemptLimit: 10,
    });

    await sup.run();
    expect(Math.max(...waits)).toBe(300_000);
    expect(waits.filter((w) => w > 300_000)).toHaveLength(0);
  });
});

describe("createLoginSupervisor announcements", () => {
  it("announces every failed attempt so the daemon can say we are retrying", async () => {
    const seen: { kind: string; attempt: number; nextDelayMs: number }[] = [];
    let calls = 0;
    const sup = createLoginSupervisor({
      attemptLogin: async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error("fetch failed"), { code: "EAI_AGAIN" });
        return { ok: true } as any;
      },
      sleep: async () => {},
      initialBackoffMs: 5_000,
      maxBackoffMs: 300_000,
      unknownAttemptLimit: 10,
      onAttemptFailed: (kind, attempt, nextDelayMs) => seen.push({ kind, attempt, nextDelayMs }),
    });

    await sup.run();
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.kind === "network")).toBe(true);
    expect(seen[1].nextDelayMs).toBe(10_000);
  });
});

import { shouldFallBackToQr } from "../../../src/adapters/line/login-supervisor.js";

describe("shouldFallBackToQr", () => {
  it("never scans a QR code just because the network was down", () => {
    expect(shouldFallBackToQr({ hasSavedToken: true, kind: "network" })).toBe(false);
  });

  it("never scans a QR code for a failure it could not classify", () => {
    expect(shouldFallBackToQr({ hasSavedToken: true, kind: "unknown" })).toBe(false);
  });

  it("scans a QR code when LINE itself rejected the saved login", () => {
    expect(shouldFallBackToQr({ hasSavedToken: true, kind: "credential" })).toBe(true);
  });

  it("scans a QR code on a first install, where there is nothing else to try", () => {
    expect(shouldFallBackToQr({ hasSavedToken: false, kind: "credential" })).toBe(true);
  });
});

import { runLoginFlow } from "../../../src/adapters/line/login-supervisor.js";

describe("runLoginFlow", () => {
  it("says out loud when it has given up and needs a human", async () => {
    const notes: { method: string; params: any }[] = [];
    const resp = { notify: (method: string, params: unknown) => notes.push({ method, params: params as any }) };

    await runLoginFlow({
      responder: resp as any,
      attemptLogin: async () => { throw new Error("AUTHENTICATION_FAILED"); },
      sleep: async () => {},
      initialBackoffMs: 5_000,
      maxBackoffMs: 300_000,
      unknownAttemptLimit: 10,
      onLoggedIn: async () => {},
    });

    const states = notes.filter((n) => n.method === "status").map((n) => n.params.state);
    expect(states).toContain("error");
  });
});
