/**
 * Login supervision for the LINE adapter (F77).
 *
 * The bug this exists to remove: after the host wakes from suspend the very
 * first login runs while there is still no network, `auth.ts` read that as "the
 * saved token stopped working", fell into the QR loop nobody can see, and then
 * never tried again. Four hours and forty-seven minutes of silence on
 * 2026-08-18.
 *
 * So the whole point of this module is to keep two things apart that used to be
 * one: "we could not reach LINE" and "LINE rejected us". The first is retried
 * forever and must NEVER reach the QR path (scanning a QR is re-authentication,
 * and hammering that carries account risk — README → Account Risk Warning). The
 * second is not retried at all: a human has to deal with it.
 */

export type LoginFailureKind = "network" | "credential" | "unknown";

const NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
]);

const NETWORK_MESSAGE_MARKERS = [
  "fetch failed",
  "network is unreachable",
  "socket hang up",
];

const CREDENTIAL_MESSAGE_MARKERS = [
  "authentication_failed",
  "invalid_token",
  "not_authorized_device",
];

/**
 * Unlike `isPushStreamFailure` in push.ts — which deliberately refuses to match
 * on message text, because "fetch failed" is also what an expired TLS cert says
 * — this one does match messages. That is a considered trade-off, not an
 * oversight: it only ever runs on the login path, and the cost of a wrong guess
 * here is a few extra retries, not a real bug swallowed in silence.
 *
 * `unknown` must never drift towards `network`: an unrecognised failure gets a
 * bounded number of attempts, not an unbounded one.
 */
export function classifyLoginFailure(err: unknown): LoginFailureKind {
  let current: unknown = err;
  // Bounded like push.ts's walk, so a cyclic `cause` cannot hang us.
  for (let depth = 0; depth < 3; depth++) {
    if (!(current instanceof Error)) return "unknown";

    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return "network";

    const msg = current.message.toLowerCase();
    if (CREDENTIAL_MESSAGE_MARKERS.some((m) => msg.includes(m))) return "credential";
    if (NETWORK_MESSAGE_MARKERS.some((m) => msg.includes(m))) return "network";

    current = (current as { cause?: unknown }).cause;
    if (current === undefined || current === null) return "unknown";
  }
  return "unknown";
}

export interface LoginSupervisorDeps {
  /** One login attempt. Throws on failure — the throw is what gets classified. */
  attemptLogin: () => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  initialBackoffMs: number;
  maxBackoffMs: number;
  /** How many unrecognised failures we tolerate before handing over to a human. */
  unknownAttemptLimit: number;
  onAttemptFailed?: (kind: LoginFailureKind, attempt: number, nextDelayMs: number) => void;
}

export interface LoginSupervisorResult {
  outcome: "logged-in" | "needs-human";
  kind?: LoginFailureKind;
  client?: unknown;
  error?: unknown;
}

export interface LoginSupervisor {
  run(): Promise<LoginSupervisorResult>;
}

/**
 * Retry policy, and why each branch is what it is:
 *
 * - `network`  → unbounded retries. The network coming back is a matter of
 *                when, not if, and giving up is exactly today's bug.
 * - `credential` → one attempt, full stop. Retrying a login LINE has actively
 *                rejected is how accounts get restricted (R1).
 * - `unknown`  → bounded. We do not know whether waiting helps, so we try a
 *                limited number of times and then stop rather than guess.
 *
 * The backoff doubles from `initialBackoffMs` and is capped at `maxBackoffMs`,
 * which is what keeps an all-night outage from turning into an all-night
 * hammering of LINE's login endpoint.
 */
