export interface ReconnectCatchupDeps {
  runCatchup: (platform: string) => Promise<void>;
}

export interface ReconnectCatchupTrigger {
  onStatus(platform: string, state: string): Promise<void>;
}

interface PlatformState {
  wasOffline: boolean;
  inFlight: Promise<void> | null;
}

/**
 * Runs catch-up when an adapter comes back after losing its connection.
 *
 * Until F27, a dead push stream crashed the adapter; the respawned child never
 * re-ran cold start (only `initialize`), so the gap was filled by nothing —
 * except when the whole daemon happened to restart. Now that the adapter
 * survives, that accident is gone, and the reconnect has to fill the gap
 * deliberately.
 *
 * The first `connected` is cold start's job, so it is ignored here.
 */
export function createReconnectCatchupTrigger(
  deps: ReconnectCatchupDeps,
): ReconnectCatchupTrigger {
  const states = new Map<string, PlatformState>();

  const stateFor = (platform: string): PlatformState => {
    let s = states.get(platform);
    if (!s) {
      s = { wasOffline: false, inFlight: null };
      states.set(platform, s);
    }
    return s;
  };

  return {
    async onStatus(platform, state) {
      const s = stateFor(platform);

      if (state !== "connected") {
        s.wasOffline = true;
        return;
      }

      if (!s.wasOffline) return;
      s.wasOffline = false;

      // A second reconnect while catch-up is still running waits for the one in
      // flight rather than starting a competing pass over the same backlog.
      if (s.inFlight) {
        await s.inFlight;
        return;
      }

      const run = deps.runCatchup(platform).finally(() => {
        s.inFlight = null;
      });
      s.inFlight = run;
      await run;
    },
  };
}
