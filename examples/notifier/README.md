# notifier — chatmux reference consumer

A minimal consumer that tails the chatmux event log and hands each new message to a
hook you fill in.

It exists for two reasons:

1. **Documentation that compiles.** "How do I write a chatmux consumer?" answered by
   working code instead of prose.
2. **Pressure-testing the primitives.** If `read_events` is awkward to build on, that
   shows up here, in this repo's CI, before a third party opens an issue about it.

## This is not part of core

`examples/` sits on the **consumer** side of the MCP boundary — the same side as
Claude Code and [chat.nvim](https://github.com/echoedinvoker/chat.nvim). It gets no
special access, and **it may not import from `src/`** (NEVER #11). That rule is
enforced by `tests/examples/boundary.test.ts`, not left to review.

Being in the repo is a packaging choice. Being outside core is an architectural one.
The two are independent.

## Run it

```bash
bun run start                          # daemon, in another terminal
bun run examples/notifier/index.ts
```

| Env | Default | Purpose |
|-----|---------|---------|
| `CHATMUX_SOCKET` | (unset) | Unix socket path. Preferred when set |
| `CHATMUX_MCP_PORT` | `7717` | Loopback TCP port, used when no socket is set |
| `CHATMUX_DATA_DIR` | `~/.local/share/chatmux` | Where the cursor file lives |
| `NOTIFIER_POLL_MS` | `15000` | Poll interval |

Cursor state: `$CHATMUX_DATA_DIR/consumers/notifier/cursor.json`. Delete it to start
over from now; it is not part of chatmux's data model, it is this consumer's own.

## Files

| File | Role |
|------|------|
| `notify.ts` | **The hook — the file you edit.** All policy lives here |
| `index.ts` | The drain loop and its recovery cases |
| `mcp-client.ts` | Minimal MCP Streamable HTTP client, raw `fetch`, no SDK |
| `cursor-store.ts` | Durable cursor persistence (temp file + rename) |

`mcp-client.ts` deliberately avoids `@modelcontextprotocol/sdk` so the file doubles as
a wire-protocol reference: a consumer in Python or Go needs exactly these HTTP calls.

## The design lesson

> The cursor loop is the source of truth. Subscription is only a latency hint.

A consumer built purely on `notifications/resources/updated` loses every event that
arrives while it is disconnected. A consumer built on a persisted cursor cannot,
because the cursor is **write order** — it survives restarts, and it survives backfill
inserting messages whose timestamps predate everything already stored.

So: poll the cursor for correctness. Optionally let a subscription trigger an early
drain for latency. Never the reverse.

### Delivery semantics

`index.ts` saves the cursor **after** each successful `notify()`, one event at a time,
using that event's own cursor. Consequences:

- A hook that throws mid-page leaves the cursor at the last *delivered* event — no gap.
- That event is retried on the next poll, so delivery is **at-least-once**. For
  notifications this is the right trade: a duplicate is cheaper than a miss.
- If your hook is not idempotent, dedup inside it.

Cursor values are **sparse** — `INSERT OR IGNORE` consumes sequence numbers it never
uses, so gaps are normal. Ask `has_more` whether more is pending; never subtract two
cursors to guess *how much*. On a real 1644-message store the sequence had already
reached 18744.

### Recovery cases it handles

| Situation | Response |
|-----------|----------|
| First run, no cursor file | Fetch head, start from now, do not replay history |
| Cursor file corrupt | Log, resync from head |
| Daemon returns `invalid_cursor` | Resync from head (different data dir, or format change) |
| Cursor ahead of `head_cursor` | SQLite was rebuilt or truncated — resync to head |
| Nothing new | Hold position; do not rewind |

## Policy is yours, and stays out of this repo

`notify.ts` prints to stdout and filters nothing. Shipping a default filter would be
this example smuggling in an opinion — and which chats matter, where notifications go,
how to collapse a repeated alert, and when to stay quiet all have different right
answers per person.

Your actual rules, tokens, and quiet hours are a third layer that belongs in your own
config, not in a public repo:

```
src/core/            primitives, no opinions          (public)
examples/notifier/   reference consumer, minimal      (public)
your config          your policy, your credentials    (private)
```

One note on `NEVER #10` (never log message content above debug level): that constrains
the **core daemon**, whose logs are incidental. Surfacing message content is this
program's entire purpose, so printing it here is not a violation of that rule.
