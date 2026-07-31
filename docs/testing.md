# Testing

chatmux uses `bun:test` and follows TDD conventions.

## TDD conventions

### Core logic must be test-first

Every behavior in these modules is written test-first:

- `src/core/storage/` (JSONL, SQLite, FTS5, query)
- `src/core/safety.ts` (SafetyRail)
- `src/core/adapter-runner.ts` (JSON-RPC protocol + process management)
- `src/core/mcp/tools.ts` (MCP tools)
- `src/core/mcp/resources.ts` (MCP resources)

### The cycle

1. **Red** — write the test, run `bun test`, confirm it fails because the behavior does not exist yet.
2. **Green** — write the smallest implementation that passes, run `bun test`, confirm it passes.
3. **Refactor** (optional) — clean up, confirm the tests still pass.

### What is not test-first

- The LINE adapter's platform API calls — mocking them costs more than it is worth; integration tests cover this.
  - This covers `get_media`'s three fetch paths (sticker CDN, obs, E2EE decrypt). What *is*
    unit-tested is everything around them: URL construction, `chunks` normalisation, and
    which path a payload routes to — all pure functions in `src/adapters/line/media.ts`.
    Splitting "which route" from "how to fetch" is deliberate: a routing mistake and a
    network failure look identical from the outside, and only one of them is ours.
- `daemon.ts` entry assembly — pure wiring, covered by integration tests.
  - Worth stating plainly, because Phase 2 of F35 nearly shipped without it: the media
    cache's unit tests all inject fake `callAdapter`/`fetchPublicUrl`, so a fully green
    suite says nothing about whether the real dependencies were ever wired into the real
    daemon. Wiring is verified end to end, never by the unit tests passing.
- systemd service configuration.

## The gate is `bun test`, not `tsc`

There is no `typecheck` script — `package.json` has `start`, `dev` and `test` only — and
`bunx tsc --noEmit` has **never** been clean on this repo. On a stashed working tree it
reports 32 errors: `qrcode-terminal` has no type declarations (`src/adapters/line/auth.ts`),
two `unknown[]` values are passed where `SQLQueryBindings` is expected (`src/core/mcp/tools.ts`,
`src/core/storage/query.ts`), and the rest are `string | null` arguments inside `tests/`.

So do not write "typecheck passes" into a plan's acceptance criteria — it cannot pass, and a
plan that requires it stops on its first step. The honest condition is **"no new errors"**:

```
bunx tsc --noEmit 2>&1 | wc -l     # 32 on a clean tree, 2026-07-31
```

Compare the count before and after, and check that no error line names a file you touched.
Fixing the existing 32 is its own task, not a tax on unrelated work.

## Test layout

```
tests/
├── core/
│   ├── safety.test.ts           # SafetyRail (from line-tui)
│   ├── adapter-runner.test.ts   # JSON-RPC protocol + spawn/restart
│   ├── config.test.ts           # adapters.json loading, MCP port resolution
│   ├── multi-adapter.test.ts    # AdapterManager routing across platforms
│   ├── optional-method.test.ts  # Optional protocol methods via error.code
│   ├── storage.test.ts          # JSONL + SQLite + FTS5 + query
│   ├── apply-changes.test.ts    # edit/unsend projected onto existing rows
│   ├── replay.test.ts           # replayJsonl rebuilds the same state
│   ├── fts-retraction.test.ts   # retracted text leaves the FTS index
│   ├── land-event.test.ts       # single landing entry point, dedup scope, notify scope
│   ├── ingest.test.ts           # shape validation + per-event isolation boundary
│   ├── event-cursor.test.ts     # read_events cursor semantics
│   ├── read-events-changes.test.ts # change events re-enter the sequence at the tail
│   ├── daemon-live.test.ts      # live vs backfill ingest wiring
│   ├── daemon-backfill-anchor.test.ts # history walks back, catch-up walks forward
│   ├── cold-start-catchup.test.ts # catch-up loop: termination, priority, outcomes
│   ├── land-backfill.test.ts    # backfill reads SQLite before it writes JSONL
│   ├── mcp-server.test.ts       # Transport: TCP + unix socket listeners
│   ├── mcp-tools.test.ts        # MCP tools + resources
│   ├── media-cache.test.ts      # cache keys/paths, negative cache by kind, LRU, hits
│   └── rederive-content.test.ts # backfilling projection columns from stored raw
├── adapters/
│   └── line/
│       ├── messages.test.ts          # handleEvent + E2EE decrypt (from line-tui)
│       ├── contacts.test.ts          # contact fetch + cache (from line-tui)
│       ├── adapter-responder.test.ts # adapter-side JSON-RPC request handler
│       ├── media.test.ts             # sticker URL, chunks normalisation, source routing
│       └── connection.test.ts        # ConnectionManager (from line-tui)
├── examples/
│   ├── boundary.test.ts         # NEVER #11: examples/ must not import src/
│   └── notifier.test.ts         # Reference consumer drain semantics
├── integration/                 # Live, env-gated, real platform APIs
│   ├── line-send.test.ts
│   └── telegram-send.test.ts
└── spike/
    └── python-handshake.test.ts # Cross-language stdio JSON-RPC proof
```

