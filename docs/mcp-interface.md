# MCP Interface

chatmux exposes 8 tools, 4 resources, and resource subscription over MCP Streamable
HTTP, on **two listeners at once**.

## Transport

- **Protocol**: MCP Streamable HTTP (HTTP/1.1 + SSE)
- **SDK**: `@modelcontextprotocol/sdk`

Both listeners share one handler and one session map. They are functionally identical;
the only difference is who can reach them.

| Listener | Address | Intended for | Why |
|----------|---------|--------------|-----|
| **Unix socket** | `$CHATMUX_SOCKET` (default `~/.local/share/chatmux/chatmux.sock`) | Same-host sidecar / plugin consumers, e.g. chat.nvim's Bun sidecar | File permissions *are* the access control, and Bun's `fetch({ unix })` supports it directly |
| **TCP** | `127.0.0.1:<port>` (default `7717`) | Standard MCP clients such as Claude Code | **The MCP spec defines only stdio and streamable HTTP as transports — there is no unix socket option** |

> ⚠️ **Do not hand the unix socket path to Claude Code.** MCP client configuration has no
> `socketPath` field: a client accepts either stdio (`command`/`args`) or a streamable
> HTTP TCP `url`. This is a limitation of the spec, not a gap in the implementation.

### Configuring Claude Code

```bash
claude mcp add --transport http chatmux http://127.0.0.1:7717/mcp
```

Verify the connection:

```bash
claude mcp list
# chatmux: http://127.0.0.1:7717/mcp (HTTP) - ✔ Connected
```

### TCP port configuration

Precedence: environment variable > config file > default.

| Source | Form | Notes |
|--------|------|-------|
| `CHATMUX_MCP_PORT` | Environment variable | Highest precedence |
| `mcp.port` in `adapters.json` | `{ "mcp": { "port": 7717 }, "adapters": [...] }` | Next |
| Default | `7717` | When neither is set |

Setting `0` **disables the TCP listener**, leaving only the unix socket.

An invalid value (non-integer, or outside `0-65535`) fails daemon startup outright. It
never silently falls back to the default.

### Bind host

| Source | Form | Notes |
|--------|------|-------|
| `CHATMUX_MCP_HOST` | Environment variable | Highest precedence |
| `mcp.host` in `adapters.json` | `{ "mcp": { "host": "127.0.0.1" }, "adapters": [...] }` | Next |
| Default | `127.0.0.1` | When neither is set |

Any address the machine can bind is accepted — a wildcard, a single interface, an
address on a private overlay such as Tailscale. As with the port, an invalid value
fails daemon startup outright rather than falling back to the default: a bind host that
quietly ignores you produces a listener that looks configured and answers nothing,
which is a far worse afternoon than a startup error.

Binding anything that is not loopback prints a warning at startup. `localhost`,
anything in `127.0.0.0/8`, `::1`, and IPv4-mapped forms like `::ffff:127.0.0.1` all
count as loopback and stay quiet. (`localhost` could in principle be pointed elsewhere
in `/etc/hosts`; treating it as loopback is the overwhelmingly correct default, and the
warning is a reminder rather than a security control.)

### Security: two layers

**Layer one — the loopback listener you get by default.** The full text of your
conversations travels over it, and loopback lacks the file-permission protection a unix
socket has: **any process on the same host can connect**. On a multi-user machine, or
when you do not trust other local programs, set `mcp.port: 0` and use the unix socket
instead.

**Layer two — binding beyond loopback.** This listener has **no authentication of any
kind**. There is no token, no TLS, no allowlist. Anyone who can route a packet to the
address you bind can read every message chatmux has stored and send messages as you.
Nothing in chatmux will stop them, which is why the daemon says so loudly at startup
instead of trusting you to remember.

There is one situation that genuinely needs it: **running the daemon in a container**.
A container's `127.0.0.1` is its own loopback, so a published port maps to a socket
nobody is listening on — the container looks healthy and every connection is refused.
Binding the wildcard there is not a weakening; the container's network is the boundary,
and what matters is which host address you publish the mapped port to. See
[`deploy/container/`](../deploy/container/README.md) for a working reference.

Outside that case, treat a non-loopback bind as a decision to put a network in front of
it: a firewall, a private overlay (Tailscale, WireGuard), or a container network you do
not publish. "It is only on my LAN" is not one of these.

