# Adapter Protocol

> **Protocol version**: 0.8
> **Validated against**: LINE (v0.1, v0.4, v0.5, v0.6, v0.7, v0.7.1), Telegram (v0.2, v0.3, v0.4, v0.5, v0.6, v0.7.1 — still sends the deprecated `last_message_at` name, which core accepts as an alias)
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

`supported_events` is the subset of the [event type enum](#event-type-enum) this adapter
emits. The example above is the LINE adapter, which has no notion of editing a sent
message and therefore does not list `"edit"` — an adapter declares only what its platform
actually supports. The Telegram adapter reports
`["message", "edit", "unsend"]`.

⚠️ One declaration is currently untrue: the LINE adapter lists `read_receipt` but never
constructs the event. See the README's Limitations for why that is accepted for now — the
short version is that no consumer branches on `supported_events` yet. Do not treat this
field as verified until one does.

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
      "last_activity_at": 1690000000000,
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

**`last_activity_at`** (optional, since v0.7; named `last_message_at` in v0.3–v0.6):
the timestamp of the chat's most recent activity as *the platform sees it*, in epoch
milliseconds.

⚠️ **This is not a claim that core received that message.** The field was renamed in v0.7
precisely because the old name implied it was. On LINE, `lastDeliveredTime` covers messages
whose events never reached core, so this value routinely runs ahead of the newest row in
core's `messages` table. Core now stores it in `chats.last_activity_at` and keeps
`chats.last_message_at` for the newest *landed* message — two columns, two meanings, with
the invariant `last_activity_at >= last_message_at`.

> **Deprecated alias**: an adapter that still sends `last_message_at` keeps working
> unchanged — core reads `last_activity_at ?? last_message_at`. The old name is
> **deprecated since v0.7**; no removal date is set, and none will be set until every
> known adapter has migrated.

This is core's **ordering signal for cold-start backfill** — core sorts by
`last_activity_at DESC` and spends its global budget of 500 messages starting from the most
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
> `last_activity_at` from `get_chats` for backfill ordering instead.
>
> ⚠️ **An adapter that does not implement this method should provide `last_activity_at` in
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

### `get_media` (optional)

> **Optional since v0.8.** An adapter that does not support it replies with JSON-RPC error
> `-32601` (Method not found). Core matches on `error.code` only — same convention as
> §get_message_boxes and §get_self — and remembers the refusal for the whole platform
> instead of asking again for every message.

Returns the **bytes** of one message's media attachment. This exists because
`content.media_url` can only describe media that anyone can fetch from a plain URL, and on
a real platform most media is not like that: it may need an auth header, or it may be
end-to-end encrypted and only decryptable by the process that holds the keys. Rather than
teach every consumer those platform specifics, the protocol keeps them where the
credentials already live — inside the adapter — and moves bytes instead of instructions.

Core calls it lazily, when a consumer actually asks to see the media, and caches the result
on local disk. An adapter should therefore treat each call as a one-off fetch and must not
assume core will call it once per message lifetime.

**Deadline: 180s, unlike every other request's 30s.** Downloading bytes is not comparable
to answering a question, and the shared 30s was measured to be the wrong shape entirely:
2026-07-31, on a real vault, a Telegram video refetch took 39.8s and a small file 19.4s —
so every video request timed out, always, while small files sat just inside the limit. An
adapter may take its time here; it may not take its time on `backfill` or `get_self`.

⚠️ **A timeout is not an `unavailable` answer, and core no longer treats it as one.** It
used to collapse a thrown timeout into `{"unavailable": "gone"}` and write that to
`negative.json` with a 24-hour TTL — so one slow download made that attachment report
"deleted from the platform" instantly for the rest of the day, and the retry that would
have succeeded never happened. Timeouts now surface as `timeout` and are remembered
nowhere. The general rule this instance of: **running out of time is evidence about the
clock, not about the world.**

**Request params:**
```json
{
  "platform_message_id": "623174375235650150",
  "chat_id": "u1234567890abcdef",
  "raw": { "...the original payload this adapter sent with the event..." }
}
```

`chat_id` is the raw `platform_id`, without a `platform:` prefix — same as everywhere else.

`raw` is whatever the adapter itself put in the `event` notification's `raw` field, handed
back verbatim. **Core does not parse it**; it stores it and returns it. Two consequences an
adapter must design for:

- ⚠️ **`raw` is not byte-identical to what was sent.** It has been through a JSON
  round-trip, so anything that is not plain JSON has changed representation — a `Buffer`
  comes back as `{"type":"Buffer","data":[…]}`, and some encoders emit a string instead.
  An adapter that reads binary out of `raw` must normalize both shapes. Assuming one of
  them fails on a subset of messages, and the failure looks like "the platform would not
  give me the media" rather than "my own deserialization is wrong".
- An adapter that omitted `raw` on its events gets `null` here, and should answer from
  `platform_message_id` **together with `chat_id`** (both are always in the request) or report
  `unavailable`. On platforms where message ids restart per chat — Telegram does — the id alone
  names a different message in every chat, so an adapter that ignores `chat_id` will
  confidently fetch the wrong thing (F45).

**Response result** (success):
```json
{
  "bytes_base64": "<base64-encoded bytes>",
  "mime": "image/jpeg",
  "file_name": "photo.jpg"
}
```

`file_name` is optional.

**Response result** (the media cannot be produced — still a *successful* response, not an error):
```json
{ "unavailable": "gone" }
```

| `unavailable` | Meaning | Core's caching |
|---------------|---------|----------------|
| `gone` | The platform no longer has the content: deleted, expired, or the object store reports it does not exist | **Permanent.** Core will not ask again |
| `needs_key` | The content exists but this adapter cannot decrypt it (a shared key it never received, for instance) | Permanent for that message |
| `unsupported_type` | This content type has no retrievable media | Permanent for that message |

Core adds one reason of its own, which **an adapter never sends**: `timeout`, when the
request passed the 180s deadline above. It is remembered nowhere — see the warning under
the deadline note.

⚠️ **Report a missing object as `unavailable`, not as a JSON-RPC error.** The distinction is
the whole point: `unavailable` means *asking again will not help*, so core stops asking. A
thrown error means *this attempt failed*, so core retries later. An adapter that throws for
deleted media makes every consumer scroll trigger a fresh network call that can only fail
again; an adapter that reports `unavailable` for a transient network blip permanently hides
media that is still there.

⚠️ **Do not require a fresh login.** This method must work from credentials the adapter
already holds. On LINE all three media shapes do — the sticker CDN needs no auth, the
object store accepts the stored access token, and E2EE images decrypt from local keys — so
nothing here should ever cost the user a re-authentication.

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
  "before_message_id": "623300721831838042",
  "count": 50
}
```

`chat_id` is the raw `platform_id` without a prefix, as in `send_message`.

`before_message_id` is **optional** (v0.6). When present it names an existing message and
the request means "give me the history *before this message*"; `before_timestamp` is that
same message's timestamp. Core fills both from the oldest message it already stores for
that chat, so repeated calls walk backwards instead of re-fetching the newest batch.

**Compatibility both ways.** When `before_message_id` is absent the semantics are exactly
v0.5 — page back from `before_timestamp` alone — so **a v0.5 adapter runs unchanged**, and
a v0.6 adapter must still work when core omits the field (which it does for a chat with no
stored messages yet). Never substitute a placeholder such as `"0"` or an empty string for
an unknown anchor; omit the field.

Anchoring on a message id rather than a timestamp alone is what makes paging work on some
platforms at all: LINE's `getPreviousMessagesV2WithRequest` returns nothing for an anchor
whose message id is `0`, and Telegram's `offset_id` does not lose messages that share a
second the way `offset_date` can.

#### No anchor means "the newest ones"

> **Contract since v0.7.1.** This documents behaviour both first-party adapters already
> had; it is a clarification, not a new requirement.

When `before_message_id` is **absent**, the adapter **MUST** return the chat's newest
`count` messages — not an arbitrary page, and not the oldest ones. Core's cold-start
catch-up depends on this: it starts a chat's catch-up with a deliberately unanchored
request precisely because that is how it asks for "whatever is at the top right now", then
walks backwards with anchors until the batch reaches a message it already stores.

An adapter that answers an unanchored request with some other page does not fail loudly —
it silently returns messages core already has, the loop never joins back, and messages that
arrived while core was offline are never fetched. That failure is invisible from the
outside, which is why it is a MUST.

#### A backfilled message may arrive with a change event attached

`events` is not required to be messages only. When the platform replays a message it
already knows was retracted, the adapter **SHOULD** emit two events for it — the `message`
that creates the row, then the `unsend` that marks it retracted — rather than an `unsend`
alone. Core ignores a change event whose target does not exist (see §change events), and
for a backfilled retraction that target is the row the same batch is about to create; an
unsend on its own therefore does not render as "retracted", it leaves a hole in the
timeline where the message used to be.

Two constraints make this safe to page over, and an adapter emitting pairs **MUST** keep
both:

- **The change event carries the same `platform_message_id` as its message** and a
  timestamp no earlier than it. Core's paging picks the oldest event in the batch as the
  next anchor, so a change event must never be able to become that anchor.
- **The pair counts as two events against `count`.** Core treats `events.length` as a
  request quota, not a row count, so returning fewer distinct messages than asked is
  already legal; what is not legal is hiding the extra event from the array.

LINE's backfill replays retracted messages as `contentType=NONE` with
`contentMetadata.UNSENT="true"`, which is where this rule comes from.

#### The anchor boundary may be inclusive or exclusive

An adapter **MAY** treat `before_message_id` as inclusive (the anchor message itself is in
the response) or exclusive (it is not). Both are legal, because platforms differ and
neither can be had for free: LINE's `getPreviousMessages(endMessageId)` is inclusive,
Telethon's `offset_id` is documented exclusive.

What an adapter **MUST NOT** do is leave "there is nothing older than the anchor"
indistinguishable from "here is another page". Concretely, when no message older than the
anchor exists, the response's `events` MUST be either:

- **just the anchor message itself** (the inclusive style), or
- **an empty array** (the exclusive style).

Core treats both as *the platform declining to go further back* and stops paging that
chat. Anything else — a full batch containing no message older than the anchor — is read as
a broken pager and reported as such, because that is what it usually is.

Core deduplicates, so the anchor coming back a second time costs a redundant row read, not
a duplicate message. Pick whichever your platform gives you naturally.

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

**Cold-start procedure** (core-side logic). Core is not fetching history here — it is
closing the gap that opened while it was offline, which is why it walks *towards* the
newest message rather than away from it:

1. Sort chats so that any chat whose `last_activity_at` is newer than the newest message
   core stores comes first — the platform is reporting activity core has no message for,
   which is exactly the shape of a chat with a hole. The rest follow by `last_activity_at`
   descending.
2. Skip chats where core stores no message at all. There is nothing to join back to, and
   fetching a whole history belongs to the on-demand path, not to cold start.
3. For each remaining chat, request `count=50` **without** `before_message_id` — that is
   the "give me the newest ones" request above. Then keep paging backwards, each round
   anchored on the oldest message of the previous one, until a batch reaches a message core
   already stores. That is the gap closed.
4. Give up on a chat after 3 rounds, and stop the whole pass after 500 messages. Both
   limits are recorded per chat rather than left silent, so a hole core ran out of budget
   for stays visible instead of reading as "no hole".

History older than what core already stores is still fetched on demand when a chat is
actually opened (see `before_message_id` above).

**Backfill interleaving with live events**: backfill and live push can produce events with
the same message ID. Core's Storage deduplicates with `INSERT OR IGNORE` against a UNIQUE
constraint on (platform, chat_id, platform_message_id). Adapters do not need to handle this — dedup
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

A platform event. This is the central notification — new messages, edits, read receipts,
and unsends all travel through it.

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
| `message` | A new message | `{ type: "text"\|"image"\|"video"\|"audio"\|"sticker"\|"file", text?, media_url?, sticker_id?, package_id?, file_name? }` |
| `read_receipt` | Read receipt (deferred in v0.2: semantics differ per platform, so support is at the adapter's discretion) | `{ chat_id, read_up_to: timestamp }` |
| `unsend` | A retracted message | `{ message_id }` |
| `edit` (optional, since v0.5) | An already-delivered message whose content changed | Same shape as `message` — the **full** new content, not a diff |

**Notes on `message` content:**

- `package_id` is optional: the platform ID of the sticker pack a sticker belongs to. LINE takes it from `contentMetadata.STKPKGID`. Platforms with no sticker-pack concept omit it.
- `media_url` (since v0.8) means one specific thing: **a public URL that anyone can fetch with no authentication, and that any consumer may cache.** No header, no token, no cookie, no local key. Media that needs any of those **must not** be described with this field — expose it through §get_media instead and leave `media_url` absent. Filling it in with a URL that only works for the adapter is worse than leaving it empty: a consumer will try the URL, get a 401 or 403, and report the media as broken. On LINE only stickers qualify (the sticker CDN is open); photos need either the stored access token or local decryption, so they carry no `media_url` at all.

**Notes on `unsend`:**

- `timestamp` may be 0 or null — some platforms, Telegram included, do not report when the deletion happened. Core tolerates this and falls back to the event's arrival time, because `retracted_at = 0` is indistinguishable from "not retracted" in every truthiness check.
- If a platform deletes several messages at once (Telegram's `MessageDeleted` carries multiple IDs), the adapter should emit one unsend notification per deleted message.
- Some platforms omit `chat_id` on deletions in private chats. The adapter that cannot recover the chat should skip those events and log a warning to stderr.
  - **Telegram**: this is exactly what happens in one-to-one chats — `UpdateDeleteMessages` carries no peer, so Telethon reports `chat_id = None`. Core's rule is unchanged: `chat.platform_id` is still required on every event including `unsend`. The Telegram adapter recovers the peer on its own side instead, keeping a persistent `message_id` → `chat_id` index of the DMs it has seen (written from both the live stream and backfill) and looking the deletion up there. **Retraction therefore works in DMs as well, for messages the adapter has indexed**; an id that misses the index is still skipped rather than guessed. This is the shape to copy on any platform with the same gap: recover the chat in the adapter, do not ask core to accept an event without one.
  - The prerequisite that made this safe is that a Telegram DM message id identifies one message *among DMs* — measured at 5374 messages / 5374 distinct ids across 24 dialogs. Note the scope: Telegram message ids are numbered per chat, so the same id routinely appears in both a DM and a group. Anything keyed on `platform_message_id` alone, without a chat, is ambiguous on this platform.

**Notes on `edit`:**

- **Optional capability.** An adapter declares it in `supported_events`; core never requires it. LINE has no editing concept and does not implement it. This is the same opt-in mechanism as `get_message_boxes` (v0.3) and `get_self` (v0.4), applied to an event type instead of a method.
- `platform_message_id` is **the edited message's own ID**, not a new one — same convention as `unsend`. Core looks the target up by `(platform, chat.platform_id, platform_message_id)` and updates that row in place.
- `content` is the **complete** post-edit content, not a diff. Core replaces, it does not merge.
- `timestamp` is the edit time in epoch milliseconds. Platforms that do not report one may send 0; core falls back to arrival time.
- `sender` is not required — core ignores it for `edit`, since the target row already has one.
- **Rapid repeated edits are expected and must all be delivered.** A streaming bot rewrites the same message many times within seconds. Core does not deduplicate `edit` events, so an adapter must not coalesce or drop them either.
- Core's projection rules, for adapter authors reasoning about what a consumer will see: an edit whose target does not exist is logged and ignored (no ghost row is created); an edit whose target is already retracted is refused (retraction is terminal); an edit identical to the stored state is a no-op that does not advance the event stream.
- **`content.text` must be a string.** Core drops an `edit` without one at the ingest boundary (`ingest.ts`), before storage ever sees it — so this is a validation rule, not a projection detail.
- **Caption edits on media messages do land** (corrected 2026-07-31; this line used to say they were "not carried through"). The adapter's job is to send `content.text: ""` rather than omitting it when a caption was cleared — see `chatmux-adapter-telegram/events.py:119` (`evt["content"].setdefault("text", "")`). `content.type` stays whatever it was, so the edit changes the caption without disturbing media the consumer already holds; core stores the new text on the media row and a consumer renders it beside the media placeholder (chat.nvim does since F44). Verified end to end on Telegram pmid 21966: `content_text` = "F40 S3 已編輯的 caption", `content_type` still `image`.
- An `edit` cannot change a message's media, only its text.

**Core's event ingest contract:**

Core handles every event independently, so a malformed one costs you only that event. An adapter can rely on the following, regardless of which ingest path (live push or backfill) the event arrives on:

- **Per-event isolation.** A malformed event never terminates the daemon and never aborts the remaining events in the same backfill batch.
- **Required fields.** `platform_message_id` and `chat.platform_id` are required for every event type. For `edit` and `unsend`, `chat.platform_id` is not bookkeeping — core addresses the target row by `(platform, chat, platform_message_id)`, because message IDs repeat across chats on platforms like Telegram. An `edit` or `unsend` that arrives without a chat is logged and **not applied**: retracting the wrong chat's message is worse than retracting nothing. A `message` additionally requires `content.type` and `sender.platform_id`; an `edit` additionally requires `content.type` and `content.text`. Events missing these are dropped with a warning on stderr — they are not written to storage.
- **`chat.type` is not required** for non-`message` events. Core fills in `"unknown"` internally to satisfy its storage type; that value is never written to the chats table and carries no meaning.
- **Unknown `type` values are preserved, not dropped.** Core writes them to the JSONL event log and logs a warning. A future protocol version can add event types without older cores discarding them.
- **Every event that changes stored state notifies subscribers.** `message`, `edit` and `unsend` all push. `read_receipt` does not — it is the only event type that changes nothing a consumer reads. (Before v0.5 only `message` pushed, because `edit` did not exist and `unsend` was stored without being applied.)
- **Change events are applied to the existing row, not appended as new ones.** `edit` replaces the target's content; `unsend` clears it and marks the row retracted. The JSONL event log stays append-only either way — the original text remains recoverable there, and replaying the log rebuilds the same SQLite state.

### `status`

A change in adapter connection state.

**Params:**
```json
{
  "state": "connected",
  "detail": "LEGY Push connected",
  "last_liveness_evidence_at": 1753765200000
}
```

`state` is one of `"connected"`, `"reconnecting"`, `"killed"`.

`last_liveness_evidence_at` (optional, epoch ms) is the last moment the adapter
had evidence its stream was alive — it advances only when the stream produces
data or is successfully rebuilt. It is omitted while no such evidence exists.

**`connected` means "no evidence the stream is dead", not "proven alive".**
A push stream can die without any local error: the socket stays open, nothing
throws, and the adapter goes on believing it is connected. Consumers judging how
much to trust the state should read `last_liveness_evidence_at`, not `state`.

Core compresses these three states into a boolean, so a `reconnecting` adapter
surfaces through `get_status` and `chat://status` as `"disconnected"`. Those
query APIs never emit the string `"reconnecting"`.