## Do not translate the CJK test fixtures

`tests/core/storage.test.ts` and `tests/core/mcp-tools.test.ts` contain Chinese strings
such as `"午餐"` (lunch) and `"今天午餐吃拉麵"` on purpose: they are the coverage for the
FTS5 CJK tokenizer strategy, including the 20-term two-character recall check described
in `storage-schema.md`. Replacing them with English would silently delete that coverage —
ASCII text takes an entirely different path through trigram tokenization.

The prose around them is English; the fixtures stay CJK.

## Migrating the line-tui test suite

line-tui had 9 test files and 187 tests. chatmux migrated the parts relevant to core and
the adapter.

### Mapping

| line-tui test file | chatmux target | How | Notes |
|--------------------|----------------|-----|-------|
| `safety.test.ts` | `tests/core/safety.test.ts` | Copy, fix imports | SafetyRail logic unchanged |
| `connection.test.ts` | `tests/adapters/line/connection.test.ts` | Copy, fix imports, adjust event shape | ConnectionManager mocks unchanged |
| `messages.test.ts` | `tests/adapters/line/messages.test.ts` | Copy, fix imports, switch output to the adapter protocol | `handleEvent` output changed from `DisplayMessage` to an event notification |
| `contacts.test.ts` | `tests/adapters/line/contacts.test.ts` | Copy, fix imports | Contact fetch logic unchanged |
| `mcp-tools.test.ts` | `tests/core/mcp-tools.test.ts` | Rewrite | MCP server moved from stdio to Streamable HTTP; tools now query SQLite |

### Not migrated

| line-tui test file | Reason |
|--------------------|--------|
| `capture.test.ts` | TUI screenshots; chatmux has no UI |
| `input-box.test.ts` | TUI input box; chatmux has no UI |
| `stickers.test.ts` | TUI sticker rendering; chatmux does not render |
| `vim-navigation.test.ts` | TUI vim navigation; chatmux has no UI |

### Migration notes

1. **Import paths**: `@evex/linejs` → `npm:@jsr/evex__linejs` (JSR registry).
2. **Mock strategy unchanged**: mock the `PushSource` / `MessageClient` / `ContactClient` interfaces.
3. **bun:test vs jest**: line-tui also used bun:test, so the syntax is fully compatible.
4. **Fast options**: safety tests pass `{ initialBackoffMs: 1, maxBackoffMs: 2 }` to avoid real sleeps.

## Mocking strategy

### Principles

- Mock **external boundaries** (the linejs API, child processes), never internal modules.
- Define mock boundaries with interfaces: `PushSource`, `MessageClient`, `ContactClient`.
- Storage tests use in-memory SQLite (`:memory:`).

### Common mocks

| Module | What is mocked | How |
|--------|----------------|-----|
| `connection.test.ts` | `PushSource` | Fake ReadableStream, with `initLegyPusher()` controllable to succeed or fail |
| `messages.test.ts` | `MessageClient` | `decryptMessage()` returns plaintext, `sendCompactMessage()` returns success |
| `contacts.test.ts` | `ContactClient` | `getContacts()` returns a fake contact list |
| `adapter-runner.test.ts` | Child process | Fake stdin/stdout streams simulating JSON-RPC request/response |
| `mcp-tools.test.ts` | Storage + Adapter Runner | Pre-seeded SQLite fixtures, mocked `send_message` on the adapter runner |
| `notifier.test.ts` | Event source | A fake `callTool` serving canned `read_events` pages. The canned pages are the reference consumer's contract, so they must keep matching the tool's real output — the `type` field and the `edited_at` / `retracted_at` message fields included |
| `storage.test.ts` | Nothing | Uses real `bun:sqlite` (`:memory:`) |