export function createLoginSupervisor(deps: LoginSupervisorDeps): LoginSupervisor {
  return {
    async run(): Promise<LoginSupervisorResult> {
      let attempt = 0;
      let unknownFailures = 0;

      for (;;) {
        attempt++;
        try {
          const client = await deps.attemptLogin();
          return { outcome: "logged-in", client };
        } catch (err) {
          const kind = classifyLoginFailure(err);

          if (kind === "credential") {
            return { outcome: "needs-human", kind, error: err };
          }
          if (kind === "unknown") {
            unknownFailures++;
            if (unknownFailures >= deps.unknownAttemptLimit) {
              return { outcome: "needs-human", kind, error: err };
            }
          }

          const nextDelayMs = Math.min(
            deps.initialBackoffMs * 2 ** (attempt - 1),
            deps.maxBackoffMs,
          );
          deps.onAttemptFailed?.(kind, attempt, nextDelayMs);
          await deps.sleep(nextDelayMs);
        }
      }
    },
  };
}

/**
 * The one gate that stands between a network outage and a QR prompt nobody can
 * see. Scanning a QR code is re-authentication, and under the daemon there is
 * no terminal for the code to appear on — so falling into it during an outage
 * is both useless and account-risky (R1/R7).
 *
 * `unknown` deliberately does NOT fall back either: we would rather stop and
 * ask for a human than re-authenticate on a guess. First installs are
 * unaffected — with no saved token, the QR path is the only path there is.
 */
export function shouldFallBackToQr(input: {
  hasSavedToken: boolean;
  kind: LoginFailureKind;
}): boolean {
  if (!input.hasSavedToken) return true;
  return input.kind === "credential";
}

interface StatusResponder {
  notify(method: string, params: unknown): void;
}

export interface RunLoginFlowDeps extends LoginSupervisorDeps {
  responder: StatusResponder;
  onLoggedIn: (client: unknown) => Promise<void>;
}

/**
 * Wraps the supervisor in the two things the outside world needs from it:
 * saying "I am still trying" while it retries, and saying "I have stopped, come
 * and look" when it gives up.
 *
 * ⚠️ The `error` state string is NOT a member of push.ts's `ConnectionState`
 * union (`connected` / `reconnecting` / `killed`). It is a protocol-level
 * string, and deliberately kept out of that type so this file cannot drag
 * `ConnectionManager` along with it. Downstream is safe: core's AdapterManager
 * stores the string verbatim and sets connected=false, and chat.nvim treats
 * anything that is not `connected` as offline.
 *
 * ⚠️ On success this does NOT announce `connected` — ConnectionManager is the
 * sole producer of connection state, from evidence. Login succeeding says
 * nothing about whether the push stream is up.
 */
export async function runLoginFlow(deps: RunLoginFlowDeps): Promise<void> {
  const supervisor = createLoginSupervisor({
    attemptLogin: deps.attemptLogin,
    sleep: deps.sleep,
    initialBackoffMs: deps.initialBackoffMs,
    maxBackoffMs: deps.maxBackoffMs,
    unknownAttemptLimit: deps.unknownAttemptLimit,
    onAttemptFailed: (kind, attempt, nextDelayMs) => {
      // One line per attempt, and the backoff itself keeps them spaced out —
      // an all-night outage must not fill journald (R8).
      console.error(
        `[LINE] login attempt ${attempt} failed (${kind}); retrying in ${Math.round(nextDelayMs / 1000)}s`,
      );
      deps.responder.notify("status", { state: "reconnecting" });
      deps.onAttemptFailed?.(kind, attempt, nextDelayMs);
    },
  });

  const result = await supervisor.run();

  if (result.outcome === "logged-in") {
    await deps.onLoggedIn(result.client);
    return;
  }

  const message =
    result.kind === "credential"
      ? "LINE rejected the saved login, so a human has to sign in again. Retrying on our own would only risk the account."
      : `LINE login gave up after an unrecognised failure (${result.error instanceof Error ? result.error.message : result.error}).`;
  console.error(`[LINE] login supervisor stopped: ${message}`);
  deps.responder.notify("status", { state: "error" });
  deps.responder.notify("error", { message });
}
