# SafetyRail

Three layers of protection in a two-tier design, so chatmux can never accidentally spam
the people you talk to or retry a failure forever.

## Three layers

```
send_message request
  │
  ├─ Layer 1: RateLimiter (frequency control)
  │   └─ over limit → queue and wait (does not reject; waits out the window)
  │
  ├─ Layer 2: ErrorTracker (consecutive-error backoff)
  │   └─ consecutive failures → exponential backoff 5 → 10 → 20 s
  │   └─ reaches the kill threshold → trips the KillSwitch
  │
  └─ Layer 3: KillSwitch (emergency stop)
      └─ tripped → disconnect the adapter, manual reset required
```

### RateLimiter

Sliding-window rate limiter tracking sends over the last 60 seconds.

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `maxPerMinute` | 5 | Maximum sends per minute |

Behavior:

- Under the limit → passes immediately, records a timestamp.
- Over the limit → queues, and releases automatically once the oldest timestamp ages past 60 seconds.
- Never rejects a request, only delays it — dropping a legitimate message would be worse.

### ErrorTracker

Counts consecutive errors and backs off exponentially.

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `killThreshold` | 3 | Consecutive errors that trip a kill |
| `initialBackoffMs` | 5,000 | First backoff, in milliseconds |
| `maxBackoffMs` | 20,000 | Maximum backoff, in milliseconds |

Behavior:

- Error → `consecutiveErrors++` → `sleep(backoffMs)` → `backoffMs *= 2`, capped at `maxBackoffMs`.
- Success → `reset()`: counter to zero, backoff back to its initial value.
- Consecutive errors reaching `killThreshold` → returns `"kill"` → trips the KillSwitch.
- **Network errors are excluded**: when `isNetworkError(err)` is true the error is not counted, because a dropped connection is the reconnect logic's problem, not a send-policy failure.

### KillSwitch

The emergency stop.

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `threshold` | 1 | Anomalies recorded before a kill trips. SafetyRail uses 1, so a single ErrorTracker kill is enough |

Behavior:

- `recordAnomaly()` → accumulates; at the threshold sets `killed = true` and fires every kill listener.
- `recordNormal()` → resets the anomaly count, but does **not** clear `killed`.
- `reset()` → `killed = false` and count to zero. This is the manual recovery path.

### SafetyRail facade

Composes the three layers behind one interface.

```typescript
class SafetyRail {
  rateLimiter: RateLimiter;      // 5/min
  errorTracker: ErrorTracker;    // kill at 3, backoff 5→10→20s
  killSwitch: KillSwitch;        // threshold 1

  recordError(err): void;        // skips network errors; otherwise drives ErrorTracker,
                                 // which may trip the KillSwitch
  recordSuccess(): void;         // resets ErrorTracker + KillSwitch.recordNormal()
  reset(): void;                 // clears everything (manual recovery)
  onKill(fn): void;              // register a kill callback
}
```

## Two-tier design (Core + Adapter)

### Why the architecture enforces it

An adapter is a child process and **can only reach core over stdio**. Every
`send_message` therefore travels MCP tool → core SafetyRail → adapter runner → adapter.
There is no code path that bypasses SafetyRail.

### How the two tiers interact

1. **Core sets the floor.** SafetyRail defaults to 5/min as the safety net.
2. **The adapter reports.** Its `initialize` response includes `platform_rate_limits`.
3. **The stricter value wins.** Core compares its own default against what the adapter reported and takes whichever is tighter.

```
Core default: 5/min
Adapter reports: 3/min (platform limit)
→ Core uses: 3/min (stricter)

Core default: 5/min
Adapter reports: 10/min
→ Core uses: 5/min (core default is stricter, adapter cannot loosen)
```

**An adapter can only tighten, never loosen** — the core floor is the last line of defense.

### Why adapters do not rate-limit themselves

- An adapter crash or restart loses the counter state.
- With multiple adapters (v0.2+), core is the only place with a global view.
- The security boundary lives in core, and adapters are untrusted. Even a maliciously
  modified adapter must not be able to get around core.

## Separate ErrorTracker instances

chatmux runs **two independent ErrorTracker + KillSwitch pairs** whose counts never
interfere with each other.

### (A) Inside SafetyRail: send failures

| Item | Value |
|------|-------|
| Tracks | Consecutive `send_message` failures |
| ErrorTracker kill threshold | 3 |
| KillSwitch action | Disconnect the adapter |
| Recovery | `safetyRail.reset()` (manual) |

### (B) In the Adapter Runner: process crashes

| Item | Value |
|------|-------|
| Tracks | Consecutive adapter child-process crashes (non-zero exit) |
| ErrorTracker kill threshold | 5 |
| KillSwitch action | Stop attempting restarts |
| Recovery | Restart the daemon, or `adapterRunner.reset()` (manual) |

**Why they are separate:**

- Send failures and process crashes are different failure modes.
- An adapter can be perfectly healthy while sends keep failing — for instance the
  recipient blocked you. Kill sending, do not stop the adapter.
- An adapter can crash while sending is fine — a push-connection bug, say. Stop
  restarting it without touching SafetyRail's counters.

## Recovery

### Automatic

- **A successful send** → `SafetyRail.recordSuccess()` clears the ErrorTracker count and the KillSwitch anomaly count (but not a `killed` state).
- **An adapter starting cleanly** → the Adapter Runner's ErrorTracker clears its count.

### Manual, after a KillSwitch trip

Once `killed = true`, nothing recovers on its own. Either:

1. Call `safetyRail.reset()` to clear SafetyRail's KillSwitch, or
2. Restart the daemon to clear all state.

In v0.1 the manual path is a daemon restart (`systemctl --user restart chatmux`). A
`reset_safety` MCP tool is under consideration for v0.2.

## Provenance

SafetyRail was lifted from line-tui's `src/safety.ts` (164 lines). The core logic is
unchanged; the differences are:

| Item | line-tui | chatmux |
|------|----------|---------|
| `isNetworkError` check | imported from `connection.ts` | needs abstracting — core is platform-agnostic |
| KillSwitch callback | stopped the TUI directly | tells the adapter runner to disconnect |
| Adapter runner ErrorTracker | did not exist | added, kill at 5 |