## bun:test conventions

### Basic shape

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

describe("ModuleName", () => {
  let sut: ModuleUnderTest;

  beforeEach(() => {
    sut = new ModuleUnderTest();
  });

  test("should do something when condition", () => {
    const result = sut.method(input);
    expect(result).toBe(expected);
  });
});
```

### Async tests

```typescript
test("should handle async operation", async () => {
  const result = await sut.asyncMethod();
  expect(result).toBeDefined();
});
```

### Naming

- `should <action> when <condition>`.
- Test names describing CJK search behavior may state the metric directly, e.g. "2-character CJK search recall ≥ 80%".

### Running tests

```bash
bun test                             # everything (integration tests skip by default)
bun test tests/core/storage.test.ts  # a single file
bun test --timeout 10000             # longer timeout, for integration tests
```

## Live integration tests

Unit tests isolate each layer with mocks — and those same mocks hide the bugs that live
between layers. All three v0.1 send bugs slipped through exactly that way. A live
integration test exercises the whole chain: `handleSendMessage` (tools.ts) →
`AdapterRunner` → adapter child process → platform API, against a real session.

> **Where the chain stops.** It stops at the platform API. The suite builds its own
> `AdapterRunner` and passes a `SendDeps` of just `{ safetyRail, sendToAdapter,
> isAdapterConnected }` — no database, no JSONL writer. It asserts the send RPC succeeded
> (`success`, `message_id`, `timestamp`) and nothing more. It cannot tell you the message
> landed: no `messages` row, no `events.jsonl` line, no `chats.last_message_at` advance.
> It also cannot, by construction — running it requires stopping the daemon, which is the
> process that does the landing.
>
> To verify landing end to end, drive the **running** daemon's MCP `send_message`
> (`127.0.0.1:7717/mcp`) instead. That is the path nvim actually takes — sidecar → daemon
> MCP → adapter → event back → `landMessage` — so it reaches all three sinks and needs no
> downtime. Assume the two are interchangeable and you will verify a send that never landed.

### Why they are gated

They need a real platform login session and a safe send target, so they cannot run in CI
and are triggered manually.

**Per-platform caveats:**

- **LINE**: the IOSIPAD device slot allows only one client, so stop the chatmux daemon and line-tui before running.
- **Telegram**: the MTProto session is a SQLite file, and two processes opening it produce `database is locked`. Stop the chatmux daemon before running.

### Gating

| Variable | Required | Purpose |
|----------|----------|---------|
| `CHATMUX_LIVE_TEST` | Yes | Set to `1` to enable. Unset or any other value → `describe.skipIf` skips the suite |
| `CHATMUX_TEST_CHAT_ID` | Yes | Send target with platform prefix, e.g. `line:u1234...` or `telegram:123456789`. Using your own ID (send-to-self) is recommended |
| `CHATMUX_DATA_DIR` | No | Defaults to `~/.local/share/chatmux`. Must contain a valid auth session |

Adapter-specific tests take the adapter's own location and credentials from env too — the Telegram
suite reads `CHATMUX_TELEGRAM_PYTHON`, `CHATMUX_TELEGRAM_MAIN`, `TELEGRAM_API_ID`, and
`TELEGRAM_API_HASH`.

> **Never hard-code credentials or absolute paths into a test file**, not even for a suite that is
> skipped by default. A skipped test is still committed, still pushed, and still readable by
> everyone forever — `git log -p` does not respect `describe.skipIf`. Read them from env and fail
> loudly in `beforeAll` when they are missing.

### Running them

```bash
# First: stop the daemon to avoid a session conflict
systemctl --user stop chatmux

