# Storage Schema

chatmux uses option C: **JSONL truth source + SQLite query view**.

## Why

- **JSONL** (append-only) is an immutable event log and the single source of truth. `replayJsonl` (`src/core/storage/replay.ts`) reconstructs SQLite from it by feeding each line through the same projection the live path uses.
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
| `type` | string | Event type: `message`, `edit`, `read_receipt`, `unsend` |
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
  backfill_state TEXT,             -- unknown|partial|exhausted|unavailable (NULL = unknown)
  backfill_attempted_at INTEGER,   -- ms; set on every attempt, success or failure
  backfill_oldest_id TEXT,         -- anchor used last time, to detect a stalled walk
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

**`backfill_state` is a claim made to the user**, not bookkeeping: it surfaces as
`history.state` on `read_messages` and becomes a line above the chat buffer. `exhausted`
renders as "this is everything", so it is written **only when a fetch actually walked the
history back** — an anchored chat that returns nothing older stays `unknown`, because one
call cannot distinguish a chat that bottoms out from a platform withholding the rest.
`unavailable` is reserved for a chat with no anchor at all that came back empty; a network
error or a disconnected adapter must never be recorded as either.

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
  seq INTEGER,
  edited_at INTEGER,
  retracted_at INTEGER,
  UNIQUE(platform, chat_id, platform_message_id)
);