**Adapters must re-send `status` on a throttle, not only when `state` changes.**
Core has no way to poll for the timestamp, so an adapter that reports only on
transitions leaves it frozen at whatever it was during the last transition — in
the steady case (connected, events flowing) that is the moment of connection,
possibly hours stale, or absent entirely. The LINE adapter re-emits at most once
per `CHATMUX_F27_LIVENESS_REPORT_MS` (default 30s) whenever stream evidence
arrives.

**A long `disconnected` stretch does not by itself mean the connection is
broken.** Only stream evidence promotes an adapter back to `connected`, so a
genuinely healthy but idle chat account is reported the same way as a dead
stream. This is deliberate — claiming `connected` without evidence is the
failure this design removes — but it means consumers should treat
`liveness_age_seconds` as the severity signal, not the state string alone.
Distinguishing "quiet" from "broken" would need active probing, which no adapter
currently does.

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
  ├─ Core sends: backfill { chat_id, before_timestamp, before_message_id?, count }  (per chat)
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

### v0.8 — media moves as bytes, not as instructions

`content.media_url` carried an assumption that does not survive contact with a real
platform: that every attachment has a URL a consumer can just fetch. On LINE it holds for
stickers and for nothing else — photos need an auth header, and end-to-end encrypted photos
need keys that exist only inside the adapter process. Fifty-eight of the ninety-eight LINE
photos in a real store are E2EE; for those there is no URL to hand out at all.

