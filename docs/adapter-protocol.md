# Adapter Protocol

> **Protocol version**: 0.4
> **Validated against**: LINE (v0.1, v0.4), Telegram (v0.2, v0.3, v0.4)
> **Changelog**: at the bottom of this document

A chatmux adapter is a child process that talks to the core daemon over
newline-delimited JSON-RPC on stdin/stdout. Adapters can be written in any language and
can live inside the chatmux monorepo or in their own repository.

## Transport

- **Encoding**: UTF-8 JSON, one complete JSON object per line, separated by `\n`.
- **Pipes**: stdin (core → adapter), stdout (adapter → core).
- **stderr**: the adapter's to use freely; core relays it into the daemon log.

> **Note for non-Node.js adapters**: in Python, Go, Rust and friends, stdout is
> **block-buffered** by default when it is a pipe, not line-buffered. An adapter must
> flush after writing each line of JSON. In Python, put
> `sys.stdout.reconfigure(line_buffering=True)` at module top level. Skip this and your
> JSON-RPC responses sit in the buffer while core's readline waits forever.

## Message formats

### Request (Core → Adapter, expects a response)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": { ... }
}
```

### Response (Adapter → Core, answering a request)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { ... }
}
```

### Error response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": -32000, "message": "auth failed" }
}
```

### Notification (Adapter → Core, fire-and-forget)

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": { ... }
}
```

A notification has no `id` field, and core does not reply to it.

## Adapter configuration

An adapter's launch command, working directory, and environment variables come from
`$CHATMUX_DATA_DIR/adapters.json`:

```json
{
  "adapters": [
    {
      "platform": "line",
      "command": "node",
      "args": ["--import", "tsx", "src/adapters/line/index.ts"],
      "cwd": "/path/to/chatmux",
      "enabled": true
    },
    {
      "platform": "telegram",
      "command": "/path/to/venv/bin/python",
      "args": ["/path/to/chatmux-adapter-telegram/main.py"],
      "env": {
        "TELEGRAM_API_ID": "12345678",
        "TELEGRAM_API_HASH": "abcdef..."
      },
      "enabled": true
    }
  ]
}
```

| Field | Required | Purpose |
|-------|----------|---------|
| `platform` | Yes | Platform identifier; must match the `platform` in the `initialize` response |
| `command` | Yes | Executable path. External adapters should use an **absolute path**, e.g. a venv's python |
| `args` | Yes | Argument array |
| `cwd` | No | Working directory; defaults to the directory containing the adapter |
| `env` | No | Per-adapter environment variables, merged into the subprocess env. Use it for API keys and other secrets, avoiding collisions in the global env |
| `enabled` | Yes | Whether to start this adapter |

When the config file is absent, core falls back to its built-in defaults, which keeps
v0.1 working.

## Core → Adapter requests

### `initialize`

Sent right after the first spawn; the adapter reports its capabilities.

**Request params:**
```json
{
  "data_dir": "/home/user/.local/share/chatmux",
  "platform": "line"
}
```

`data_dir` is chatmux's top-level data directory. An adapter should create its own
subdirectory at `{data_dir}/adapters/{platform}/` for session files, caches, and other
platform-specific data. The Telegram adapter, for instance, keeps its session at
`{data_dir}/adapters/telegram/chatmux.session`.

**Response result:**
```json
{
  "platform": "line",
  "supported_events": ["message", "read_receipt", "unsend"],
  "can_send": true,
  "can_backfill": true,
  "platform_rate_limits": {
    "send": { "max": 5, "window_seconds": 60 }
  }
}
```

`platform_rate_limits` is optional. When reported, core's SafetyRail takes whichever is
stricter — its own default or the adapter's value. **An adapter can only tighten, never
loosen**; the core floor is the safety net.

### `get_contacts`

Returns contacts as the platform defines them. That scope varies a lot: LINE has an
explicit friend list, while Telegram returns only contacts from your phone's address book
and may return none at all. Core uses contacts for `display_name` lookups but does not
depend on the list being complete — sender information on backfill and live events is
resolved by the adapter itself (Telegram, for example, uses `msg.get_sender()` against
its entity cache).

**Request params**: `{}`

**Response result:**
```json
{
  "contacts": [
    {
      "platform_id": "u1234567890abcdef",
      "display_name": "Alice",
      "avatar_url": "https://...",
      "raw": { ... }
    }
  ]
}
```

`raw` is optional and preserves the platform's original payload for debugging.

### `get_chats`

