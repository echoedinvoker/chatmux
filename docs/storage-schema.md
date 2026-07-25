# Storage Schema

chatmux uses option C: **JSONL truth source + SQLite query view**.

## Why

- **JSONL** (append-only) is an immutable event log and the single source of truth. A future rebuild engine (v0.2) can reconstruct SQLite from it.
- **SQLite** is a queryable view synced from JSONL. It provides FTS5 full-text search, pagination, and stats.
- **Synchronous writes**: receive event → append JSONL → `INSERT OR IGNORE` into SQLite. No async queue, which keeps the complexity down.

## JSONL event schema

One JSON object per line, appended to `$CHATMUX_DATA_DIR/events.jsonl`.

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
  "raw": {},
  "received_at": 1690000001000,
  "source": "live"
}
```

| Field | Type | Purpose |
|-------|------|---------|
| `type` | string | Event type: `message`, `read_receipt`, `unsend` |
| `platform` | string | Platform ID, e.g. `line` |
| `platform_message_id` | string | The platform's own message ID |
| `chat` | object | Chat information |
| `sender` | object | Sender information |
| `timestamp` | number | Platform timestamp (ms) |
| `content` | object | Message content; shape varies by type |
| `raw` | object | Raw platform payload, for debugging. Not indexed |
| `received_at` | number | When chatmux received it (ms) |
| `source` | string | `"live"` (pushed) or `"backfill"` (fetched history) |

## SQLite schema

Four tables plus one FTS5 virtual table.

### contacts

```sql
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  raw TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
  UNIQUE(platform, platform_id)
);
```

### chats

```sql
CREATE TABLE chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('direct', 'group', 'room')),
  name TEXT,
  last_message_at INTEGER,
  raw TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
  UNIQUE(platform, platform_id)
);
```

**The adapter's `get_chats` is the sole authority on `type`.** The column is
`NOT NULL CHECK`, so there is no "unknown" value to fall back on — which means core
**never infers type from another signal**. An earlier version guessed "if the contacts
table has a display name for it, it is a direct chat". That happens to hold on LINE
(1799 contacts) and misclassifies every DM as a group on any platform where contacts are
sparse or the fetch failed. Chats that `get_chats` did not report are now skipped with a
WARN rather than invented.

**NULL semantics for `last_message_at`**: NULL means "the adapter gave no ordering
signal", not "a long time ago". Writes guard existing values with
`MAX(COALESCE(...))`, but that **must be wrapped in `NULLIF(..., 0)`** — otherwise, when
both sides are NULL, epoch `0` gets written, disguising "no ordering signal at all" as a
real timestamp and making a degraded backfill ordering **undetectable**.
`ORDER BY last_message_at DESC NULLS LAST` depends on that distinction.

### messages

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  platform_message_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL REFERENCES chats(id),
  sender_id INTEGER REFERENCES contacts(id),
  timestamp INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  content_text TEXT,
  content_media_url TEXT,
  raw TEXT,
  source TEXT NOT NULL CHECK(source IN ('live', 'backfill')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
  UNIQUE(platform, platform_message_id)
);

CREATE INDEX idx_messages_chat_timestamp ON messages(chat_id, timestamp DESC);
CREATE INDEX idx_messages_timestamp ON messages(timestamp DESC);
```

#### `id` is write order; `timestamp` is event time. They are not the same

`AUTOINCREMENT` guarantees `id` is **monotonic and never reused**. It records "the Nth
write core accepted", which has nothing to do with when the message itself happened:

```
write order (id)   timestamp        source
       1           5000             live       ← a message that just arrived
       2           1000             backfill   ← older history, smaller timestamp
```

This gap is the entire reason the `read_events` cursor exists. A consumer tracking
progress by `timestamp` (`read_messages({ after: 5000 })`) **never sees row 2** — its
timestamp falls below the watermark. With `id` as the cursor it arrives normally.

Consequences:

- **Do not** assume `ORDER BY id` equals `ORDER BY timestamp`.
- **Do not** expose `id` as message identity (NEVER #4). External identity is
  `platform:platform_message_id`. A cursor is a *position*, not an identity, which is
  why it is emitted as an opaque token (`evt:<id>`).
- Rebuilding SQLite from JSONL replays the same file order, so `id` values are
  reproducible across a rebuild.

**The sequence is sparse.** When `INSERT OR IGNORE` hits
`UNIQUE(platform, platform_message_id)`, the AUTOINCREMENT value **has already been
allocated and is not reclaimed**. Backfill re-sending messages that already exist (the
situation NEVER #7 anticipates) keeps burning sequence numbers without adding rows. On a
real store of 1644 messages, `MAX(id)` had reached 18744, `sqlite_sequence` stood at
20837, and the sequence contained 37 gaps.

Consequence: `MAX(id)` bears no relation to the row count, and the difference between two
cursors **is not a count of messages**.

`getHeadSeq()` deliberately uses `MAX(id)` rather than `sqlite_sequence`. The latter
names a position no row occupies, which would make a freshly started consumer look like
it was already ahead of the log and trip its reset path.

### attachments

```sql
CREATE TABLE attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  type TEXT NOT NULL CHECK(type IN ('image', 'video', 'audio', 'file')),
  original_url TEXT,
  local_path TEXT,
  file_name TEXT,
  file_size INTEGER,
  downloaded_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
);
```

### messages_fts (FTS5 full-text search)

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content_text,
  content='messages',
  content_rowid='id',
  tokenize='trigram'
);
```

The FTS5 trigram tokenizer is what makes CJK substring search work.

## Unified ID scheme

| Context | Format | Example |
|---------|--------|---------|
| Exposed externally (MCP tools/resources) | `platform:platform_id` | `line:u1234567890` |
| Internal SQLite FK | auto-increment PK | `42` |
| Dedup constraint | `UNIQUE(platform, platform_id)` or `UNIQUE(platform, platform_message_id)` | — |

MCP tools accept and return the composite `platform:platform_id`. SQLite uses
auto-increment PKs for FK joins internally, avoiding the complexity of composite-key
joins.

## FTS5 tokenizer strategy

### The problem

The FTS5 trigram tokenizer has a **0% hit rate on CJK substrings shorter than three
characters**. Many common Chinese terms are exactly two characters — 午餐 (lunch),
冥想 (meditation), 散步 (a walk) — and trigram needs at least three to match anything.

### The strategy

The E1 spike measured trigram recall at 85% for CJK queries of three characters or more,
with worst-case query latency of 0.327 ms. Two-character CJK needs a workaround.

**Phase 2.1 TDD result: option B (trigram + LIKE fallback) was adopted.**

- `messages_fts` uses the trigram tokenizer only.
- Query length ≥ 3 → FTS5 query (indexed, sub-millisecond).
- Query length < 3 → `SELECT ... WHERE content_text LIKE '%午餐%'` (full table scan, still sub-millisecond at 10k rows).
- Measured: 20 of 20 two-character Chinese test terms recalled, i.e. 100%, against an 80% threshold.
- Chosen because it is the simplest approach with acceptable performance. Option A's dual FTS5 tables were not worth the complexity.

### FTS5 sync triggers

INSERT and DELETE triggers keep `messages_fts` in step with `messages`:

```sql
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
BEGIN
  INSERT INTO messages_fts(rowid, content_text) VALUES (new.id, new.content_text);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES ('delete', old.id, old.content_text);
END;
```

## Synchronous write path

Two things write here: an incoming event from an adapter, and core landing a message the
user just sent (a successful `send_message` produces an event of its own). Both go through
`landEvent` (`src/core/storage/land-event.ts`), which is where the deduplication below
happens. Backfill bypasses it and appends directly.

```
landEvent(event)  ← from an adapter stdio notification, or from a successful send
  │
  ├─ 0. Deduplicate on `platform:platform_message_id` (in-memory, 60 s TTL)
  │     Already seen → return, write nothing. Otherwise record the key and continue.
  │
  ├─ 1. Append to JSONL (truth source; always succeeds unless the disk is full)
  │
  ├─ 2. INSERT OR IGNORE into SQLite:
  │     a. UPSERT contacts (platform, platform_id)
  │     b. UPSERT chats (platform, platform_id) and update last_message_at
  │     c. INSERT OR IGNORE messages (platform, platform_message_id)
  │     d. FTS5 trigger fires automatically
  │     e. INSERT attachments (for media content)
  │
  ├─ 3. If the JSONL append fails:
  │     a. Nothing was written — release the deduplication key so a retry or the
  │        other path can still land this message, then rethrow
  │
  ├─ 4. If the SQLite INSERT fails:
  │     a. JSONL is already written — not rolled back, by design
  │     b. Keep the deduplication key. The message *has* landed in the truth source;
  │        releasing it would let the other path append a second JSONL line
  │     c. Log a warning
  │     d. The startup sync check finds events present in JSONL but missing from
  │        SQLite and retries the sync
  │
  └─ 5. Notify subscribers that the chat's messages resource changed
```

### Dedup semantics

- **Two layers, protecting different things.** SQLite is defended by `UNIQUE(platform, platform_message_id)` + `INSERT OR IGNORE` and needs nothing else. JSONL is append-only with no constraint at all, so a duplicate there is permanent damage to the truth source — hence the in-memory check inside `landEvent`, before anything is written.
- **A self-sent message can arrive twice**: once when core lands it after a successful send, once when the platform echoes it back as a live event (LINE does this; Telegram does not). Whichever arrives first lands it; the other is dropped with a `deduped echo` log line. The window between them is small and unpredictable — the echo travels the adapter's push connection while the send response travels the RPC channel — which is why the check lives at the shared entry point rather than at either caller.
- **Backfill interleaving with a live event**: JSONL gets two lines, being append-only; SQLite gets one row, thanks to `INSERT OR IGNORE`. More JSONL lines than SQLite rows is normal and expected. Backfill moves hundreds of messages at a time and stays outside the in-memory check by design.
- **Counting rows in SQLite will not reveal duplicates.** `INSERT OR IGNORE` hides them. Verifying deduplication means counting lines in JSONL.
- **Startup sync check**: verifies that the `platform_message_id` of each of the last 100 JSONL lines exists in SQLite. Anything missing logs a warning and retries the sync; it never aborts startup.

## Capacity estimate

For personal usage of roughly 1000 messages per day:

| Item | Per message | Per day | Per year |
|------|-------------|---------|----------|
| JSONL | ~500 bytes | ~500 KB | ~170 MB |
| SQLite messages | ~200 bytes | ~200 KB | ~70 MB |
| FTS5 index | ~1.5× content | — | ~100 MB |
| Media | varies | — | depends on usage |

**Total**: roughly 340 MB per year excluding media, which is entirely acceptable for
personal use.