The alternative we rejected was to widen the field — add a "how to fetch this" kind plus a
header bag — and let consumers execute the recipe. That pushes one platform's auth scheme
into a cross-platform protocol, obliges every consumer to implement all three fetch paths,
and takes credentials out of the one process that is supposed to own them. Moving bytes
instead keeps the platform specifics behind the adapter boundary, where they already are.

| Change | Rationale |
|--------|-----------|
| New optional method §get_media: given a message, return its media bytes, or `unavailable` with a reason | Lets an adapter serve media it can only fetch with its own credentials, or only decrypt locally, without publishing either to consumers. Optional via `-32601`, the same opt-in mechanism as v0.3's `get_message_boxes` and v0.4's `get_self`, so existing adapters need no change |
| `unavailable` is a *successful* result, not a JSON-RPC error, with a fixed value set (`gone` / `needs_key` / `unsupported_type`) | Core has to tell "asking again cannot help" apart from "this attempt failed", and only the adapter knows which it is. Collapsing both into an error means every consumer scroll re-fetches media that was deleted months ago |
| §event: `media_url` is narrowed to "public, unauthenticated, cacheable by anyone" — authenticated or encrypted media must leave it absent | The old wording did not say, so an adapter could reasonably put a token-gated URL there. A consumer then fetches it, gets 403, and shows the media as broken — a failure that looks like a consumer bug and is invisible to the adapter author |
| §get_media: `raw` is passed back verbatim and is explicitly **not** byte-identical to what was sent | A JSON round-trip rewrites anything non-JSON, and `Buffer` in particular comes back in more than one shape. An adapter that assumes a single shape fails on a subset of messages, and the symptom — "the platform will not give me the media" — points away from the actual bug |