## Tools

### `list_chats`

Lists chats, with platform filtering, search, and pagination.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "platform": { "type": "string", "description": "Filter by platform (e.g. 'line')" },
    "search": { "type": "string", "description": "Search chat name" },
    "limit": { "type": "number", "default": 50 },
    "offset": { "type": "number", "default": 0 }
  }
}
```

**Example output:**
```json
{
  "chats": [
    {
      "id": "line:c1234567890abcdef",
      "type": "direct",
      "name": "Alice",
      "platform": "line",
      "last_message": {
        "text": "你好！",
        "timestamp": 1690000000000,
        "sender": "Alice"
      },
      "message_count": 42
    }
  ],
  "total": 15,
  "limit": 50,
  "offset": 0
}
```

### `read_messages`

Reads messages from one chat, paginated by timestamp (`before` / `after`).

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "chat_id": { "type": "string", "description": "Chat ID (e.g. 'line:c1234')" },
    "limit": { "type": "number", "default": 20 },
    "before": { "type": "number", "description": "Messages before this timestamp (ms)" },
    "after": { "type": "number", "description": "Messages after this timestamp (ms)" }
  },
  "required": ["chat_id"]
}
```

**Example output:**
```json
{
  "messages": [
    {
      "id": "line:m1234567890",
      "chat_id": "line:c1234567890abcdef",
      "sender": {
        "id": "line:u1234567890abcdef",
        "display_name": "Alice"
      },
      "timestamp": 1690000000000,
      "content": {
        "type": "text",
        "text": "你好！"
      },
      "edited_at": null,
      "retracted_at": null
    },
    {
      "id": "line:m1234567891",
      "chat_id": "line:c1234567890abcdef",
      "sender": {
        "id": "line:u1234567890abcdef",
        "display_name": "Alice"
      },
      "timestamp": 1690000001000,
      "content": {
        "type": "sticker",
        "text": null,
        "sticker_id": "14406089",
        "package_id": "1365252"
      },
      "edited_at": null,
      "retracted_at": null
    }
  ],
  "has_more": true,
  "oldest_timestamp": 1689900000000,
  "newest_timestamp": 1690000000000,
  "history": {
    "state": "partial"
  }
}
```

**`history`** answers a question `messages` alone cannot: is this chat short, or is
its history missing? Without it a consumer showing three messages cannot tell whether
the conversation was three lines long or whether the backfill never reached further.

| `state` | Meaning |
|---------|---------|
| `complete` | Backfill reached the bottom. What you see is the whole chat |
| `partial` | Older messages exist upstream and have not been fetched yet |
| `backfilling` | A fetch is running right now. Expect a resource update shortly |
| `unavailable` | The platform was asked with a real anchor and returned nothing. `reason` explains why (e.g. `platform_no_history` — LINE does not serve messages from before this device registered) |
| `unknown` | Never attempted, so nothing can be claimed either way |

`backfilling` is in-memory only and overrides the stored state — a daemon that dies
mid-fetch comes back reporting what it actually knows, never a stale "in progress".

**`sticker_id` / `package_id`** appear only on `content.type = "sticker"`, and only where
the row has them — a sticker's whole content is which sticker it is, so without them a
consumer has nothing to render. The keys are omitted rather than sent as `null`: a
present-but-empty key reads identically to a missing one at the render site, so omission is
the honest signal. LINE supplies both; a platform without sticker packs sends `sticker_id`
alone.

**`media_url`** appears only where the platform gave core a URL that needs **no
authentication** — anyone can fetch it, and a consumer may cache it freely. On LINE that
means stickers and nothing else. Its absence on an `image` message is not a gap: most media
cannot be described as a URL at all (it needs an auth header, or it is end-to-end encrypted
and only decryptable inside the adapter). **To display media, call `get_media` and open the
path it returns — do not build a fetch around `media_url`.** The field exists for consumers
that want to hotlink where hotlinking happens to work.

**`edited_at` / `retracted_at`** (since v0.5) tell a consumer that a message it may
already be displaying has changed:

| Field | Meaning |
|-------|---------|
| both null | Never modified since it arrived |
| `edited_at` non-null | `content.text` is the current text, replaced at that time |
| `retracted_at` non-null | Retracted. `content.text` is `null` and the original is gone from storage; render a placeholder |

