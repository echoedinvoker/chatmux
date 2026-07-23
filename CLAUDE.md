# chatmux

Local-first personal chat data layer daemon. Connects IM platforms (v0.1: LINE) via
child-process adapters, stores messages to JSONL + SQLite/FTS5, exposes MCP tools for
AI clients (Claude Code). Not a chat app — no UI, pure data layer.

## Commands

- `bun run start` — Start daemon (core + adapters + MCP server)
- `bun test` — Run all tests (bun:test)
- `bun run dev` — Start daemon with --watch (auto-reload on change)

## Directory Structure

- `src/core/daemon.ts` — Entry: start storage → SafetyRail → adapter runner → MCP server
- `src/core/adapter-runner.ts` — Spawn/watch/restart adapter child processes via stdio JSON-RPC
- `src/core/safety.ts` — SafetyRail: RateLimiter → ErrorTracker → KillSwitch
- `src/core/storage/jsonl.ts` — JSONL append-only event writer (truth source)
- `src/core/storage/sqlite.ts` — SQLite schema + JSONL→SQLite sync (query view)
- `src/core/storage/fts.ts` — FTS5 bigram+trigram setup + sync triggers
- `src/core/storage/query.ts` — High-level queries: search, paginated read, stats
- `src/core/mcp/server.ts` — MCP Streamable HTTP on unix socket
- `src/core/mcp/tools.ts` — 5 MCP tools (list_chats, read_messages, search_messages, send_message, get_status)
- `src/core/mcp/resources.ts` — 4 MCP resources + subscription
- `src/adapters/line/` — LINE adapter (Node+tsx, NOT Bun — LEGY Push needs HTTP/2)
- `tests/` — Mirrors src/ structure
- `docs/` — Architecture and protocol references
- `config/chatmux.service` — systemd user service

## Architecture

```
LINE adapter ←── stdio JSON-RPC ──→ core daemon ←── MCP Streamable HTTP ──→ Claude Code
(child process)                      ├─ SafetyRail    (unix socket)
                                     ├─ Storage (JSONL → SQLite/FTS5)
                                     ├─ Adapter Runner
                                     └─ MCP Server
```

- Core = main process (Bun). Adapter = child process (Node+tsx). MCP server = same process as core.
- Two communication boundaries: adapter↔core (stdio JSON-RPC), core↔consumer (MCP Streamable HTTP over unix socket).

## Pattern Selection

### Adapter Protocol (stdio JSON-RPC)

| Direction | Type | Examples |
|-----------|------|----------|
| Core → Adapter | Request (expects response) | initialize, get_contacts, get_chats, get_message_boxes, send_message, backfill, shutdown |
| Adapter → Core | Notification (fire-and-forget) | event, status, error |

### Storage: Dual-Write

Receive event → append JSONL → INSERT OR IGNORE SQLite. JSONL is truth, SQLite is queryable view.

### ID Scheme

External: `platform:platform_id` (e.g. `line:u1234`). Internal: auto-increment PK for FK joins.
Dedup: UNIQUE(platform, platform_id) on contacts/chats; UNIQUE(platform, platform_message_id) on messages.

### SafetyRail: Dual-Layer

Core enforces baseline (5/min send). Adapter reports platform limits via initialize response.
Core takes the stricter of the two. Adapter can only tighten, never loosen.

Two independent ErrorTracker+KillSwitch instances:
- (A) SafetyRail send failures: kill at 3 → disconnect
- (B) Adapter runner process crashes: kill at 5 → stop restart attempts

## NEVER (10 Anti-patterns)

1. NEVER import linejs (or any platform SDK) in core — only adapters touch platform APIs
2. NEVER bypass SafetyRail for send_message — adapter is a child process, stdio is the only channel
3. NEVER write to SQLite without writing JSONL first — JSONL is the truth source
4. NEVER use SQLite auto-increment IDs in external APIs — use `platform:platform_id` composite
5. NEVER run LINE adapter with Bun — LEGY Push needs HTTP/2 duplex (Bun broken), use Node+tsx
6. NEVER store auth tokens in code or env vars — use `$CHATMUX_DATA_DIR/adapters/line/auth.json`
7. NEVER skip INSERT OR IGNORE on SQLite writes — backfill and live events can produce duplicates
8. NEVER JOIN messages_fts with non-indexed tables — the canonical FTS5 external-content JOIN (`messages_fts fts JOIN messages m ON m.id = fts.rowid`) is correct and used by search
9. NEVER assume adapter is running — check adapter status before forwarding send_message
10. NEVER log message content at info level — messages contain private data, use debug level only

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `CHATMUX_DATA_DIR` | `~/.local/share/chatmux` | Data directory (JSONL, SQLite, media, auth) |
| `CHATMUX_SOCKET` | `$CHATMUX_DATA_DIR/chatmux.sock` | MCP unix socket path |
| `CHATMUX_LOG_LEVEL` | `info` | Log level |

## References

- `docs/architecture.md` — Three-layer topology, process model, data flow
- `docs/adapter-protocol.md` — stdio JSON-RPC contract, adapter lifecycle
- `docs/storage-schema.md` — JSONL + SQLite schema, FTS5 dual tokenizer
- `docs/mcp-interface.md` — 5 tools + 4 resources + subscription
- `docs/safety-rail.md` — Dual-layer SafetyRail architecture
- `docs/line-adapter.md` — LINE-specific: linejs, LEGY Push, E2EE
- `docs/testing.md` — TDD conventions, line-tui test suite migration