CREATE INDEX idx_messages_chat_timestamp ON messages(chat_id, timestamp DESC);
CREATE INDEX idx_messages_timestamp ON messages(timestamp DESC);
CREATE UNIQUE INDEX idx_messages_seq ON messages(seq);
```

The last three columns arrived with protocol v0.5, added by an idempotent migration
(`ALTER TABLE` guarded by a `PRAGMA table_info` check, then `UPDATE messages SET seq = id
WHERE seq IS NULL` to seed, then the unique index).

**Message identity is per chat, not per platform.** The constraint used to be
`UNIQUE(platform, platform_message_id)`, which assumed a platform hands out message IDs
that are unique across all of its chats. Telegram does not: every dialog counts up from a
small number of its own, so two chats reaching ID `20445` is routine. The consequence was
silent, because `upsertChat` runs before the insert — `chats.last_message_at` moved forward
while `INSERT OR IGNORE` dropped the message row, leaving a chat sorted to the top of the
list by a message nobody could open.

SQLite cannot drop a table-level constraint, so `migrateMessageUniqueKey` does the official
table rebuild: new table, copy (`id` and `seq` **verbatim** — `id` is the FTS
`content_rowid` and the attachments foreign key, `seq` is a cursor already handed to pull
consumers), drop, rename, rebuild indexes, `initFTS` + `INSERT INTO
messages_fts(messages_fts) VALUES('rebuild')`, then `PRAGMA foreign_key_check`. It detects
whether it has already run by reading `PRAGMA index_list` / `index_info` rather than
matching DDL text, and both `PRAGMA foreign_keys` toggles sit **outside** the transaction:
switching that pragma inside one is a silent no-op, which would leave the daemon's
long-lived connection with foreign keys disabled for the rest of the process.

| Column | Meaning |
|--------|---------|
| `seq` | Event-stream position. Assigned `MAX(seq) + 1` on insert **and again on every change to the row**. This is what `read_events` pages on |
| `edited_at` | Timestamp of the most recent edit, or NULL |
| `retracted_at` | Retraction timestamp, or NULL. Non-NULL is the tombstone marker |

#### `seq` is the cursor; `id` is the row's permanent identity

`id` cannot serve as a change-aware cursor: editing message #3 does not move its `id`, so
a consumer parked past it never learns of the change. And `id` cannot be *made* to move —
it is the FTS5 `content_rowid` and the `attachments` foreign key. Hence a second column
whose only job is to jump to the tail whenever the row changes.

- New message → `seq = MAX(seq) + 1`.
- Edit or retraction applied → the same row's `seq = MAX(seq) + 1`, so it re-enters the
  stream ahead of everything a consumer has already seen.
- `getEventsSince` is `WHERE seq > ? ORDER BY seq ASC`; `getHeadSeq` is `MAX(seq)`.

**Existing cursors survived the migration.** Old rows seed to `seq = id`, and since `id`
is AUTOINCREMENT, `MAX(seq) = MAX(id)` at seed time — an already-issued `evt:N` names the
same position under the new semantics. No consumer had to reset. (Verified against the
live store at migration time: 2186 rows, `MAX(id)` 85411.)

**`seq` is sparse, and gaps are not data loss.** A message inserted and then immediately
retracted burns its insert `seq` and moves to a new one, leaving a hole; this was observed
in production the same day the column shipped. `WHERE seq > ?` and `MAX(seq)` only need
monotonicity, never density.

**`seq` is not stable across a rebuild.** Replaying JSONL into a fresh database renumbers
`seq` densely from 1, whereas the live store carries the `seq = id` seed history. Content
matches exactly (verified over 87,587 real events: zero differences in `content_text`,
`edited_at`, `retracted_at`), but **swapping a rebuilt database in for the live one
invalidates every outstanding consumer cursor**. Rebuild is a recovery operation, not a
routine one.

**Concurrency**: the daemon is a single long-lived process and every write is synchronous,
so `MAX(seq) + 1` has no race. `idx_messages_seq` is the safety net — a genuine collision
throws, and `landEvent`'s existing try/catch plus the startup sync check recover it.

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
timestamp falls below the watermark. With a write-order cursor it arrives normally.
(Since v0.5 that cursor is `seq`, not `id` — see above. The argument for having a
write-order cursor at all is unchanged; `seq` merely also moves when a stored row is
edited or retracted.)

Consequences:

- **Do not** assume `ORDER BY id` equals `ORDER BY timestamp`.
- **Do not** expose `id` as message identity (NEVER #4). External identity is
  `platform:platform_message_id`. A cursor is a *position*, not an identity, which is
  why it is emitted as an opaque token (`evt:<seq>`).
- **That external identity is unique only within a chat**, since the underlying constraint
  is. Nothing currently takes a message ID as *input* to look a row up (only
  `send_message` returns one, alongside `chat_id`), so it is sufficient today — but any
  future tool that accepts a message ID must take the chat with it.
- Rebuilding SQLite from JSONL replays the same file order, so `id` values are
  reproducible across a rebuild.

**The sequence is sparse.** When `INSERT OR IGNORE` hits
`UNIQUE(platform, chat_id, platform_message_id)`, the AUTOINCREMENT value **has already been
allocated and is not reclaimed**. Backfill re-sending messages that already exist (the
situation NEVER #7 anticipates) keeps burning sequence numbers without adding rows. On a
real store of 1644 messages, `MAX(id)` had reached 18744, `sqlite_sequence` stood at
20837, and the sequence contained 37 gaps.

Consequence: `MAX(id)` bears no relation to the row count, and the difference between two
cursors **is not a count of messages**. `seq` inherits this sparseness through the
`seq = id` seed and adds gaps of its own (see above).

`getHeadSeq()` deliberately uses `MAX(seq)` rather than `sqlite_sequence`. The latter
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
| Dedup constraint | `UNIQUE(platform, platform_id)` or `UNIQUE(platform, chat_id, platform_message_id)` | — |

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

INSERT, UPDATE and DELETE triggers keep `messages_fts` in step with `messages`:

```sql
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
BEGIN
  INSERT INTO messages_fts(rowid, content_text) VALUES (new.id, new.content_text);
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES ('delete', old.id, old.content_text);
  INSERT INTO messages_fts(rowid, content_text) VALUES (new.id, new.content_text);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES ('delete', old.id, old.content_text);