They are not mutually exclusive — a message can be edited and later retracted.
`retracted_at` wins when both are set.

### `read_events`

Resume reading the event log from a cursor. This is the **base primitive for push
consumers** — it answers "what happened after this position?"

**Why `read_messages({ after })` cannot substitute for it:** `after` filters on
**timestamp**, and backfill inserts messages older than everything already stored. A
consumer tracking progress by timestamp **never sees them**. The cursor follows **the
order in which core accepted writes**, so they arrive normally.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "since": { "type": "string", "description": "Opaque cursor from a previous read_events / get_status call. Omit to start tailing from now." },
    "limit": { "type": "number", "default": 100 }
  }
}
```

**Example output:**
```json
{
  "events": [
    {
      "cursor": "evt:1643",
      "type": "message",
      "message": {
        "id": "line:m1234567890",
        "chat_id": "line:c1234567890abcdef",
        "sender": { "id": "line:u1234567890abcdef", "display_name": "Alice" },
        "timestamp": 1690000000000,
        "content": { "type": "text", "text": "你好！" },
        "edited_at": null,
        "retracted_at": null
      }
    },
    {
      "cursor": "evt:1644",
      "type": "edit",
      "message": {
        "id": "telegram:4484",
        "chat_id": "telegram:-1001234567890",
        "sender": { "id": "telegram:123456789", "display_name": "MattClaudeBot" },
        "timestamp": 1690000000000,
        "content": { "type": "text", "text": "the final answer" },
        "edited_at": 1690000050000,
        "retracted_at": null
      }
    },
    {
      "cursor": "evt:1645",
      "type": "unsend",
      "message": {
        "id": "telegram:4485",
        "chat_id": "telegram:-1001234567890",
        "sender": { "id": "telegram:123456789", "display_name": "MattClaudeBot" },
        "timestamp": 1690000010000,
        "content": { "type": "text", "text": null },
        "edited_at": null,
        "retracted_at": 1690000100000
      }
    }
  ],
  "next_cursor": "evt:1645",
  "head_cursor": "evt:1645",
  "has_more": false
}
```

`type` is **derived from the row's current state**, not from a stored history: retracted
wins, then edited, otherwise `message`. So a full replay from cursor 0 reports a
message that was later edited as a single `edit` event — the consumer never sees the
version it missed. That is correct for a consumer applying final state, and a consumer
that genuinely needs the edit history should read the JSONL log, which keeps every
version.

**The cursor contract:**

| Rule | Detail |
|------|--------|
| **Opaque** | A cursor is an opaque token. Echo it back verbatim; **do not parse it, compare it, or do arithmetic on it**. The encoding will change |
| **Omitting `since`** | Returns the current head with an empty `events` array. This is how a new consumer starts tailing from now without replaying all history |
| **`next_cursor`** | The position to pass back on the next call. With no new events it **holds position**, so an idle consumer never loses a valid cursor |
| **`head_cursor`** | The current end of the log. If your stored cursor is ahead of head (SQLite was rebuilt or truncated), reset — otherwise you stall forever |
| **Invalid cursor** | Returns `{ "error": "invalid_cursor", "detail": ... }` rather than silently returning nothing |
| **Ordering** | Events are **ascending** in the order core accepted them, which is unrelated to `timestamp` order |
| **Sparse** | The sequence **has gaps and is not contiguous**. Do not assume adjacency, and **do not subtract two cursors to estimate a backlog** — on a real store of 1644 messages the sequence had already reached 18744. Ask whether more is pending (`has_more`), never how much |
| **Dedup** | A duplicate message rejected by `INSERT OR IGNORE` does not advance the cursor (NEVER #7) |
| **Re-delivery** | A message you have already seen **can appear again** with a later cursor, when it is edited or retracted. Key on `message.id` and apply the new state; do not assume each cursor position is a message you have never seen |

**Coverage:** `message`, `edit` and `unsend` are sequenced (see `syncEventToSQLite`).
`read_receipt` is not — it changes nothing a consumer reads. Since v0.5 the sequence is
the `messages.seq` column rather than the row id, precisely so that a change to an
already-delivered message can take a new position at the tail; a consumer parked past
that message's original position still receives it.

**Using it with subscription** (see Resource Subscription below):

```
subscribe chat://chats  →  receive notifications/resources/updated
                        →  read_events({ since: <your saved next_cursor> })
                        →  save the new next_cursor
