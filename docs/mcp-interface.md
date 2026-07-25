# MCP Interface

chatmux exposes 6 tools, 4 resources, and resource subscription over MCP Streamable
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

**Security**: the TCP listener binds `127.0.0.1` only, never a wildcard — the full text
of your conversations travels over it. Note that loopback lacks the file-permission
protection a unix socket has: **any process on the same host can connect**. On a
multi-user machine, or when you do not trust other local programs, set `mcp.port: 0` and
use the unix socket instead.

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
      }
    }
  ],
  "has_more": true,
  "oldest_timestamp": 1689900000000,
  "newest_timestamp": 1690000000000
}
```

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
        "content": { "type": "text", "text": "你好！" }
      }
    }
  ],
  "next_cursor": "evt:1643",
  "head_cursor": "evt:1643",
  "has_more": false
}
```

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

**Current coverage:** only `message` events reach SQLite (see `syncEventToSQLite`), so
only those are sequenced. When other event types get persisted they join **the same**
sequence.

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

**Example output** (blocked by SafetyRail):
```json
{
  "success": false,
  "error": "rate_limited",
  "detail": "Send rate limit exceeded (5/min). Next allowed in 12s."
}
```

**Example output** (adapter unavailable):
```json
{
  "success": false,
  "error": "adapter_unavailable",
  "detail": "LINE adapter is not connected"
}
```

### `get_status`

Returns system status: adapter connection state plus storage statistics.

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

## Resources

### `chat://chats`

Every chat, with a summary of its most recent message.

**URI**: `chat://chats`

**Response**: same shape as the `list_chats` tool output, unpaginated — all chats.

### `chat://chats/{id}/messages`

Recent messages for one chat.

**URI**: `chat://chats/line:c1234567890abcdef/messages?limit=20`

**Response**: same shape as the `read_messages` tool output (the latest N, default 20).

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
  "last_message_at": 1690000000000
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
2. When a new message is written to Storage, the core MCP server sends a `notifications/resources/updated` notification.
3. On receiving it, the client fetches the resource itself to get the latest data.

### Trigger flow

```
Adapter event notification → Core writes to Storage
  → determine the affected resources:
    - new message  → chat://chats (last_message changed)
                     + chat://chats/{affected_chat_id}/messages
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
`examples/notifier/` implements exactly that.