END;
```

**The UPDATE trigger is what makes retraction actually private.** `messages_fts` is an
external-content table: it holds an index but no copy of the text, and it is not notified
when the content table changes. Before v0.5 there was no UPDATE trigger, because nothing
ever updated `content_text`. Clearing the column without one leaves the original words
sitting in the index — `search_messages` would keep finding a retracted message by its
own text. The projection rules below rely on this trigger rather than on every read path
remembering to filter.

⚠️ **External-content symmetry is a hard contract.** The `'delete'` command's
`old.content_text` must be byte-identical to what was indexed, NULLs included, or the
index corrupts *silently* — no error, just increasingly wrong results. The triggers above
are symmetric by construction: the insert trigger indexes `new.content_text` verbatim, and
the delete command replays `old.content_text` verbatim.

⚠️ **`SELECT ... WHERE rowid = ?` cannot test whether a row is indexed.** An
external-content table answers that query by reading the content table, so it returns a
row whether or not the index knows about it. Only a `MATCH` query goes through the index.
## Synchronous write path

Two things write here: an incoming event from an adapter, and core landing a message the
user just sent (a successful `send_message` produces an event of its own). Both go through
`landEvent` (`src/core/storage/land-event.ts`), which is where the deduplication below
happens. Backfill bypasses it and appends directly — 500 backfilled events would flood the
in-memory key map, and SQLite's `INSERT OR IGNORE` already covers that path. Both paths
still share the ingest boundary (`src/core/ingest.ts`) above `landEvent`, so shape
validation and per-event isolation apply to backfill too.

```
landEvent(event)  ← from an adapter stdio notification, or from a successful send
  │
  ├─ 0. `message` events only: deduplicate on `type:platform:chat:platform_message_id`
  │     (in-memory, 60 s TTL). Already seen → return, write nothing. Otherwise
  │     record the key and continue. `edit` / `unsend` skip this step entirely.
  │
  ├─ 1. Append to JSONL (truth source; always succeeds unless the disk is full)
  │
  ├─ 2. Project into SQLite, branching on event type (see "Projecting change events"):
  │     `message` → a-e run in **one transaction**, so the chat's sort key can never
  │       advance without the message row that justifies it:
  │       a. UPSERT contacts (platform, platform_id)
  │       b. UPSERT chats (platform, platform_id) and update last_message_at
  │       c. INSERT OR IGNORE messages, assigning seq = MAX(seq) + 1
  │          (dropped silently? warn — see below)
  │       d. FTS5 trigger fires automatically
  │       e. INSERT attachments (for media content)
  │     `edit` / `unsend` → UPDATE the existing row in place, bump its seq
  │     anything else → return, touching nothing
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
        (`message`, `edit`, `unsend` — every type that moved stored state;
         `read_receipt` moves none and pushes nothing)