Returns the chat list: groups and DMs.

**Request params**: `{}`

**Response result:**
```json
{
  "chats": [
    {
      "platform_id": "c1234567890abcdef",
      "type": "group",
      "name": "工作群組",
      "last_message_at": 1690000000000,
      "raw": { ... }
    },
    {
      "platform_id": "u1234567890abcdef",
      "type": "direct",
      "name": "Alice"
    }
  ]
}
```

`type` is one of `"direct"`, `"group"`, `"room"`.

`raw` is optional. A DM's `name` comes from the contacts map or from the adapter's own
resolution; an unknown DM has a null name.

**`last_message_at`** (optional, since v0.3): the timestamp of the chat's most recent
message, in epoch milliseconds.

This is core's **ordering signal for cold-start backfill** — core sorts by
`last_message_at DESC` and spends its global budget of 500 messages starting from the most
active conversations. Providing it is strongly recommended:

- **Provided** → the cold-start budget goes to conversations with recent activity.
- **Omitted** (all null) → ordering degrades to arbitrary, and the budget may be spent
  entirely on dormant chats. Nothing breaks, but cold-start quality drops noticeably.

Most platforms' dialogs/conversations APIs already carry this field (Telegram's
`dialog.date`), so the cost is near zero. Core guards existing values with `MAX()`, so
returning null never overwrites what is already stored.

### `get_message_boxes` (optional)

> **Optional since v0.2.** An adapter that does not support it replies with JSON-RPC error
> `-32601` (Method not found). Core **looks only at `error.code`** — it never matches on
> the message text, so word it however you like — then skips this step and uses
> `last_message_at` from `get_chats` for backfill ordering instead.
>
> ⚠️ **An adapter that does not implement this method should provide `last_message_at` in
> `get_chats`.** Otherwise core has no ordering signal at all and the cold-start backfill
> budget goes to arbitrary conversations. (v0.2 promised this fallback without providing a
> field it could use; v0.3 closed that gap.)

Returns every conversation that has messages, used for cold-start backfill discovery. The
method originates in LINE's messageBoxes API; on other platforms the dialogs/conversations
API is usually already covered by `get_chats`.

**Request params**: `{}`

**Response result** (a raw array, not wrapped in an object):
```json
[
  {
    "id": "c1234567890abcdef",
    "lastDeliveredTime": 1690000000000
  }
]
```

### `get_self` (optional)

> **Optional since v0.4.** An adapter that does not support it replies with JSON-RPC error
> `-32601` (Method not found). Core matches on `error.code` only — same convention as
> §get_message_boxes — and carries on without an identity for that platform.

Reports who the logged-in account is on this platform. Core needs it to land the messages
the user sends themselves: a `send_message` response carries a `message_id` but no sender,
and core has no platform-independent way to know its own identity.

Core issues this request **after** the adapter reports `status: "connected"`, as part of
the cold-start flow — not during `initialize`. Both first-party adapters log in
asynchronously (their `initialize` handler returns capabilities immediately and connects in
the background), so the identity simply does not exist yet at `initialize` time.

**Request params**: `{}`

**Response result:**
```json
{
  "platform_id": "u1234567890abcdef",
  "display_name": "Matt"
}
```

`display_name` may be an empty string when the platform cannot supply a name; core then
falls back to a placeholder. If the method is unsupported or the response is unusable, core
lands self-sent messages under the sentinel `platform_id: "self"` instead of dropping them.

An adapter that maintains a contact cache should register itself there while handling this
request, so its own messages resolve to a real name rather than a raw account ID.

### `send_message`

Sends a message through the platform. Core has already run SafetyRail checks before
forwarding.

**Request params:**
```json
{
  "chat_id": "c1234567890abcdef",
  "content": {
    "type": "text",
    "text": "Hello!"
  }
}
```

`chat_id` is the raw `platform_id`, without a `platform:` prefix. Core handles routing —
extracting platform and platform_id from the composite ID — so an adapter always receives
a bare platform_id.

**Response result** (success):
```json
{
  "message_id": "m9876543210",
  "timestamp": 1690000000000
}
```

**Error** (failure):
```json
{
  "code": -32001,
  "message": "recipient not found"
}
```

⚠️ **`timestamp` is Unix epoch in milliseconds**, same as everywhere else in this protocol.
Normalize at the adapter boundary if the platform SDK returns seconds — several do, and
their send responses often disagree with their own event payloads. Core takes the value at
face value: a second-precision timestamp lands the message in 1970, which sorts it to the
top of the conversation where nobody will find it.

