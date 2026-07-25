# Storage Schema

chatmux 使用方案 C：**JSONL truth source + SQLite query view**。

## 設計理由

- **JSONL**（append-only）：不可變事件日誌，是資料的唯一真相。未來 rebuild engine（v0.2）可從 JSONL 重建 SQLite
- **SQLite**（query view）：從 JSONL 同步建立的可查詢 view。提供 FTS5 全文搜尋、pagination、stats
- **同步寫入**：receive event → append JSONL → INSERT OR IGNORE SQLite。不做 async queue，降低複雜度

## JSONL Event Schema

每行一個 JSON object，append-only 寫入 `$CHATMUX_DATA_DIR/events.jsonl`。

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

| 欄位 | 型別 | 說明 |
|------|------|------|
| `type` | string | Event type: `message`, `read_receipt`, `unsend` |
| `platform` | string | 平台 ID: `line` |
| `platform_message_id` | string | 平台原生訊息 ID |
| `chat` | object | 聊天室資訊 |
| `sender` | object | 發送者資訊 |
| `timestamp` | number | 平台時間戳（ms） |
| `content` | object | 訊息內容（依 type 變化） |
| `raw` | object | 平台原始資料（debug 用，不索引） |
| `received_at` | number | chatmux 收到時間（ms） |
| `source` | string | `"live"`（推送）或 `"backfill"`（歷史拉取） |

## SQLite Schema

5 個 table + 1 個 FTS5 virtual table。

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

**`type` 的唯一權威是 adapter 的 `get_chats`**。欄位是 `NOT NULL CHECK`，沒有 "unknown" 可填——所以 core **不從其他訊號推斷 type**。曾經有一版用「contacts 表查得到顯示名就算 direct」來猜，那在 LINE（1799 contacts）成立、在 contacts 稀疏或抓取失敗的平台會把每個私聊判成 group。現在 `get_chats` 沒回報的對話一律跳過並 WARN，不發明資料。

**`last_message_at` 的 NULL 語義**：NULL = 「adapter 沒給排序訊號」，不是「很久以前」。寫入時用 `MAX(COALESCE(...))` 保護既有值，但**外層必須包 `NULLIF(..., 0)`**——否則兩邊皆 NULL 時會寫進 epoch `0`，讓「完全沒有排序訊號」偽裝成一個真實時間戳，使 backfill 排序退化**檢查不出來**。`ORDER BY last_message_at DESC NULLS LAST` 依賴這個區分。

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

#### `id` 是寫入順序，`timestamp` 是事件時間——兩者不同

`AUTOINCREMENT` 保證 `id` **單調遞增且永不重用**。它記錄的是「core 第幾次接受這筆寫入」，跟訊息本身發生的時間無關：

```
寫入順序 (id)   timestamp        source
    1           5000             live       ← 剛收到的即時訊息
    2           1000             backfill   ← 回填的舊訊息，timestamp 更小
```

這個差異是 `read_events` cursor 存在的理由。consumer 若用 `timestamp` 記進度（`read_messages({ after: 5000 })`），上表第 2 筆**永遠不會被看到**——它的 timestamp 落在水位線以下。用 `id` 當 cursor 就正常送達。

推論：

- **不要**假設 `ORDER BY id` 等於 `ORDER BY timestamp`
- **不要**把 `id` 當訊息身分對外暴露（NEVER #4）——對外身分是 `platform:platform_message_id`。cursor 是**位置**不是身分，所以以 opaque token（`evt:<id>`）形式輸出
- 從 JSONL 重建 SQLite 會 replay 同樣的檔案順序，因此重建後 `id` 可重現

**序列是稀疏的**：`INSERT OR IGNORE` 撞到 `UNIQUE(platform, platform_message_id)` 時，AUTOINCREMENT 值**已經配掉且不回收**。backfill 重送既有訊息（NEVER #7 預期的情況）會持續燒序列而不新增列。實測某個 1644 筆訊息的 DB，`MAX(id)` 已達 18744、`sqlite_sequence` 到 20837、序列中有 37 個斷點。

