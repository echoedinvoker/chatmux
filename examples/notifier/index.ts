/**
 * chatmux reference consumer: tail the event log and hand each event to a hook.
 *
 * The lesson this example exists to teach:
 *
 *   The cursor loop is the source of truth. Subscription is only a latency hint.
 *
 * A consumer built purely on `notifications/resources/updated` loses events whenever
 * it is not connected. A consumer built on a persisted cursor cannot, because the
 * cursor is write-order and survives restarts, backfill, and reordering. So poll the
 * cursor for correctness, and (optionally) let a subscription trigger an early drain
 * for latency. Never the reverse.
 *
 * Run:  bun run examples/notifier/index.ts
 */

import { resolve } from "node:path";

import { McpClient, endpointFromEnv } from "./mcp-client.js";
import { CursorStore, defaultCursorPath } from "./cursor-store.js";
import { notify, type ChatmuxEvent } from "./notify.js";

const POLL_INTERVAL_MS = Number(process.env.NOTIFIER_POLL_MS ?? 15_000);

interface ReadEventsResult {
  events: ChatmuxEvent[];
  next_cursor: string;
  head_cursor: string;
  has_more: boolean;
}

interface ReadEventsError {
  error: string;
  detail: string;
}

type ReadEventsResponse = ReadEventsResult | ReadEventsError;

/** Anything that can answer read_events — lets tests substitute a fake. */
export interface EventSource {
  callTool<T>(name: string, args: Record<string, unknown>): Promise<T>;
}

export interface Sink {
  notify(event: ChatmuxEvent): Promise<void>;
  save(cursor: string): void;
}

/** Fetch the current head, i.e. "start from now, do not replay history". */
export async function head(source: EventSource): Promise<string> {
  const res = await source.callTool<ReadEventsResponse>("read_events", {});
  if ("error" in res) throw new Error(`read_events head failed: ${res.detail}`);
  return res.next_cursor;
}

/**
 * Drain everything after `cursor`, returning the new cursor.
 *
 * The cursor is saved AFTER each successful notify, one event at a time, using that
 * event's own cursor. So a hook that throws halfway through a page leaves the cursor
 * exactly at the last delivered event: no gap, and at most one duplicate on retry.
 */
export async function drain(
  source: EventSource,
  sink: Sink,
  cursor: string,
): Promise<string> {
  let current = cursor;

  for (;;) {
    const page = await source.callTool<ReadEventsResponse>("read_events", {
      since: current,
      limit: 100,
    });

    if ("error" in page) {
      // The stored token was not issued by this core — different data dir, or a
      // format change. Resyncing from head loses backlog but beats stalling.
      console.error(`[notifier] ${page.error}: ${page.detail} — resyncing from head`);
      const fresh = await head(source);
      sink.save(fresh);
      return fresh;
    }

    // Our cursor is ahead of the log: SQLite was rebuilt or truncated under us.
    if (page.events.length === 0 && isAhead(current, page.head_cursor)) {
      console.error(
        `[notifier] cursor ${current} is ahead of head ${page.head_cursor} — log shrank, resyncing`,
      );
      sink.save(page.head_cursor);
      return page.head_cursor;
    }

    for (const event of page.events) {
      await notifyThenAdvance(sink, event);
      current = event.cursor;
    }

    if (!page.has_more) return current;
  }
}

async function notifyThenAdvance(sink: Sink, event: ChatmuxEvent): Promise<void> {
  await sink.notify(event);
  sink.save(event.cursor);
}

/**
 * Compares two cursors. This is the ONE place allowed to look inside the token, and
 * only to detect the log-shrank case — a consumer must otherwise treat cursors as
 * opaque. Kept in a single named function so the exception stays visible.
 */
function isAhead(cursor: string, headCursor: string): boolean {
  const seq = (c: string) => Number(c.replace(/^evt:/, ""));
  const a = seq(cursor);
  const b = seq(headCursor);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Load the notify hook.
 *
 * `notify.ts` in this directory is a *demonstration* hook that prints to stdout. Your
 * real policy — which chats matter, where notifications go, quiet hours, credentials —
 * should not live in this repository at all. Point `CHATMUX_NOTIFY_HOOK` at a module of
 * your own exporting `notify(event)` and it is used instead.
 *
 * That keeps the three layers honest: primitives in core, a minimal reference consumer
 * here, and your policy in your own private config.
 */
export async function loadNotifyHook(
  hookPath: string | undefined,
): Promise<(event: ChatmuxEvent) => Promise<void>> {
  if (!hookPath) return notify;

  const resolved = resolve(hookPath);
  const mod = (await import(resolved)) as { notify?: unknown };

  if (typeof mod.notify !== "function") {
    throw new Error(`${resolved} does not export a notify() function`);
  }

  console.error(`[notifier] using hook ${resolved}`);
  return mod.notify as (event: ChatmuxEvent) => Promise<void>;
}

async function main(): Promise<void> {
  const notifyFn = await loadNotifyHook(process.env.CHATMUX_NOTIFY_HOOK);

  const client = new McpClient(endpointFromEnv());
  await client.connect();
  console.error("[notifier] connected to chatmux");

  const store = new CursorStore(defaultCursorPath());
  const sink: Sink = { notify: notifyFn, save: c => store.save(c) };

  let cursor = store.load();
  if (cursor == null) {
    cursor = await head(client);
    store.save(cursor);
    console.error(`[notifier] first run — starting from ${cursor} (history not replayed)`);
  } else {
    console.error(`[notifier] resuming from ${cursor}`);
  }

  for (;;) {
    try {
      cursor = await drain(client, sink, cursor);
    } catch (err) {
      // Cursor is unchanged, so the failed event is retried next tick.
      console.error("[notifier] drain failed, retrying next tick:", err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error("[notifier] fatal:", err);
    process.exit(1);
  });
}