```

Subscription only says "something changed"; `read_events` says what changed. Together
they form the complete push pipeline.

### `search_messages`

Full-text search over messages, using FTS5 with highlighted snippets.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "Search query (CJK or ASCII)" },
    "chat_id": { "type": "string", "description": "Limit to specific chat (optional)" },
    "platform": { "type": "string", "description": "Filter by platform (optional)" },
    "limit": { "type": "number", "default": 20 },
    "offset": { "type": "number", "default": 0 }
  },
  "required": ["query"]
}
```

**Example output:**
```json
{
  "results": [
    {
      "message": {
        "id": "line:m1234567890",
        "chat_id": "line:c1234567890abcdef",
        "sender": {
          "id": "line:u1234567890abcdef",
          "display_name": "Alice"
        },
        "timestamp": 1690000000000,
        "content": {
          "type": "text",
          "text": "今天中午吃什麼？"
        }
      },
      "snippet": "今天中午<b>吃什麼</b>？",
      "chat_name": "Alice"
    }
  ],
  "total": 5,
  "limit": 20,
  "offset": 0
}
```

**FTS5 query logic** (per the Phase 2.1 result):

- Query length ≥ 3 characters → FTS5 trigram query.
- Query length < 3 characters → LIKE fallback. Phase 2.1 settled on trigram FTS5 plus a
  LIKE fallback for sub-3-character queries; see `storage-schema.md` for why.

### `send_message`

Sends a message, forwarded to the matching adapter after SafetyRail checks.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "chat_id": { "type": "string", "description": "Target chat ID (e.g. 'line:c1234')" },
    "text": { "type": "string", "description": "Message text to send" }
  },
  "required": ["chat_id", "text"]
}
```

**Example output** (success):
```json
{
  "success": true,
  "message_id": "line:m9876543210",
  "timestamp": 1690000001000
}
```

**A successful send also lands the message.** Core writes a `message` event of its own —
same path as any incoming event: JSONL, then SQLite, then a `notifications/resources/updated`
for `chat://chats/{id}/messages`. A subscribed consumer therefore sees the message it just
sent without re-reading anything, which is the whole point: before this, a client had no way
to display its own outgoing messages except on platforms that happened to echo them back.

The sender is the identity the adapter reported via the optional `get_self` request. When
an adapter does not implement it, the message still lands, attributed to a sentinel account.

Some platforms *do* echo self-sent messages back as live events (LINE does, Telegram does
not). Core funnels both paths — its own landing and the platform echo — through a single
entry point keyed on the chat plus `platform_message_id`, first one wins. SQLite would have absorbed the
duplicate anyway via `INSERT OR IGNORE`; the append-only JSONL log would not, which is what
the deduplication actually protects.

**A send with no `message_id` does not land.** The tool still reports `success: true` — the
message really did reach the platform — but core will not invent an ID for an append-only
log whose deduplication depends on it. Expect a WARN in the daemon log.

**Rate limiting does not produce an error.** `SafetyRail`'s rate limiter is awaited, not
consulted — a send over the 5/min budget is held until a slot frees and then goes through,
so the caller sees a slower `success: true`, never a `rate_limited` rejection. There is no
such error string anywhere in the daemon. A consumer written against a rejection would
have a retry path that never runs, and would read the delay as a hang.

The kill switch is the part of SafetyRail that does block, and it surfaces as
`send_blocked`, separate from `adapter_unavailable`. The two were once merged on the
argument that a caller only needs to know sending is impossible right now. That argument
does not survive contact with the person reading the message: the two are cleared by
opposite actions — one by reconnecting an adapter, the other only by restarting the daemon
— and the merged message named the wrong one. A tripped switch is also global, so it
refuses sends on platforms whose adapters never faltered, and the merged message sent the
reader to inspect a connection that was healthy the whole time.

`send_blocked` therefore quotes the error that tripped the switch and names the one action
that clears it. `get_status` reports the same state as `send_blocked` / `send_blocked_reason`.