推論：`MAX(id)` 與列數無關，cursor 之間的差值**不代表筆數**。

`getHeadSeq()` 刻意用 `MAX(id)` 而非 `sqlite_sequence`——後者會回報一個尚未有任何列存在的位置，讓剛啟動的 consumer 一開始就「超前 head」，誤觸重置邏輯。

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

### messages_fts（FTS5 全文搜尋）

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content_text,
  content='messages',
  content_rowid='id',
  tokenize='trigram'
);
```

FTS5 trigram tokenizer 處理 CJK 子字串搜尋。

## 統一 ID Scheme

| 場景 | 格式 | 範例 |
|------|------|------|
| 對外暴露（MCP tools/resources） | `platform:platform_id` | `line:u1234567890` |
| SQLite 內部 FK | auto-increment PK | `42` |
| Dedup constraint | UNIQUE(platform, platform_id) 或 UNIQUE(platform, platform_message_id) | — |

MCP tools 接收和回傳都用 `platform:platform_id` 複合 ID。SQLite 內部用 auto-increment PK 做 FK join，避免 composite key join 的複雜度。

## FTS5 雙 Tokenizer 策略

### 問題

FTS5 trigram tokenizer 對 **< 3 字元的 CJK 子字串命中率 0%**（如「午餐」「冥想」「散步」都是 2 字，trigram 需要至少 3 字元才能匹配）。

### 策略

E1 spike 驗證 trigram 對 ≥ 3 字 CJK 召回率 85%，查詢延遲 max 0.327ms。2 字 CJK 的 workaround：

**Phase 2.1 TDD 驗證結果：採用方案 B（trigram + LIKE fallback）**

- `messages_fts` 只用 trigram tokenizer
- query 長度 ≥ 3 字 → FTS5 查詢（有索引，sub-ms）
- query 長度 < 3 字 → `SELECT ... WHERE content_text LIKE '%午餐%'`（全表掃描，10k 筆 sub-ms）
- 實測結果：20 個 2 字中文測試詞召回 20/20 = 100%（超過 80% 門檻）
- 選擇理由：最簡單且效能可接受，方案 A 的雙 FTS5 table 複雜度不值得

### FTS5 同步 Trigger

INSERT/DELETE trigger 從 messages 同步到 messages_fts：

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

## 同步寫入流程

```
receive event (from adapter stdio notification)
  │
  ├─ 1. Append to JSONL (truth source, always succeeds unless disk full)
  │
  ├─ 2. INSERT OR IGNORE into SQLite:
  │     a. UPSERT contacts (platform, platform_id)
  │     b. UPSERT chats (platform, platform_id) + update last_message_at
  │     c. INSERT OR IGNORE messages (platform, platform_message_id)
  │     d. FTS5 trigger auto-fires
  │     e. INSERT attachments (if media content)
  │
  └─ 3. 若 SQLite INSERT 失敗:
        a. JSONL 已寫入（不可回滾，by design）
        b. Log warning
        c. 啟動時 sync check 會偵測 JSONL 有但 SQLite 沒有的 event → retry sync
```

### Dedup 語義

- **同一 event 寫兩次**（backfill × live event 交錯）：JSONL 會有兩行（append-only），SQLite 只有一筆（INSERT OR IGNORE）。JSONL 行數 > SQLite 筆數是正常的。
- **啟動時 sync check**：比較 JSONL 最後 100 行的 platform_message_id 是否都存在於 SQLite。有遺漏 → log warning + retry sync（不 abort）。

## 容量估算

以個人使用量估算（~1000 訊息/天）：

| 項目 | 每筆 | 每天 | 每年 |
|------|------|------|------|
| JSONL | ~500 bytes | ~500 KB | ~170 MB |
| SQLite messages | ~200 bytes | ~200 KB | ~70 MB |
| FTS5 index | ~1.5x content | — | ~100 MB |
| Media | 不定 | — | 依使用而定 |

**總計**：~340 MB/年（不含 media），個人使用完全可接受。
