# chatmux

Local-first personal chat data layer daemon. Connects IM platforms (v0.1: LINE) via child-process adapters, stores messages to JSONL + SQLite/FTS5, exposes MCP tools for AI clients.

## The three repos

chatmux is the core. Platforms plug in below it, consumers sit above it, and both sides of that
boundary live in their own repos:

| Repo | Role |
|------|------|
| **chatmux** (this one) | Core daemon: storage, safety rail, MCP server, LINE adapter |
| [chatmux-adapter-telegram](https://github.com/echoedinvoker/chatmux-adapter-telegram) | Second platform adapter (Telegram, MTProto user session) |
| [chat.nvim](https://github.com/echoedinvoker/chat.nvim) | Reference consumer: read and reply to chats inside Neovim |

Adapters speak the [adapter protocol](docs/adapter-protocol.md); consumers speak
[MCP](docs/mcp-interface.md). Either side can be replaced without touching the other.

## Quickstart

### 1. Install

```bash
git clone https://github.com/echoedinvoker/chatmux.git
cd chatmux
bun install
```

### 2. Decide whether to connect an account yet

With no `adapters.json`, `bun run start` launches the **LINE adapter**, which means step 3 puts
your LINE account on the line — read [Account Risk Warning](#️-account-risk-warning) before you
run it. If you would rather look around first, start with no adapter at all:

```bash
mkdir -p ~/.local/share/chatmux
cat > ~/.local/share/chatmux/adapters.json <<'JSON'
{
  "adapters": [],
  "mcp": { "port": 7717 }
}
JSON
bun run start
```

The daemon comes up with storage and the full MCP interface — you can `initialize`, list tools,
and read resources. There is simply no chat data behind them until an adapter is connected. Set
`CHATMUX_DATA_DIR` to keep this trial run out of your real data directory:

```bash
CHATMUX_DATA_DIR=/tmp/chatmux-trial bun run start
```

Each entry in `adapters` takes `platform`, a `command` **string**, and an `args` **array**
(plus optional `cwd` and `env`):

```json
{ "platform": "telegram", "command": "python", "args": ["-m", "chatmux_adapter_telegram"] }
```

For Telegram, follow the setup in
[chatmux-adapter-telegram](https://github.com/echoedinvoker/chatmux-adapter-telegram) — it has its
own credentials and login flow, and does not involve LINE.

### 3. First login (QR code)

```bash
bun run start
# A QR code will appear in the terminal
# Open LINE on your phone → open the QR scanner → scan
#   iOS:     Home → the scan icon
#   Android: Home → Add friends → QR code
# After successful login, authToken is saved for future auto-login
```

### 4. Connect Claude Code

Register the daemon's MCP endpoint with Claude Code:

```bash
claude mcp add --transport http chatmux http://127.0.0.1:7717/mcp
claude mcp list   # chatmux: ... - ✔ Connected
```

The daemon listens on two transports at once: a **TCP port on `127.0.0.1`** (default `7717`) for
standard MCP clients like Claude Code, and a **unix socket** for same-host sidecar consumers like
[chat.nvim](https://github.com/echoedinvoker/chat.nvim). Use the TCP url for Claude Code — the MCP
spec only defines stdio and streamable HTTP transports, so no MCP client accepts a unix socket path.

Port is configurable via `CHATMUX_MCP_PORT`, or `mcp.port` in `adapters.json`; set it to `0` to
disable the TCP listener. See [docs/mcp-interface.md](docs/mcp-interface.md).

## Architecture

```
LINE adapter ←── stdio JSON-RPC ──→ core daemon ←── MCP Streamable HTTP ──→ Claude Code
(Node+tsx)        (child process)    (Bun)         (127.0.0.1 TCP / unix)     (MCP client)
                                     ├─ SafetyRail
                                     ├─ Storage (JSONL → SQLite/FTS5)
                                     ├─ Adapter Runner
                                     └─ MCP Server
```

- **Core daemon** (Bun): central process managing storage, safety, and MCP server
- **LINE adapter** (Node+tsx): child process connecting to LINE via IOSIPAD slot
- **Storage**: JSONL append-only truth source + SQLite/FTS5 queryable view
- **MCP server**: Streamable HTTP over TCP (standard MCP clients; loopback by default, settable for containers) + unix socket (same-host sidecars), 8 tools + 4 resources

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_chats` | List chats with last message preview, search, pagination |
| `read_messages` | Read messages from a chat, paginated by timestamp |
| `read_events` | Tail the event log from an opaque cursor — resumable, survives backfill reordering, and re-delivers a message when it is edited or retracted |
| `search_messages` | Full-text search (CJK supported via FTS5 trigram + LIKE fallback) |
| `send_message` | Send message through SafetyRail (rate-limited, error-tracked) |
| `get_media` | Local file path for a message's image or sticker; downloads and caches on first call |
| `probe_latest` | Diagnostic, read-only: ask the adapter for a chat's newest N messages without landing them |
| `get_status` | System status: adapter connection + storage stats |

## MCP Resources

| URI | Description |
|-----|-------------|
| `chat://chats` | All chat list |
| `chat://chats/{id}/messages` | Recent messages for a chat |
| `chat://chats/{id}/info` | Chat details with members |
| `chat://status` | System status |

## Writing a consumer

Core exposes primitives, not policy. Anything that decides *what matters* — which chats
are worth surfacing, where a notification goes, when to stay quiet — belongs in a
consumer, on the far side of the MCP boundary.

[`examples/notifier/`](examples/notifier/) is a working reference: it tails the event
log with a persisted cursor and hands each message to a hook you fill in. Its
`mcp-client.ts` uses raw `fetch` rather than the TypeScript SDK, so it doubles as a
wire-protocol reference for consumers in any language.

## systemd Service

```bash
cp config/chatmux.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now chatmux
```

## Containers

A systemd user service is the intended way to run chatmux. If you want it in a
container instead, [`deploy/container/`](deploy/container/) is a reference that builds
and answers — not an official image, and it runs **zero adapters**, because adapters
hold logged-in sessions and a container you rebuild is the wrong home for those.

The one thing you cannot skip is `CHATMUX_MCP_HOST`. The daemon binds `127.0.0.1` by
default, which inside a container is the container's own loopback — a published port
then maps to a socket nobody is listening on, and every connection is refused while the
logs look perfectly healthy. Read `deploy/container/README.md` before assuming your
port mapping is broken.

## Development

```bash
bun run dev     # Start with --watch (auto-reload)
bun test        # Run all tests
bun run start   # Start daemon
```

See `docs/` for detailed architecture and protocol documentation.

## Limitations

Known and accepted, with what would make each worth revisiting.

- **The chat list caps at 1000, silently.** `chat://chats` is hard-coded to that limit. Consumers
  can detect an overflow by comparing the `total` field against what arrived, so it will not bite
  you without saying so. Worth raising once a vault approaches ~500 chats, or the first time that
  completeness check fires.
- **The JSONL log holds duplicate history.** Backfill re-ingested some messages many times over,
  leaving the event log several times larger than the messages in it. This has stopped: recent
  growth is almost entirely new distinct messages, and the worst-case duplicate count has been
  frozen across repeated measurements. It is not a correctness problem — ingestion is idempotent
  and the SQLite projection is unaffected — so the fix, if ever needed, is a one-off compaction
  rather than a code change. Worth doing if the log passes ~500 MB, if the duplicate count starts
  climbing again, or if cold start slows noticeably.
- **Retractions in Telegram one-to-one chats are missed.** Group retractions land; direct ones do
  not, because the adapter cannot recover the chat id for those events from its entity cache, and
  core will not match a message on id alone — that ambiguity is exactly what the storage key was
  widened to remove. So a message you retracted on your phone can stay visible here. Worth fixing
  once the adapter can resolve the chat id itself, or as soon as retraction accuracy matters to a
  consumer.
- **Reactions are not stored at all.** The platforms send them; no layer reads them. Nothing in
  core, the schema, or the MCP surface represents a reaction, so a consumer cannot show what a
  phone shows. Worth building when reactions carry meaning you would otherwise miss — it is new
  storage, not a display tweak.
- **`read_receipt` is declared but never emitted.** The LINE adapter advertises the capability and
  core is ready to ingest it; nothing constructs the event. Whether read state should reach a UI
  at all is an open product question, not a pending bug — but the declaration is wrong today, so
  do not branch on `supported_events` for this one. Worth fixing as soon as any consumer does
  branch on it, or once that product question gets an answer.

## ⚠️ Account Risk Warning

This project uses **@evex/linejs**, an unofficial LINE client library. Using unofficial APIs may violate LINE's Terms of Service. Your LINE account may be restricted, suspended, or permanently banned. **Use at your own risk.**

The IOSIPAD device slot is used to avoid interfering with your phone's LINE app, but LINE may change their multi-device policy at any time.

## ⚠️ Legal Disclaimer

This software is provided "as is", without warranty of any kind. The author is not responsible for any consequences of using this software, including but not limited to account restrictions, data loss, or violations of third-party terms of service.

This is a personal tool for personal use. Do not use it for spam, harassment, unauthorized access to others' messages, or any illegal activity.

## 🔒 Privacy Disclosure

chatmux stores **decrypted message content in plaintext** on your local machine:
- `~/.local/share/chatmux/events.jsonl` — all events (append-only)
- `~/.local/share/chatmux/chatmux.db` — SQLite database with messages, contacts, chats
- `~/.local/share/chatmux/adapters/line/auth.json` — LINE auth token
- `~/.local/share/chatmux/adapters/line/storage.json` — E2EE key storage

These files are protected by filesystem permissions (owner-only). **Do not share these files.** The auth token grants full access to your LINE account. The E2EE keys can decrypt your messages.

v0.1 does not encrypt the database. SQLCipher encryption is planned for v0.2.

## License

MIT