**`adapter_unavailable` means the adapter process is down, not that its push stream is.**
Sending is a request/response call and does not travel over the push stream, so the two have
independent lifetimes. They were once gated together, and the cost showed up as soon as a
laptop suspended: the LINE adapter's stream was declared dead, and only an *inbound* message
could earn `connected` back, so every quiet stretch was also a stretch where sending was
refused over an adapter that was answering backfill requests the whole time. The `connected`
field reported by `get_status` still tracks the stream — it just no longer decides sends.
When the network genuinely is down, the send is attempted and fails at the adapter, which
returns `send_failed` carrying the platform's own error rather than a guess made in advance.

**Example output** (send reached the adapter and failed there):
```json
{
  "success": false,
  "error": "send_failed",
  "detail": "<the adapter's own error message>"
}
```

**Example output** (adapter unavailable):
```json
{
  "success": false,
  "error": "adapter_unavailable",
  "detail": "line adapter is not running"
}
```

**Example output** (sending blocked by the safety kill switch):
```json
{
  "success": false,
  "error": "send_blocked",
  "detail": "sending is blocked for every adapter by the safety kill switch, which tripped on repeated send failures (last error: <the error that tripped it>). It stays tripped until the chatmux daemon is restarted."
}
```

### `get_media`

Resolves one message's media to a **local file path**. A consumer opens the path and is
done: it never sees a URL, an auth header or an encryption key, and needs no credentials of
its own. Which of the three fetch paths applies — open CDN, authenticated object store, or
local decryption — is decided by core and the adapter (see
[`adapter-protocol.md`](./adapter-protocol.md) §get_media).

Fetching is **lazy**: nothing is downloaded until a consumer asks for it. The first call
downloads; later calls for the same media are served from disk with no network traffic at
all.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "message_id": { "type": "string", "description": "e.g. 'line:623174375235650150'" },
    "chat_id": { "type": "string", "description": "Chat the message belongs to, e.g. 'telegram:-1001782953277'. Required on platforms where message ids repeat across chats — see docs/platform-facts.md" }
  },
  "required": ["message_id"]
}
```

**`chat_id` is optional in the schema and required in practice on some platforms.** A message
id names a message only together with its chat (`platform-facts.md` fact 1). What core does
when it is missing:

| Situation | Behaviour | Remembers a failure? |
|---|---|---|
| `chat_id` given, one row matches | Fetch normally | Yes, under the correct per-chat key |
| `chat_id` given, no row matches | `{ unavailable: "no_adapter" }` | **No** — returns before the cache is touched |
| No `chat_id`, only one row has that id | Fetch normally (LINE's usual case) | Yes |
| No `chat_id`, several rows but exactly one carries media | Use that row, log a warning | Yes |
| No `chat_id`, still ambiguous | `{ unavailable: "no_adapter" }` + warning | **No** |

One reason never comes from an adapter: `timeout`, produced by core when `get_media` passes
its 180s deadline. It is deliberately **not** remembered — unlike `gone`, which it used to
be reported as. A timeout is a statement about how long this attempt took, and caching it
as absence made a fetchable video claim to be deleted for 24 hours, retry included.

The last row is the important one. Guessing produces a wrong answer *and* records it: a
`gone`/`unsupported_type` reply from the adapter is remembered **permanently**, so one wrong
guess makes a real image unreachable until someone edits `negative.json` by hand. That is
F45's actual damage — 46 permanent entries accumulated in half a day. Refusing costs one
blank image on one render, so core refuses.

**Example output** (success):
```json
{
  "path": "/home/you/.cache/chatmux/media/line/msg/u1234/623174375235650150.jpg",
  "mime": "image/jpeg"
}
```

**Example output** (nothing to show):
```json
{ "unavailable": "gone" }
```

| `unavailable` | Meaning | What a consumer should render |
|---------------|---------|-------------------------------|
| `gone` | The platform no longer has it — deleted or expired | An explicit "this is no longer on the platform" label. **Not** a blank space: a consumer that renders nothing turns a platform-side deletion into what looks like a broken client |
| `needs_key` | The content exists but cannot be decrypted with the keys available | Same idea, worded as unavailable rather than deleted |
| `unsupported_type` | This platform's adapter does not serve media at all | The existing text label for the content type |
| `no_adapter` | Core has no such message stored, **or** the id is ambiguous without a `chat_id` and core refused to guess | Nothing new — the consumer is asking about a message it should not have, or should pass `chat_id`. Refusing costs one blank image; guessing wrong is remembered permanently |

A result is never an error. Media that cannot be produced is a normal answer, because the
consumer's job is the same either way: show the user something honest.

**Caching.** Files live under `$XDG_CACHE_HOME/chatmux/media/` (default
`~/.cache/chatmux/media/`). Stickers are keyed on the sticker ID, so one sticker sent a
hundred times is stored once; other media is keyed on the **chat and** the message — a
message id alone is not unique (F45), and keying on it alone made two unrelated messages
share one file and one "cannot fetch" memory. The cache is capped
(200 MB) and evicts by last-read time — an evicted file costs one re-fetch, never a message.
Failures are remembered too, which is what stops a scroll past deleted media from
re-hitting the network on every redraw.

### `probe_latest`

**Diagnostic, read-only.** Asks the adapter directly for a chat's newest messages and
returns them **without landing them** — nothing is written to the event log, SQLite, or
FTS. Added for F23, to answer "does the adapter still see messages the store does not?"
without mutating the thing being diagnosed.

It is not a read path for consumers. Use `read_messages` for that; this one bypasses
storage entirely, so its results are whatever the platform says right now.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "chat_id": { "type": "string", "description": "Chat ID (e.g. 'line:c1234')" },
    "count": { "type": "number", "default": 20 }
  },
  "required": ["chat_id"]
}
```

