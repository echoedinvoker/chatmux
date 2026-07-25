# Architecture

chatmux is a three-layer topology: **Adapter** (connects to an IM platform) → **Core Daemon** (the data layer) → **Consumer** (AI tooling).

## Three-layer topology

```
┌──────────────┐                          ┌──────────────────────────────────┐    MCP Streamable HTTP     ┌──────────────┐
│ LINE Adapter │      stdio JSON-RPC      │           Core Daemon            │ ◄───────────────────────── │ Claude Code  │
│ (Node+tsx)   │ ◄──────────────────────► │                                  │  127.0.0.1 TCP / unix sock │ (MCP client) │
└──────────────┘   child process          │  ┌───────────┐  ┌─────────────┐  │  ~/.local/share/chatmux/   │              │
                   stdin/stdout           │  │ Storage   │  │ SafetyRail  │  │  chatmux.sock              └──────────────┘
┌──────────────┐                          │  │ JSONL+SQL │  │ Rate+Error  │  │
│ Telegram     │      stdio JSON-RPC      │  └───────────┘  │ +KillSwitch │  │
│ Adapter      │ ◄──────────────────────► │                 └─────────────┘  │
│ (Python)     │   child process          │  ┌────────────────┐              │
└──────────────┘   stdin/stdout           │  │ AdapterManager │              │
                                          │  │ config+routing │              │
┌──────────────┐                          │  └────────────────┘              │
│ Future       │      stdio JSON-RPC      │  ┌────────────────┐              │
│ Adapter      │ ◄ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ► │  │ MCP Server     │              │
│ (any lang)   │   child process          │  │ tools+resources│              │
└──────────────┘                          │  └────────────────┘              │
                                          └──────────────────────────────────┘
```

## Process model

| Component | Runtime | Process | Rationale |
|-----------|---------|---------|-----------|
| Core Daemon | Bun | main process | Native `bun:sqlite` bindings, fast startup, zero-config MCP Streamable HTTP |
| LINE Adapter | Node + tsx | child process | LEGY Push needs HTTP/2 duplex, which Bun does not support |
| Telegram Adapter | Python (Telethon) | child process | MTProto user session, lives in its own repo |
| MCP Server | Bun | same process as Core | Direct Storage access, no IPC overhead |
| Future adapters | any runtime | child process | stdio JSON-RPC is a language-agnostic protocol |

**Why adapters are child processes:**

1. **Security boundary** — an adapter can only talk to core over stdio, so every `send_message` is forced through SafetyRail with no way around it.
2. **Fault isolation** — an adapter crash takes down neither the core daemon nor any other adapter.
3. **Language independence** — stdio JSON-RPC lets an adapter be written in any language (since v0.2, new adapters can be Python or Go).
4. **Measured headroom** — the E1 spike put p99 round-trip at 1.075 ms, which is nowhere near stressed by the ~1000 msg/day target.

## Communication protocols

### Adapter ↔ Core: stdio JSON-RPC

Bidirectional, newline-delimited JSON over stdin/stdout:

| Direction | Type | Semantics | Examples |
|-----------|------|-----------|----------|
| Core → Adapter | Request | expects a response (has an `id`) | `initialize`, `get_contacts`, `get_chats`, `send_message`, `backfill`, `shutdown` |
| Adapter → Core | Notification | fire-and-forget (no `id`) | `event` (message / read receipt / status update), `status` (connection state), `error` (error report) |

Full specification: `adapter-protocol.md`.

### Core ↔ Consumer: MCP Streamable HTTP

HTTP/1.1 + SSE, with **two listeners sharing one handler and one session map**:

- **TCP** `127.0.0.1:<port>` (`CHATMUX_MCP_PORT` or `mcp.port` in `adapters.json`, default `7717`; `0` disables)
  — for standard MCP clients such as Claude Code. The MCP spec defines only stdio and streamable HTTP; **there is no unix socket transport**.
- **Unix socket** `$CHATMUX_SOCKET` (default `~/.local/share/chatmux/chatmux.sock`)
  — for same-host sidecar and plugin consumers such as chat.nvim.

| Direction | Type | Semantics |
|-----------|------|-----------|
| Consumer → Core | Tool call | `list_chats`, `read_messages`, `read_events`, `search_messages`, `send_message`, `get_status` |
| Core → Consumer | Resource notification | `notifications/resources/updated`, pushed when a new message arrives |

Full specification: `mcp-interface.md`.

## Data flow

### Receive path (Adapter → Consumer)

```
LINE pushes a message
  → LINE Adapter receives it and decrypts E2EE
  → stdio notification: { method: "event", params: { type: "message", ... } }
  → Core Adapter Runner receives the event
  → Ingest boundary (src/core/ingest.ts): validate shape, isolate per event
      → malformed → warn and drop; the daemon and the rest of the batch are unaffected
  → Storage: landEvent (the single landing entry point, see below)
      → append to JSONL (truth source)
      → project into SQLite (query view):
          message      → INSERT OR IGNORE, deduped by UNIQUE constraint
          edit/unsend  → UPDATE the existing row and move it to the tail of the sequence
      → FTS5 trigger: full-text index updated in step
  → MCP Server: notifications/resources/updated → consumer fetches the latest data
```

**The projection is where change events are applied**, not the ingest boundary above it.
Rebuilding SQLite means replaying the JSONL through that same projection
(`replayJsonl`), so logic living above it would be absent from a rebuild and the two
would diverge. The ingest boundary validates shape and isolates failures; it holds no
storage semantics.

