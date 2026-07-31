# Platform facts

What each platform actually does, as measured — not as its documentation says, and not as its
client library assumes.

## The rule this file exists for

**Before you add any dependency point keyed on a platform field, check it against this list.**

Four kinds of keys count: SQL `WHERE`/`JOIN` conditions, file or directory paths, Map/dict
keys, and cache or index keys.

The rule exists because knowing a fact is not the same as having applied it. `storage-schema.md`
has said since F16 that a platform message id is unique only within a chat, and named the
consequence explicitly: *"any future tool that accepts a message ID must take the chat with
it."* `get_media` was written after that sentence and did not take the chat with it (F45) — it
matched whichever row came first, handed the wrong chat to the adapter, and then remembered the
resulting failure **permanently**, under a key that was itself chat-less. 1567 Telegram ids
were live collision candidates when that was found.

So the discipline is not "document the fact". It is: **when a fact is established, sweep every
existing dependency point — and make the next person adding one check the list first.**

## How to read an entry

Every fact carries what it was verified by (a query with its full filter and the date it was
run, or a file and line). Nothing enters this file on inference.

⚠️ **A reading can go stale.** During F45's own Phase 0 a measurement was correct when taken
and wrong three hours later, because the database grew. Re-run the query rather than quoting
the number, and treat a mismatch as new information rather than as a mistake.

⚠️ **Check the scope of a number before citing it.** This line has been crossed five times;
each time the shape was the same — a number whose scope differed from the claim it was used to
support (see the "口徑鐵律" section of the project note). Fact 2 below is a live example: a
figure measured across every platform was being cited as a LINE fact.

---

## 1. A Telegram message id is per-chat, not globally unique

Telegram numbers messages from 1 within each dialog, so the same id routinely names one
message in a group and a different one in a DM.

```sql
-- 2026-07-31: 1567 ids / 3134 rows
SELECT COUNT(*), SUM(n) FROM (
  SELECT platform_message_id, COUNT(*) n FROM messages
   WHERE platform='telegram' GROUP BY platform_message_id HAVING COUNT(*)>1);
```

Consequences already paid for: F8 (unsend cannot address a message by id alone), F16 (the
schema's unique key became `UNIQUE(platform, chat_id, platform_message_id)`), F45 (`get_media`
plus the media cache path plus the negative-memory key, three places, one assumption).

## 2. A LINE message id is, empirically, globally unique

The claim to check is the **invariant** `COUNT(*) == COUNT(DISTINCT platform_message_id)`, not
the row count — the row count moves every few minutes while the daemon runs. (Re-run twice five
minutes apart and you will see 3260 then 3262; both satisfy the invariant.)

```sql
-- 2026-07-31: 3260 rows / 3260 distinct ids / 66 chats → zero duplicates
SELECT COUNT(*), COUNT(DISTINCT platform_message_id), COUNT(DISTINCT chat_id)
  FROM messages WHERE platform='line';
-- and, specifically, no id appears twice at all:
SELECT COUNT(*) FROM (SELECT platform_message_id FROM messages
   WHERE platform='line' GROUP BY platform_message_id HAVING COUNT(*)>1);   -- 0
```

⚠️ **The "797 ids coexisting in 2 chats" figure is not about LINE.** It was measured across the
whole `messages` table during F16, and its own sample hits were Telegram ids (19017–19021). It
says the *schema* needed a chat in its key — which it did — not that LINE ids collide. Citing
it as a LINE fact was found and corrected during F45's audit.

Uniqueness here is empirical, not a guarantee LINE offers. Code should still take the chat
where it costs nothing; this fact only justifies *not* re-engineering LINE paths for a
collision that does not occur.

## 3. A Telegram DM message id is unique *among DMs* — and only among DMs

```sql
-- 2026-07-31: 5553 rows / 5553 distinct ids / 24 dialogs, 0 cross-DM collisions
SELECT COUNT(*), COUNT(DISTINCT m.platform_message_id), COUNT(DISTINCT m.chat_id)
  FROM messages m JOIN chats c ON c.id=m.chat_id
 WHERE m.platform='telegram' AND c.type='direct';
SELECT COUNT(*) FROM (
  SELECT m.platform_message_id FROM messages m JOIN chats c ON c.id=m.chat_id
   WHERE m.platform='telegram' AND c.type='direct'
   GROUP BY m.platform_message_id HAVING COUNT(DISTINCT m.chat_id)>1);       -- 0
```

First measured in F40.1 (5374/5374/24), re-measured above.

This is the one fact the Telegram adapter's `dm_index.py` rests on: that table keys `chat_id`
on a bare `message_id`, with no chat column. It is safe **only** because both writers are
guarded to DMs (`events.py:87`, `handlers.py:110`) and the reader only fires when Telegram
omits the peer, which is a DM-deletion behaviour (fact 6).

⚠️ **The scope is DMs.** F45 is what crossing this boundary looks like: the same "an id is
enough" reasoning, applied where groups were also in range. If this fact ever stops holding, or
if anything non-DM is ever written into that index, `dm_index` needs a chat column — it is not
a small change to notice late.

## 4. Telegram has no E2EE in this pipeline; over half of LINE's images do

Telegram cloud chats are not end-to-end encrypted, so the adapter can always fetch the bytes
(F40). LINE is the opposite: 53 of 93 images measured in F35 were E2EE, needing keyMaterial and
chunk decryption. LINE image rows now number 101 (`SELECT COUNT(*) FROM messages WHERE
platform='line' AND content_type='image'`, 2026-07-31); the 53/93 ratio is F35's sample, not a
current census.

This is why the two media paths are not symmetrical, and why `get_media`'s three shapes
(public URL / adapter-only bytes / gone) exist at all — see `adapter-protocol.md §get_media`.

## 5. `raw.chunks` is not consistently serialised — normalise, never assume

After a JSON round-trip, LINE's `raw.chunks` is a mix of shapes: of 53 E2EE messages measured
in F35, only 34 kept one shape. `Buffer.from(c.data)` applied blindly throws.

Source and the normaliser: `src/adapters/line/media.ts:25-45` (`normalizeChunks`).

## 6. Telegram omits the peer on DM deletions

A `MessageDeleted` event for a direct message carries no chat (F40.1,
`chatmux-adapter-telegram/events.py:130-142`). Group deletions do carry it. This is why
`dm_index` exists at all, and the reason its lookup is a fallback rather than the primary path:
the event's own peer wins whenever present.

## 7. LINE unsend has a 24-hour limit; Telegram deletion has none

Verified while designing F9's acceptance. Consequence: a retraction arriving for a
months-old message is normal on Telegram and impossible on LINE — so "this cannot be a
retraction, it is too old" is not a valid inference on Telegram.

## 8. LINE animated stickers are `STKOPT ∈ {A, AS}`, not `STKOPT === "A"`

`@evex/linejs` itself gets this wrong (`client/features/message/talk.ts:162`); F35 measured a
409KB APNG under `AS`, which that check silently drops.

Source: `src/adapters/line/media.ts:9-14`.

## 9. A sticker is content-addressed; everything else is message-addressed

The same sticker is sent over and over, so the media cache keys stickers on the sticker id and
shares one file across every chat — that is correct, not a collision. All other media belongs
to one message, so it is keyed on chat **and** message id.

Source: `src/core/media-cache.ts` (`mediaCachePath`, `negativeKey`, `safeChatSegment`).
