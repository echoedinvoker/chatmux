/**
 * Turns "the adapter reported its status" into "the adapter's status *changed*".
 *
 * Adapters report status on a heartbeat, not only on transitions, so wiring
 * `notify` straight to `onStatus` would push a `chat://status` notification on
 * every heartbeat — and every push makes each subscriber re-read the resource,
 * which runs COUNT(*) queries over storage. Remembering the last state we
 * actually announced drops that from "per report" to "per transition"
 * (24 days of journal: 43 transitions, roughly twice a day).
 *
 * It lives in its own module because daemon.ts has module-level side effects and
 * cannot be imported by a test — the same reason createReconnectCatchupTrigger
 * was split out.
 */
export function createStatusChangeNotifier(deps: { notify: () => void }): {
  onStatus(platform: string, state: string): void;
} {
  // Per platform, not one shared value: LINE and Telegram report independently,
  // and a single slot would let one platform's heartbeat mask the other's
  // transition.
  const lastAnnounced = new Map<string, string>();

  return {
    onStatus(platform: string, state: string): void {
      if (lastAnnounced.get(platform) === state) return;
      lastAnnounced.set(platform, state);
      deps.notify();
    },
  };
}
