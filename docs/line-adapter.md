# LINE Adapter

The LINE adapter is chatmux v0.1's only adapter. It connects through LINE's IOSIPAD
device slot to receive pushed messages.

## linejs (`@evex/linejs`)

An unofficial LINE client library. It provides:

- QR code login and authToken login
- LEGY Push (a long-lived HTTP/2 connection for receiving pushes)
- E2EE message encryption and decryption
- Message sending (`sendCompactMessage`)
- History fetching (`getPreviousMessages`)
- Contact, group, and chat room lookups

**Installation**: via the JSR registry as `npm:@jsr/evex__linejs`, which needs
`@jsr:registry=https://npm.jsr.io` in `.npmrc`.

**Account risk**: linejs uses unofficial APIs, and LINE may restrict or ban the account.
The README must disclose this.

## The IOSIPAD device slot

LINE permits several devices to be logged in at once, and iPad is one of those slots.
chatmux occupies the IOSIPAD slot:

- **It does not affect LINE on your phone**, which uses the PRIMARY slot.
- **Two IOSIPAD clients cannot run at once.** chatmux and line-tui share the slot, so they cannot run simultaneously.
- **Login parameters**: `{ device: "IOSIPAD" as const, storage }`

## LEGY Push (long-lived HTTP/2)

LINE pushes real-time messages over the LEGY Push protocol, which is a long-lived HTTP/2
connection.

### Why the adapter must run on Node+tsx

LEGY Push requires HTTP/2 duplex — reading and writing the same HTTP/2 stream
concurrently. **Bun's HTTP/2 duplex implementation is buggy**: once the connection is
established it cannot read and write at the same time. The LINE adapter therefore has to
run on the Node+tsx runtime.

The core daemon on Bun is unaffected, because MCP Streamable HTTP is HTTP/1.1 + SSE and
needs no HTTP/2.

### Connection management (ConnectionManager)

Migrated from line-tui's `src/connection.ts`. Two concurrent loops:

1. **pushLoop** calls `initLegyPusher()` to establish the long-lived HTTP/2 connection.
   - Success → state becomes `"connected"`.
   - Network error → state becomes `"reconnecting"` → sleep 5 s → retry. Not counted by ErrorTracker.
   - Any other error → emit `error` and let the external ErrorTracker handle it.

2. **consumeLoop** reads events from the `push.stream` ReadableStream.
   - Event read → dispatch to event listeners.
   - Stream ends (`done=true`) → `push.renew()` → sleep 1 s → read again (automatic reconnect).
   - Stream error → catch → renew → retry.

### Connection states

| State | Meaning |
|-------|---------|
| `"connected"` | LEGY Push connection is healthy |
| `"reconnecting"` | Connection dropped, reconnect in progress |
| `"killed"` | Stopped by the KillSwitch; no further reconnects |

### Reconnect policy

- **Network drop** (`isNetworkError`): reconnect after 5 s, not counted by ErrorTracker.
- **Stream ended**: renew the stream after 1 s and reconnect automatically.
- **Non-network error**: emit `error` and let the adapter runner's ErrorTracker decide retry vs. kill.
- **Graceful stop**: `AbortController.abort()` ends both loops together.

Network errors are identified (`isNetworkError`) by:

- Error code: `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENETUNREACH`, `EPIPE`
- Error message containing `"fetch failed"`, `"network"`, `"socket hang up"`, `"econnrefused"`

## E2EE

LINE messages are end-to-end encrypted. linejs's `decryptMessage()` handles decryption:

```typescript
const decrypted = await client.decryptMessage(rawMessage);
```

- **E2EE key storage**: `$CHATMUX_DATA_DIR/adapters/line/storage.json` (linejs `FileStorage`).
- chatmux stores **plaintext** — the decrypted text — because FTS5 full-text search needs it. File permissions of 600 on the DB are the v0.1 security baseline.
- Messages that fail to decrypt are marked `"[無法解密]"` ("cannot decrypt") rather than dropped, so their metadata is preserved.

## QR code login and authToken persistence

### First login

1. No authToken present → start QR code login.
2. Render the QR code in the terminal (the `qrcode-terminal` library).
3. Scan it with LINE on your phone; a PIN may be requested.
4. The QR code expires after 30 seconds, and a new one is generated automatically (up to 5 retries).
5. On success, save the authToken to `$CHATMUX_DATA_DIR/adapters/line/auth.json`.