```

### Projecting change events

`syncEventToSQLite` — the JSONL → SQLite projection — is where `edit` and `unsend` are
applied. **Not** in the ingest boundary above it: rebuilding SQLite means replaying the
JSONL through the projection, so anything applied above the projection would be missing
from a rebuild and the two would silently disagree. `src/core/storage/replay.ts` exposes
`replayJsonl(db, events)` for exactly that replay. (Checked against 87,587 real events:
rebuild and live store agreed on `content_text`, `edited_at` and `retracted_at` for every
row, with neither side holding a row the other lacked.)

The same branch serves the backfill path, which calls the projection directly, so both
ingest paths behave identically.

| Situation | Behaviour |
|-----------|-----------|
| `message` | Insert as before, plus `seq = MAX(seq) + 1`. The subquery evaluates at execution time, so an `INSERT OR IGNORE` that hits the unique constraint consumes no sequence number |
| `edit`, target exists and is live | `content_text` = new text, `edited_at` = event timestamp, bump `seq` |
| `edit`, identical to stored state | No-op, **`seq` not bumped**. Without this, the startup sync check would re-apply every edit in its window on each restart and hand pull consumers events carrying no state change |
| `edit`, target already retracted | Refused, WARN. Retraction is terminal; an edit must not resurrect content |
| `edit`, target missing | Not applied, no row created, WARN |
| `unsend`, target exists | `content_text` and `content_media_url` = NULL, `retracted_at` = event timestamp (falling back to arrival time, then to now), bump `seq` |
| `unsend`, already retracted | Idempotent: same values rewritten, **`seq` not bumped** |
| `unsend`, target missing | Not applied, no row created, WARN |
| `read_receipt`, unknown types | Early return, SQLite untouched |

**Retraction is a tombstone, not a delete.** The row survives with its content cleared and
`retracted_at` set. Deleting it outright would orphan the FTS `content_rowid` and the
`attachments` foreign key, and would force the rebuild path to reproduce the deletion.
Clearing the content is also what makes the guarantee structural: `search_messages`,
`read_messages`, the resource read and the chat list's last-message subquery cannot leak
what is no longer there, so none of them needs to remember to filter. The original text
remains in JSONL, which is the point of keeping a truth source.

**A change to a message core never stored is dropped, not queued.** Out-of-order arrival
would lose that edit permanently, which is accepted: dispatch is a synchronous loop so one
adapter's events are naturally ordered, and the realistic out-of-order case — a message
that fell outside the backfill budget and was later edited — has no row to update and no
pending table would produce one.

⚠️ **`retracted_at` must never be 0.** Telegram's delete events carry `timestamp: 0`, and
`0` is falsy in every `if (row.retracted_at)`, which would read as "not retracted". The
fallback chain exists for that, not out of defensiveness.

### Dedup semantics

- **A swallowed insert is never silent.** `INSERT OR IGNORE` is a conflict-resolution
algorithm, not a UNIQUE-only escape hatch: it discards CHECK and NOT NULL violations just
as quietly. So when the statement reports `changes === 0`, core asks whether the chat
actually ended up with that message. It did → a genuine re-delivery (routine: `syncCheck`
replays the JSONL tail on every restart), stay quiet. It did not → the row vanished for
some other reason, log a warning. Historically this path had no log line at all, which is
what let the per-platform unique key corrupt the chat list unnoticed for weeks.

**Two layers, protecting different things.** SQLite is defended by `UNIQUE(platform, chat_id, platform_message_id)` + `INSERT OR IGNORE` and needs nothing else. JSONL is append-only with no constraint at all, so a duplicate there is permanent damage to the truth source — hence the in-memory check inside `landEvent`, before anything is written.
- **The in-memory check guards `message` events only.** It exists for one race: core landing a message it just sent versus the platform echoing that same message back. Change events have no second source, so they never enter the map. Keying it by `type:platform:chat:platform_message_id` and applying it to everything looks safer but is worse — a Telegram `edit` reuses the edited message's ID, so a bot rewriting one message ten times in a minute would have nine of those edits swallowed with no row written and no log line. A genuinely duplicated `unsend` instead costs one extra JSONL line, and since applying it is idempotent the SQLite state is unchanged.
- **A self-sent message can arrive twice**: once when core lands it after a successful send, once when the platform echoes it back as a live event (LINE does this; Telegram does not). Whichever arrives first lands it; the other is dropped with a `deduped echo` log line. The window between them is small and unpredictable — the echo travels the adapter's push connection while the send response travels the RPC channel — which is why the check lives at the shared entry point rather than at either caller.
- **Backfill interleaving with a live event**: JSONL gets two lines, being append-only; SQLite gets one row, thanks to `INSERT OR IGNORE`. More JSONL lines than SQLite rows is normal and expected. Backfill moves hundreds of messages at a time and stays outside the in-memory check by design.
- **Counting rows in SQLite will not reveal duplicates.** `INSERT OR IGNORE` hides them. Verifying deduplication means counting lines in JSONL.
- **Startup sync check**: replays the last 100 JSONL lines through the projection (`replayJsonl`), which fills in any message SQLite is missing and re-applies any change event in that window. It replays rather than checking for missing IDs because a change event alters an existing row instead of adding one, so an existence check would never notice a lost edit. Re-application is harmless: identical edits and repeat retractions short-circuit without moving `seq`. It never aborts startup.

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