**Output:** `{ "events": [...] }` — raw adapter events, in the adapter's own shape.

### `get_status`

Returns system status: adapter connection state, whether sending is blocked, plus storage
statistics.

**Input schema:**
```json
{
  "type": "object",
  "properties": {}
}
```

**Example output:**
```json
{
  "adapters": {
    "line": {
      "state": "connected",
      "uptime_seconds": 3600,
      "rate_limit": { "remaining": 3, "resets_in_seconds": 45 }
    }
  },
  "send_blocked": false,
  "storage": {
    "message_count": 12345,
    "chat_count": 42,
    "contact_count": 38,
    "oldest_message": 1680000000000,
    "newest_message": 1690000000000,
    "db_size_mb": 15.2,
    "jsonl_size_mb": 22.8,
    "cursor": "evt:1643"
  }
}
```

`storage.cursor` is the current head cursor — a consumer can feed it straight into
`read_events({ since })` to start tailing.

`send_blocked` is the SafetyRail kill switch, and it is deliberately not inside `adapters`:
one rail serves all of them, so every adapter can read `connected` while none can send.
When it is `true`, `send_blocked_reason` carries the error that tripped it. See
[`safety-rail.md`](./safety-rail.md).

## Resources

### `chat://chats`

Every chat, with a summary of its most recent message.

**URI**: `chat://chats`

**Response**: same shape as the `list_chats` tool output — all chats, with no
`platform` / `search` / `offset` filtering.

⚠️ **"Unpaginated" means a hard-coded `limit: 1000`, not unbounded.** Past that the list is
silently short. The response carries `total`, so a consumer can compare it against
`chats.length` and tell the user rather than presenting a truncated list as complete.
Consumers wanting the whole list should read this resource rather than calling
`list_chats` with no arguments: that tool defaults to `limit: 50`, and since chats sort
`last_activity_at DESC NULLS LAST`, chats the adapter reported no activity for fall off the
end first. Note this is **not** the same as "chats with no messages": a chat core has never
landed a message for still sorts near the top if the adapter says it saw recent
activity — that gap is the point of the two columns (see storage-schema.md).

### `chat://chats/{id}/messages`

Recent messages for one chat.

**URI**: `chat://chats/line:c1234567890abcdef/messages?limit=20`

**Response**: same shape as the `read_messages` tool output (the latest N, default 20),
`history` included — both paths share one implementation, so `complete` / `partial` /
`backfilling` / `unavailable` / `unknown` mean exactly what they mean for the tool.

Reading this resource also triggers an on-demand backfill when the chat qualifies, which
is why a first read can answer `unknown` and an immediate second read `backfilling`.