### Subsequent logins

1. Read the authToken → `loginWithAuthToken(savedToken, opts)`.
2. Success → proceed.
3. Failure (expired token) → fall back to QR code login.

### Token refresh

linejs refreshes the token itself; listen for the `update:authtoken` event:

```typescript
client.base.on("update:authtoken", async (token) => {
  await saveAuthToken(token);
});
```

### Path migration

| Item | line-tui | chatmux |
|------|----------|---------|
| authToken | `data/auth.json` | `$CHATMUX_DATA_DIR/adapters/line/auth.json` |
| E2EE storage | `data/storage.json` | `$CHATMUX_DATA_DIR/adapters/line/storage.json` |

## Media: three source shapes, one method

LINE media does not arrive one way. It arrives three ways, and they have nothing in
common except that a picture comes out the other end. The numbers below are from a full
run over the stored backlog on 2026-07-30 — every row was actually fetched and the bytes
checked with `file`, not sampled and extrapolated.

| Source | How to fetch | What it needs | Result |
|---|---|---|---|
| Sticker | `GET https://stickershop.line-scdn.net/stickershop/v1/sticker/<STKID>/android/sticker.png` | Nothing. No header, no session | 220/220 |
| Image · obs | `client.base.obs.downloadMessageData({ messageId, isSquare: false })` | The stored `authToken` (sent as `x-Line-access`). **No login session** | 22/40 |
| Image · `DOWNLOAD_URL` | Plain `GET` on `raw.contentMetadata.DOWNLOAD_URL` | Nothing. Bot and official-account messages only | 15/15 |
| Image · E2EE | `client.base.obs.downloadMediaByE2EE(message)` | Local keys already in `storage.json`. Zero `client.talk` calls | 46/53 |
| Gone | — | — | 8–10, `status: "notexist"` or 0 bytes |

Two things follow, and both matter more than they look:

- **None of this needs a fresh login.** The whole pipeline runs off credentials the
  adapter already holds. If a change ever seems to require re-logging in, that is a
  signal the wrong API is being used — not a cost to pay. The IOSIPAD slot is single
  occupancy (see above), so a re-login is the most expensive thing in this codebase.
- **`media_url` cannot express this.** Under adapter protocol v0.8 that field means "an
  unauthenticated, directly-linkable public URL", and on LINE only stickers qualify.
  Everything else goes through the optional `get_media` method, which hands core the
  bytes and keeps the token and the E2EE keys inside this process. Consumers only ever
  see a local path.

`isSquare` must stay `false` for talk messages — the `g2` path 404s on every one of them.

### Two silent failure modes, both live in this path

Neither of these throws where the mistake is. Both surface as "the media cannot be
fetched", which points at LINE instead of at us.

**1. `getStickerURL` splits animated from static on the wrong condition.** linejs's own
helper (`client/features/message/talk.ts:162`) treats `STKOPT === "A"` as the animated
case. Measured against the backlog, `STKOPT === "AS"` also carries an APNG — one sample
was 409KB of animation. Copying that helper therefore drops the animation for every `AS`
sticker without an error anywhere; the correct predicate is `STKOPT ∈ {A, AS}`.

`src/adapters/line/media.ts` does not import or copy it. It builds the static URL only,
with no `STKOPT` branch at all — a branch that does not exist cannot be wrong. Animated
stickers are a known gap, not an accident.

**2. `raw.chunks` is not uniformly serialised.** Of 53 stored E2EE messages, 34 have
chunks that are all `{type:"Buffer",data:[…]}` and 19 have plain strings mixed in. Doing
`Buffer.from(c.data)` on every element throws `The first argument must be of type
string, Buffer... Received undefined` on those 19 — a message that reads like E2EE being
unavailable rather than like our own reconstruction being wrong. The first spike drew
exactly that conclusion and nearly wrote off half the feature.

`normalizeChunks` passes strings through untouched, because linejs converts them itself
(`base/e2ee/mod.ts:758,838,902`). The general lesson is worth more than the fix: **when a
spike reports failure, suspect your own code before you suspect the platform.**

## Content type mapping

LINE has several content types, which the adapter normalizes:

| LINE contentType | chatmux `content.type` | Notes |
|------------------|------------------------|-------|
| 0 / `"NONE"` | `"text"` | Plain text |
| 1 / `"IMAGE"` | `"image"` | Image |
| 2 / `"VIDEO"` | `"video"` | Video |
| 3 / `"AUDIO"` | `"audio"` | Voice |
| 7 / `"STICKER"` | `"sticker"` | Sticker; `sticker_id` = `contentMetadata.STKID` |
| 14 / `"FILE"` | `"file"` | File |
| anything else | `"text"` | Formatted as a bracketed type name, e.g. `"[通話]"` (call), `"[位置]"` (location) |

> These bracketed placeholders are currently zh-TW strings baked into
> `src/adapters/line/messages.ts`. They are stored as message text, so changing them
> affects existing rows; treat it as a data decision, not a copy edit.

## Name resolution

The adapter owns all name resolution. The core daemon only ever receives events whose
`display_name` is already filled in.

### Contact scope

`handleGetContacts` calls `fetchAllContacts`, gathering MIDs from three sources:

1. **Friends**: `getUserFriendIds()` → `getContactsV3(friendMids)`
2. **Group members**: `getAllChatMids()` → `getChats(chatMids)` → member MIDs from `extra.groupExtra.memberMids`
3. **DM counterparts**: `getMessageBoxes()` → u-prefixed MIDs

After union, known friends and yourself are filtered out, and the remaining MIDs are
batch-fetched via `fetchContactsByMids` with `BATCH_SIZE=100`.

### DM discovery

Besides groups, `handleGetChats` also takes u-prefixed MIDs from `getMessageBoxes()` as
DM chats (`type: "direct"`), looking up names in the contacts map.

### Event enrichment (live events)

`ContactCache` is populated by the `get_contacts` / `get_chats` RPC handlers after adapter
startup. When a live event arrives:

1. `enrichSenderName(senderMid, cache, client)` — cache hit returns the name; a miss does a lazy `getContactsV3` and adds the result to the cache.
2. MID-pattern guard: `enrichSenderName` checks whether the `displayName` returned by `getContactsV3` is itself a MID pattern (`/^[uc][0-9a-f]{7}/`) and, if so, does not cache it.

### Backfill path limitation

Backfill events return through the `handleBackfill` RPC and do not pass through
`connection.onEvent` enrichment, so their `sender.display_name` is undefined. Core's
`syncEventToSQLite` falls back to inserting `platform_id`, and the name-protection GLOB
ensures a later enriched event overwrites it with a real name.

## Known limitations

1. **No Bun HTTP/2 support** → the adapter must run on Node+tsx.
2. **First-run QR code** → not unattended; a human has to scan it.
3. **E2EE keys are linejs-specific** → switching client library means logging in again.
4. **LINE may ban the account** → unofficial API, no guarantees.
5. **One client per IOSIPAD slot** → chatmux and line-tui cannot run at the same time.

## linejs API gotchas

- Use `client.base.profile!.mid` (not `client.user.mid`) to get your own user ID.
- `getUserFriendIds` needs `{ request: { blockStatus: "ALL" } }` and returns `res.userFriendMids`.
- `getAllChatMids` needs `{ request: { withMemberChats: true }, syncReason: "INTERNAL" }`.
- `getContactsV3` needs `{ mids }` and returns `res.responses[].targetUserMid` plus `targetProfileDetail.profileName`.
- `getContactsV3` **works for non-friends too**, returning `profileName` (verified by a live spike on 2026-07-24).
- When `getContactsV3` has no `profileName` it returns an empty string; the adapter no longer falls back to `slice(0,8)`.
- `getChats` needs `{ chatMids }` and returns `res.chats[].chatMid` plus `.chatName`.
- Group member MIDs from `getChats` live at `extra.groupExtra.memberMids` — a `Record<string, number>` map keyed by MID with a timestamp value — not at the top level.
- `getPreviousMessages` does not exist. Use `getPreviousMessagesV2WithRequest({ request: { messageBoxId, endMessageId, messagesCount }, syncReason: "UNKNOWN" })`.
- `getMessageBoxes({ messageBoxListRequest: {} })` returns every conversation that has messages, both 1:1 and groups.
- `login()` in `auth.ts` must `mkdir(dataDir)` first, or `FileStorage` reading `storage.json` fails with ENOENT.
- `sendCompactMessage({ to: myMid, text })` works when sending to your own MID: the message appears in your self-chat and returns a normal `{ sequenceId, messageId, createdTime }` (verified by a live spike on 2026-07-24). This makes a safe send target for integration tests.