### v0.7.1 — what "no anchor" and "nothing older" mean

Clarification only. Both first-party adapters already behave this way; no adapter needs a
change. The version is bumped so a third-party author can tell whether their copy of this
document predates the rule.

| Change | Rationale |
|--------|-----------|
| §backfill: an absent `before_message_id` MUST mean "the newest `count` messages" | Core's cold-start catch-up asks for the top of the chat by *omitting* the anchor, then pages backwards until it reaches a message it already stores. That behaviour existed only as a side effect of the LINE adapter's else branch and was never written down — a third-party adapter built strictly from this document could page differently, and catch-up would silently fetch nothing new while reporting success |
| §backfill: the anchor boundary MAY be inclusive or exclusive, but "nothing older" MUST be either the anchor alone or an empty array | The two first-party adapters already differ (LINE inclusive, Telethon documented exclusive) and neither can cheaply become the other, so mandating one would break a shipped adapter for no gain. What core actually needs is not a single boundary but the ability to tell *"the platform will not go further back"* apart from *"the pager is broken"*; pinning down only that distinction leaves both styles legal |

### v0.7 — the ordering signal is activity, not a landed message

Additive and non-breaking; a v0.6 adapter runs unchanged via the deprecated alias.

| Change | Rationale |
|--------|-----------|
| Renamed `last_message_at` → `last_activity_at` in §`get_chats` and §`get_message_boxes` ordering | The old name asserted something the value cannot promise. LINE's `lastDeliveredTime` covers messages core never received an event for, so core was storing "the platform saw activity at T" in a column read as "the newest message is from T" — the chat list then paired that timestamp with the text of a much older message. Core now keeps the two apart (`chats.last_activity_at` vs `chats.last_message_at`, invariant `last_activity_at >= last_message_at`) |
| Old name kept as a deprecated alias (core reads `last_activity_at ?? last_message_at`) | The Telegram adapter lives outside this repo; a hard rename would have silently cost it its backfill ordering signal. No removal date is set |