A consumer that needs to resume where it left off uses `read_events` with a cursor
rather than re-fetching resources; see `mcp-interface.md`. Note that an already-delivered
message reappears at a new cursor position when it is edited or retracted — cursors track
changes, not just arrivals.

### Send path (Consumer → Adapter)

```
Claude Code calls the send_message tool
  → MCP Server receives the tool call
  → SafetyRail checks: RateLimiter(5/min) → ErrorTracker → KillSwitch
  → passes → Adapter Runner forwards a send_message request to the LINE Adapter
  → LINE Adapter calls linejs sendMessage
  → returns { message_id, timestamp }
  → Core lands the message it just sent: Storage landEvent (same entry point as above)
      → JSONL → SQLite → MCP Server: notifications/resources/updated
  → MCP tool response → Claude Code
```

The landing step is what lets a consumer display its own outgoing messages. Without it the
message reaches the platform and vanishes from chatmux's own view, unless the platform
happens to echo it back — LINE does, Telegram does not.

### The single landing entry point

Both paths above funnel through `landEvent` (`src/core/storage/land-event.ts`), never
appending on their own. For `message` events it keeps an in-memory map of recently landed
`type:platform:platform_message_id` keys (60 s TTL) and lands whichever path arrives first,
dropping the other with a `deduped echo` log line.

**Only `message` events are deduplicated.** The map exists for exactly one race — core
landing a message it just sent versus the platform echoing that same message back — and
change events have no second source. Applying the map to them is actively harmful:
`edit` and `unsend` both reuse the ID of the message they act on (Telegram's deletion and
edit updates carry no ID of their own), so a bot rewriting one message ten times inside
the TTL would have nine of those edits dropped with nothing written and nothing logged.
The cost of not deduplicating is one extra JSONL line if a platform ever repeats an
`unsend`, and since applying it is idempotent the SQLite state is identical.

`message`, `edit` and `unsend` all notify subscribers — each one changes what a consumer
reads. `read_receipt` does not, so pushing on it would only trigger a wasted re-read.

The deduplication exists for JSONL, not SQLite. SQLite absorbs duplicates through
`INSERT OR IGNORE`; the append-only log has no such defence, and a duplicated line in the
truth source cannot be repaired automatically. Checking on the way in, in one place, is the
only point where both paths can be compared.

Backfill is deliberately outside this: it moves hundreds of messages at once, which would
flood the map, and its duplicate-handling story is SQLite's `INSERT OR IGNORE` anyway.

```
SafetyRail intercepts:
  → RateLimiter over limit → reject with a rate_limited error
  → ErrorTracker sees consecutive failures → back off (5 → 10 → 20 s)
  → KillSwitch trips (3 failures) → disconnect the adapter, manual reset required
```

### Cold start

```
Daemon starts
  → Storage init (create tables, JSONL sync check)
  → SafetyRail init
  → AdapterManager reads adapters.json → spawns a child process per enabled adapter
  → each adapter initializes → reports capabilities + platform_rate_limits
  → Core waits for each adapter's status "connected" notification (120 s timeout)
  → for each connected adapter:
    → get_contacts → contacts written to Storage
    → get_chats → chats written to Storage (including the optional last_message_at,
                  the v0.3 backfill ordering signal)
    → get_message_boxes (optional, skipped when error.code === -32601)
        → only fills in last_message_at for chats already in the chats table
        → any box absent from get_chats is skipped with a WARN — type is never
          guessed, get_chats is the sole authority
    → backfill: walk chats by last_message_time descending, 50 messages per round
      → stops as soon as a global counter hits 500 (does not finish every chat)
      → runs another round if the first pass stayed under 500 and chats remain
  → MCP Server starts
  → begins listening for live push events
```

## Component responsibilities

| Component | Owns | Does not own |
|-----------|------|--------------|
| **Adapter** | Platform connection (auth/push/reconnect), E2EE decryption, event format conversion, reporting platform rate limits | Storage, search, rate-limit decisions, serving MCP |
| **Adapter Runner** | Spawning/watching/restarting adapters, stdio JSON-RPC routing, process-crash ErrorTracker (kill at 5) | Platform-specific logic, storage |
| **Storage** | JSONL writes, projecting events into SQLite (including applying edits and retractions), FTS5 indexing, dedup (SQLite `UNIQUE` + the in-memory landing keys in `land-event.ts`), replay/rebuild, query API | Communication protocols, rate limiting |
| **SafetyRail** | Send rate limiting, send-failure ErrorTracker (kill at 3), KillSwitch | Storage, adapter lifecycle |
| **MCP Server** | Tool dispatch, resource serving, subscription notifications | Platform connections, direct SQLite access (goes through the Storage query API) |

## Data directory layout

```
~/.local/share/chatmux/           # $CHATMUX_DATA_DIR
├── adapters.json                  # Adapter configuration (see adapter-protocol.md)
├── chatmux.sock                   # MCP unix socket (the TCP listener has no file)
├── events.jsonl                   # JSONL truth source (append-only)
├── chatmux.db                     # SQLite query view
├── media/                         # Downloaded images / video / audio
│   └── line/                      # One directory per platform
├── consumers/                     # Consumer-owned state, not part of the data model
│   └── notifier/cursor.json       # e.g. examples/notifier's saved cursor
└── adapters/                      # Per-adapter platform data
    ├── line/
    │   ├── auth.json              # authToken, persisted after the first QR login
    │   └── storage.json           # E2EE key storage
    └── telegram/
        └── chatmux.session        # Telethon SQLite session
```