⚠️ **Only `limit` is parsed — there is no `before` / `after`.** A read of this resource
therefore always returns the newest N messages. This matters for change events: a
subscriber re-reading after a push sees an edit or retraction only if the affected
message is still inside that window. A consumer whose buffer has grown past N will miss
the update for anything older, with no signal that it did. Re-opening the chat or paging
with `read_messages` returns the correct `edited_at` / `retracted_at` and repairs the
state. The fix for a consumer that needs those changes as they happen is `read_events`
(above), not a larger `limit` — the window is the wrong shape for the problem, whatever
size it is.

### `chat://chats/{id}/info`

Details for one chat.

**URI**: `chat://chats/line:c1234567890abcdef/info`

**Response:**
```json
{
  "id": "line:c1234567890abcdef",
  "type": "group",
  "name": "工作群組",
  "platform": "line",
  "members": [
    { "id": "line:u1234", "display_name": "Alice" },
    { "id": "line:u5678", "display_name": "Bob" }
  ],
  "message_count": 1234,
  "first_message_at": 1680000000000,
  "last_message_at": 1690000000000,
  "last_activity_at": 1690345600000
}
```

### `chat://status`

System status summary.

**URI**: `chat://status`

**Response**: same shape as the `get_status` tool output.

## Resource subscription

### Mechanism

MCP resource subscription follows a **notify-then-fetch** model:

1. The client (Claude Code, say) subscribes to a resource URI.
2. When Storage changes — a new message, or an edit or retraction applied to an existing one — the core MCP server sends a `notifications/resources/updated` notification.
3. On receiving it, the client fetches the resource itself to get the latest data.

⚠️ A notification means "this resource changed", never "there is one more message".
A client that appends whatever it fetches, skipping IDs it already holds, will drop
every edit and retraction on the floor. Upsert by `message.id` instead.

### Semantics

**You get notifications only for URIs you subscribed to.** The server declares
`resources.subscribe: true` in its `initialize` response and keeps a subscription set
**per session**. A session that never calls `resources/subscribe` receives nothing —
not a filtered stream, nothing at all.

This is worth stating because it was not always true. Before 2026-08-01 the server
declared no subscribe capability, answered `resources/subscribe` with `-32601`, and
broadcast every update to every connected session regardless. A client written to this
document — subscribe, then handle what you subscribed to — got nothing; a client that
ignored subscription entirely got everything. Both of those behaviours are now gone.

**URIs match by exact equality.** Subscribing to `chat://chats` does **not** cover
`chat://chats/{id}/messages`. MCP does not define "a subscription to a template covers
its instances", so chatmux does not invent it — subscribe to each URI you actually want.
The three a consumer normally wants are:

```
chat://chats
chat://status
chat://chats/{id}/messages      ← one per open chat
```

**Subscriptions die with the session.** Terminate a session (HTTP `DELETE /mcp` with
your `mcp-session-id`) and its subscription set and update listener go with it. Note
the corollary: a client that vanishes *without* sending `DELETE` — crash, pulled cable
— leaves its session behind until the daemon restarts. Reaping idle sessions is not
implemented.

`resources/unsubscribe` removes a single URI from the current session's set.

### Trigger flow

```
Adapter event notification → Core writes to Storage
  → determine the affected resources:
    - new message  → chat://chats (last_message changed)
                     + chat://chats/{affected_chat_id}/messages
    - edit/unsend  → chat://chats/{affected_chat_id}/messages
    - new contact  → chat://chats/{affected_chat_id}/info
    - state change → chat://status
  → send notifications/resources/updated for each affected resource
  → subscribed clients fetch the latest data
```

### Dual-track strategy

Resource subscription is a relatively new MCP feature and may not be supported by every
client, so chatmux supports both paths:

1. **Subscription** (primary): clients that support it get real-time notifications.
2. **Tool polling** (fallback): a client can call `list_chats` or `read_messages` on an interval.

Both return identical shapes, so a client can pick whichever matches its capabilities.

For a consumer that must not miss events, neither path is sufficient on its own — use
`read_events` with a persisted cursor, and treat subscription purely as a latency hint.
`examples/notifier/` implements exactly that, and chat.nvim's sidecar now follows the same
pattern — it did not at first, and the result was precisely the silent gap described under
`chat://chats/{id}/messages` above.