### v0.6 — backfill can say "before *this* message"

Additive and non-breaking; a v0.5 adapter runs unchanged.

| Change | Rationale |
|--------|-----------|
| Added optional `before_message_id` to §backfill | Core could only say "before *now*", so every call re-fetched the newest batch and history never advanced. Measured against live accounts: with a real anchor one LINE call reached 4 days further back and one Telegram call nearly a month further back than the same call without one |
| Documented that an unknown anchor is omitted, never faked | LINE treats `messageId: 0` as "no anchor" and falls back to its message-box list, which returns nothing for a chat the device never synced — the failure that made ~47% of LINE chats look empty. A placeholder id is therefore worse than an absent field |
| Documented that Telegram prefers `offset_id` over `offset_date` | Two messages in the same second are indistinguishable by date, so date-only paging can skip or repeat across the boundary |

### v0.5 — a delivered message can still change

Additive and non-breaking; a v0.4 adapter runs unchanged. LINE required zero changes and
was verified to keep delivering messages throughout.

| Change | Rationale |
|--------|-----------|
| Added optional event type `edit` | Editing a delivered message was invisible to consumers, which is not a cosmetic gap: **any bot that streams its output by rewriting one message — the standard shape of an LLM bot — was permanently stuck at its first frame.** `edit` is opt-in via `supported_events`, so platforms without the concept (LINE) implement nothing |
| `unsend` is now applied, not merely stored | v0.4 stored retraction events and did nothing with them, so a retracted message stayed fully readable and searchable. Core now clears the content, stamps `retracted_at`, and drops the text from the search index |
| Rewrote "Only `message` events notify subscribers" | It was true only because change events were inert. With `edit` and `unsend` applied to stored state, withholding the push would leave consumers displaying content the platform no longer has |
| Documented that `edit`/`unsend` reuse the target's `platform_message_id` | Both address an existing row rather than creating one. Stated explicitly because it is what lets core find the target at all, and because it means a dedup key of `(platform, platform_message_id)` alone would swallow every change event |
| Documented that adapters must not coalesce rapid `edit`s | The originating use case emits many edits per second against one message; any collapsing along the path shows the user a stale intermediate frame |
| Documented the Telegram DM retraction limitation under §unsend | `UpdateDeleteMessages` carries no peer, so DM deletions never reach core. Recorded as a known gap rather than left to be rediscovered |

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