⚠️ **`message_id` is required for the message to land.** Core writes a message event of its
own after a successful send (see [`mcp-interface.md`](./mcp-interface.md)), keyed on this
ID. An adapter that omits it still reports the send as successful, but the message will not
appear in storage or in any consumer — core will not invent an ID, because it doubles as
the deduplication key.

### `backfill`

Fetches history. Core specifies the chat, the point in time, and how many; the adapter
handles pagination.

**Request params:**
```json
{
  "chat_id": "c1234567890abcdef",
  "before_timestamp": 1690000000000,
  "count": 50
}
```

`chat_id` is the raw `platform_id` without a prefix, as in `send_message`.

**Response result:**
```json
{
  "events": [ ... ],
  "has_more": true,
  "oldest_timestamp": 1689900000000
}
```

Each entry in `events` has the same shape as an `event` notification's params.
`has_more: false` means that chat has been exhausted.

**Cold-start procedure** (core-side logic):

1. Take the chat list and sort by last message time, descending.
2. Call backfill per chat, `count=50` per round.
3. Accumulate into a global counter and stop at 500 — without necessarily visiting every chat.
4. If the first pass stayed under 500 and chats remain unexhausted, run another round, until the global count reaches 500 or every chat is exhausted.

**Backfill interleaving with live events**: backfill and live push can produce events with
the same message ID. Core's Storage deduplicates with `INSERT OR IGNORE` against a UNIQUE
constraint on (platform, platform_message_id). Adapters do not need to handle this — dedup
is core's responsibility.

### `shutdown`

Graceful shutdown. On receiving it the adapter should disconnect from the platform, clean
up, and exit 0.

**Request params**: `{}`

**Response result**: `{}`

Core waits up to 5 seconds after sending shutdown. On timeout it sends SIGTERM, waits
another 3 seconds, then SIGKILL.

## Adapter → Core notifications

### `event`

A platform event. This is the central notification — new messages, read receipts, and
unsends all travel through it.

**Params:**
```json
{
  "type": "message",
  "platform": "line",
  "platform_message_id": "m1234567890",
  "chat": {
    "platform_id": "c1234567890abcdef",
    "type": "direct",
    "name": "Alice"
  },
  "sender": {
    "platform_id": "u1234567890abcdef",
    "display_name": "Alice"
  },
  "timestamp": 1690000000000,
  "content": {
    "type": "text",
    "text": "你好！"
  },
  "raw": { ... }
}
```

`raw` is optional. It preserves the platform's original payload for debugging; core does
not parse it but does store it in JSONL. When the platform object cannot be serialized
directly — Telethon's `Message` contains circular references, for instance — omit it or
extract a serializable subset.

#### Event type enum