# Run, with a long timeout to allow for platform login
CHATMUX_TEST_CHAT_ID=<platform>:<your-id> CHATMUX_LIVE_TEST=1 bun test tests/integration/ --timeout 180000

# Restore afterwards
systemctl --user start chatmux
```

### Writing a live integration test for your adapter

1. Create `tests/integration/<platform>-send.test.ts`.
2. **Gate on env**: `describe.skipIf(process.env.CHATMUX_LIVE_TEST !== "1")`.
3. **Setup** (`beforeAll`):
   - Assert `CHATMUX_TEST_CHAT_ID` is set. It is required, never auto-discovered.
   - Construct a `SafetyRail` with defaults.
   - Construct an `AdapterRunner`. Example spawn callback:
     ```typescript
     import { spawn } from "node:child_process";
     import { resolve } from "node:path";
     import type { SpawnResult } from "../src/core/adapter-runner.js";

     const spawnAdapter = (cmd: string[]): SpawnResult => {
       const proc = spawn(cmd[0], cmd.slice(1), {
         stdio: ["pipe", "pipe", "inherit"],
         cwd: resolve(import.meta.dir, ".."),   // project root
         env: { ...process.env },                // inherit env, including adapters.json env merge
       });
       const exitListeners: ((code: number) => void)[] = [];
       proc.on("exit", (code) => {
         for (const fn of exitListeners) fn(code ?? 1);
       });
       return {
         stdin: proc.stdin!,
         stdout: proc.stdout!,
         stderr: proc.stderr!,
         pid: proc.pid!,
         kill: () => proc.kill(),
         onExit: (fn: (code: number) => void) => { exitListeners.push(fn); },
       };
     };
     ```
   - `runner.start()` only awaits the `initialize` RPC, not platform login. Readiness means the `status: "connected"` notification has arrived.
   - Allow a 120 second connected timeout, since platform login can be slow.
4. **Pick a safe send target** via `CHATMUX_TEST_CHAT_ID`. Prefer your own account (send-to-self) or a dedicated test group, so no real person is bothered. Each platform exposes its self-ID differently; find it during a spike and put it in the env var.
5. **The test case**: call `handleSendMessage(deps, { chat_id: "<platform>:<target>", text: "..." })`.
   - `chat_id` carries the platform prefix.
   - `deps.sendToAdapter` wires to `runner.sendRequest`.
   - `deps.isAdapterConnected` returns `true`, since connection was already awaited.
6. **Assert**: `result.success === true`, `result.message_id` present and non-empty, `result.timestamp` a number.
7. **Teardown** (`afterAll`): `runner.stop()`.
8. **Mutation sanity check** (manual, not in CI): verify at least one regression — deliberately break a layer of the send path, watch the test go red, restore it, watch it go green. This proves the test has teeth.

## Candidate cases for a `chatmux adapter test` conformance harness

There is no harness yet. This is the shortlist for when there is one — cases where an
adapter can be *wrong in a way nothing currently notices*, which is the only kind worth
building a harness for. A case earns its place here by having burned us once.

| Case | What it asserts | Why it is invisible today |
|------|-----------------|---------------------------|
| **Unanchored backfill returns the newest page** | `backfill` with no `before_message_id` answers with the chat's newest `count` messages (protocol §backfill, v0.7.1) | An adapter that returns some other page still returns *valid* messages. Core's cold-start catch-up then re-ingests what it already has, never joins back, and reports success while fetching nothing new. Nothing goes red — not the adapter's tests, not core's. Found 2026-07-29 (F26 Phase 5a): the rule existed only as a side effect of the LINE adapter's else branch and had never been written down |
| **"Nothing older" is distinguishable from "another page"** | With an anchor and no older message available, `events` is either the anchor alone or empty — never a full batch with nothing older (protocol §backfill, v0.7.1) | Core reads a full batch containing nothing older than the anchor as a broken pager. An adapter that pages in some third way gets its retention limit reported as a bug, or worse, its bug reported as a retention limit. Core's own version of this confusion took a dedicated fix (F26 Phase 4.5c) |
| **`get_message_boxes` absence answers `-32601`** | An adapter without the method replies with the JSON-RPC code, not a message-shaped error | Core matches on `error.code` only. An adapter that returns a custom error object instead silently loses its backfill ordering signal |
