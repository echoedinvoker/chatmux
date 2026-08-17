import { test, expect } from "bun:test";
import { createStatusChangeNotifier } from "../../src/core/mcp/status-notify.js";

// Why this lives in its own module rather than inside daemon.ts: daemon.ts has
// module-level side effects and cannot be imported by a test. Same reason
// createReconnectCatchupTrigger was split out.

test("T-NOTIFY-DEDUPE: same state twice notifies once", () => {
  const seen: string[] = [];
  const n = createStatusChangeNotifier({ notify: () => seen.push("x") });
  n.onStatus("line", "connected");
  n.onStatus("line", "connected");
  expect(seen.length).toBe(1);
});

test("T-NOTIFY-CHANGE: a real transition notifies again", () => {
  const seen: string[] = [];
  const n = createStatusChangeNotifier({ notify: () => seen.push("x") });
  n.onStatus("line", "connected");
  n.onStatus("line", "reconnecting");
  expect(seen.length).toBe(2);
});

test("T-NOTIFY-PER-PLATFORM: platforms remember separately", () => {
  const seen: string[] = [];
  const n = createStatusChangeNotifier({ notify: () => seen.push("x") });
  n.onStatus("line", "connected");
  n.onStatus("telegram", "connected");
  expect(seen.length).toBe(2);
});
