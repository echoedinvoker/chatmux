# chatmux

Local-first personal chat data layer daemon. Connects IM platforms (v0.1: LINE) via child-process adapters, stores messages to JSONL + SQLite/FTS5, exposes MCP tools for AI clients.

## Quickstart

### 1. Install

```bash
git clone <repo-url>
cd chatmux
bun install
```

### 2. First login (QR code)

```bash
bun run start
# A QR code will appear in the terminal
# Open LINE on your iPhone → tap QR scanner → scan
# After successful login, authToken is saved for future auto-login
```

### 3. Connect Claude Code

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
- **MCP server**: Streamable HTTP over loopback TCP (standard MCP clients) + unix socket (same-host sidecars), 5 tools + 4 resources

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_chats` | List chats with last message preview, search, pagination |
| `read_messages` | Read messages from a chat with cursor-based pagination |
| `search_messages` | Full-text search (CJK supported via FTS5 trigram + LIKE fallback) |
| `send_message` | Send message through SafetyRail (rate-limited, error-tracked) |
| `get_status` | System status: adapter connection + storage stats |

## MCP Resources

| URI | Description |
|-----|-------------|
| `chat://chats` | All chat list |
| `chat://chats/{id}/messages` | Recent messages for a chat |
| `chat://chats/{id}/info` | Chat details with members |
| `chat://status` | System status |

## systemd Service

```bash
cp config/chatmux.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now chatmux
```

## Development

```bash
bun run dev     # Start with --watch (auto-reload)
bun test        # Run all tests
bun run start   # Start daemon
```

See `docs/` for detailed architecture and protocol documentation.

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