| type | Meaning | `content` shape |
|------|---------|-----------------|
| `message` | A new message | `{ type: "text"\|"image"\|"video"\|"audio"\|"sticker"\|"file", text?, media_url?, sticker_id?, file_name? }` |
| `read_receipt` | Read receipt (deferred in v0.2: semantics differ per platform, so support is at the adapter's discretion) | `{ chat_id, read_up_to: timestamp }` |
| `unsend` | A retracted message | `{ message_id }` |

**Notes on `unsend`:**

- `timestamp` may be 0 or null — some platforms, Telegram included, do not report when the deletion happened. Core tolerates this.
- If a platform deletes several messages at once (Telegram's `MessageDeleted` carries multiple IDs), the adapter should emit one unsend notification per deleted message.
- Some platforms omit `chat_id` on deletions in private chats. The adapter should skip those events and log a warning to stderr.

**Core's event ingest contract:**

Core handles every event independently, so a malformed one costs you only that event. An adapter can rely on the following, regardless of which ingest path (live push or backfill) the event arrives on:

- **Per-event isolation.** A malformed event never terminates the daemon and never aborts the remaining events in the same backfill batch.
- **Required fields.** `platform_message_id` and `chat.platform_id` are required for every event type. A `message` additionally requires `content.type` and `sender.platform_id`. Events missing these are dropped with a warning on stderr — they are not written to storage.
- **`chat.type` is not required** for non-`message` events. Core fills in `"unknown"` internally to satisfy its storage type; that value is never written to the chats table and carries no meaning.
- **Unknown `type` values are preserved, not dropped.** Core writes them to the JSONL event log and logs a warning. A future protocol version can add event types without older cores discarding them.
- **Only `message` events notify subscribers.** `unsend` and `read_receipt` change no state that consumers read, so they are logged and stored but trigger no push.

### `status`

A change in adapter connection state.

**Params:**
```json
{
  "state": "connected",
  "detail": "LEGY Push connected"
}
```

`state` is one of `"connecting"`, `"connected"`, `"reconnecting"`, `"disconnected"`,
`"auth_required"`.

### `error`

An internal adapter error.

**Params:**
```json
{
  "severity": "warning",
  "message": "LEGY Push connection lost, reconnecting...",
  "code": "PUSH_DISCONNECTED"
}
```

`severity` is one of `"info"`, `"warning"`, `"error"`, `"fatal"`.

`"fatal"` means the adapter is about to exit.

## Adapter lifecycle

```
Core spawns the adapter process
  │
  ├─ Core sends: initialize { data_dir, platform }
  │   └─ Adapter responds: { capabilities, platform_rate_limits }
  │
  ├─ Core waits for an adapter status: "connected" notification
  │   └─ Timeout: 120 s
  │
  ├─ Core sends: get_contacts {}
  │   └─ Adapter responds: { contacts: [...] }
  │
  ├─ Core sends: get_chats {}
  │   └─ Adapter responds: { chats: [...] }
  │
  ├─ Core sends: get_message_boxes {} (optional, skipped on -32601)
  │   └─ Adapter responds: [ { id, lastDeliveredTime } ] or error -32601
  │
  ├─ Core sends: get_self {} (optional, skipped on -32601)
  │   └─ Adapter responds: { platform_id, display_name } or error -32601
  │
  ├─ Core sends: backfill { chat_id, before_timestamp, count }  (repeated per chat)
  │   └─ Adapter responds: { events, has_more, oldest_timestamp }
  │
  ├─ [Normal operation]
  │   ├─ Adapter sends: event notifications (continuous)
  │   ├─ Core sends: send_message requests (on demand)
  │   └─ Adapter sends: status notifications (on state change)
  │
  ├─ [Shutdown]
  │   ├─ Core sends: shutdown {}
  │   └─ Adapter responds: {} → exit 0
  │
  └─ [Crash recovery]
      ├─ Adapter exits non-zero
      ├─ Adapter Runner ErrorTracker: backoff 5 → 10 → 20 s
      ├─ Restart with backoff
      └─ KillSwitch at 5 consecutive crashes → stop attempting restarts
```

## Auth strategies

First-time authentication differs sharply between platforms:

| Strategy | How it works | Example |
|----------|--------------|---------|
| **Interactive stdin** | The adapter interacts with the user over stdin while daemon-spawned (QR code, authToken) | LINE adapter |
| **Separate login flow** | First auth runs on its own, e.g. `python main.py --auth`, producing a session or token file. Later daemon spawns reconnect automatically using it | Telegram adapter (`--auth` mode) |
| **API token** | An API token is injected through `adapters.json`'s `env` field; no interactive login | Bot-based adapters |

An adapter should document its auth flow in its README. If it uses the separate-login
strategy, its `--auth` mode should read `data_dir` from the `CHATMUX_DATA_DIR` environment
variable (defaulting to `~/.local/share/chatmux`) so it writes the session file to the same
place the daemon-spawned process will look.

## Writing a new adapter

### Minimum implementation

A valid adapter is a standalone program in any language that only needs to:

1. **Read stdin and write stdout** as newline-delimited JSON-RPC — mind the stdout buffering issue in non-Node.js languages, see [Transport](#transport).
2. **Handle the `initialize` request** by reporting capabilities.
3. **Handle the `shutdown` request** by exiting cleanly.
4. **Send `event` notifications** translating platform events into the common format.

### Steps

1. Create a standalone repo or a monorepo subdirectory with an entry point in your language of choice.
2. Implement a stdin JSON-RPC reader and stdout writer, making sure stdout is line-buffered.
3. Implement the `initialize` handler, reporting:
   - `supported_events` — the subset of event types you support
   - `can_send` — whether sending is supported
   - `can_backfill` — whether history fetching is supported
   - `platform_rate_limits` (optional) — platform-specific rate limits
4. Connect to the platform and emit an `event` notification for each event received.
5. If `can_send: true`, implement the `send_message` handler.
6. If `can_backfill: true`, implement the `backfill` handler.
7. Register the adapter's launch command and environment in `$CHATMUX_DATA_DIR/adapters.json`.

### Rules

- An adapter can be TypeScript/Node inside the monorepo, Python in its own repo, or anything else — the only requirement is reading and writing JSON-RPC over stdin/stdout.
- An adapter **must not** touch Storage (JSONL/SQLite) directly. stdio to core is the only channel.
- An adapter **must not** loosen a rate limit. It can only report a stricter one.
- The `raw` field is optional; put the platform's original payload there for debugging, and omit it when it cannot be JSON-serialized.
- `chat_id` from core is always the raw `platform_id` with no `platform:` prefix — the adapter never has to strip anything.
- Keep session files and other platform data under `{data_dir}/adapters/{platform}/`.
- Adapter crashes are restarted automatically by core's Adapter Runner, with backoff. Do not implement your own restart logic.
- External adapters receive secrets such as API keys through the `env` field in `adapters.json`.

---

## Changelog

### v0.4 — core can tell who it is

Additive and non-breaking; a v0.3 adapter runs unchanged.

| Change | Rationale |
|--------|-----------|
| Added optional `get_self` | Core had no platform-independent way to know its own identity, so a message the user sent themselves could not be turned into an event — it had no sender. Consumers therefore never saw their own outgoing messages unless the platform happened to echo them back. Asked after `connected` rather than at `initialize`, because adapters that log in asynchronously do not know their identity yet when `initialize` returns |
| Documented that `send_message.timestamp` is milliseconds | The unit was implied by an example and violated in practice: a platform SDK returning seconds landed messages in 1970, which hid them at the top of the conversation while the send itself reported success |
| Documented that `send_message.message_id` gates landing | Core keys the event it writes on this ID and will not fabricate one, since the same value is the deduplication key against platform echoes |

### v0.3 — optional methods actually close the loop

Additive and non-breaking; a v0.2 adapter runs unchanged.

| Change | Gap ID | Rationale |
|--------|--------|-----------|
| Added optional `last_message_at` to §get_chats | G1 | v0.2 promised "use get_chats for backfill ordering" while its response schema had no time field at all, so the fallback could not actually be implemented. Adding the ordering signal is what makes `get_message_boxes` genuinely optional |
| §get_message_boxes detection is explicitly by `error.code` | G1 | Core now reads the JSON-RPC `error.code` rather than matching message text, so a third-party adapter rewording its error is no longer treated as a hard failure |
| Telegram dropped `get_message_boxes` | G1, G-new-11 | It was a second wrapper around `get_dialogs()`, the same source as its own `get_chats`. Removing it forces the optional fallback path to be exercised for real |
| Removed the `contactName ? "direct" : "group"` inference | G-new-8 | `type` is authoritatively supplied by `get_chats` and is no longer guessed from the contact cache. `chats.type` is `NOT NULL CHECK` with no honest value to fall back on, so a message box that `get_chats` did not report is skipped with a WARN rather than having its type invented. Platforms with sparse or failed contact fetches — Telegram's contacts table measured empty — no longer misclassify DMs as groups |

### v0.2 — generalized after validating against Telegram

| Change | Gap ID | Rationale |
|--------|--------|-----------|
| Added §Adapter configuration | G-new-3 | Documents the adapters.json format and the env field |
| Added the stdout buffering note to §Transport | G-new-2 | Required reading for non-Node.js adapters |
| Corrected the `data_dir` description in §initialize | G7 | Documents the `{data_dir}/adapters/{platform}/` subdirectory convention |
| Reworded §get_contacts | G-new-5 | "all visible contacts" → "contacts as the platform defines them", acknowledging cross-platform differences |
| Made §get_message_boxes optional | G1, G-new-11 | On non-LINE platforms the dialogs API is usually already covered by get_chats; the documented response shape was corrected to the actual raw array |
| Clarified `chat_id` in §send_message | G-new-12, G-new-6 | It is the raw platform_id with no prefix; core owns routing and prefix stripping |
| Clarified `chat_id` in §backfill | G-new-12 | Same as above |
| Marked the `raw` field optional | G-new-9 | May be omitted when it cannot be JSON-serialized |
| Added §Event unsend notes | G-new-10, G5, G8 | timestamp may be 0; multiple IDs split into multiple notifications; events without chat_id are skipped |
| Added §Auth strategies | G-new-1 | Documents the interactive-stdin, separate-login, and API-token modes |
| Rewrote §Writing a new adapter | G6 | Dropped the monorepo assumption in favor of "a standalone program in any language" |
| Marked read_receipt as deferred | G3 | Semantics differ per platform; not mandated in v0.2 |
