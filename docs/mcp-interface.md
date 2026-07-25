# MCP Interface

chatmux 透過 MCP Streamable HTTP 暴露 6 個 tools + 4 個 resources + resource subscription，**同時開兩個 listener**。

## 傳輸

- **Protocol**：MCP Streamable HTTP（HTTP/1.1 + SSE）
- **SDK**：`@modelcontextprotocol/sdk`

兩個 listener 共用同一組 handler 與 session 狀態，功能完全一致，差別只在誰連得上：

| Listener | 位址 | 給誰用 | 為什麼 |
|----------|------|--------|--------|
| **Unix socket** | `$CHATMUX_SOCKET`（預設 `~/.local/share/chatmux/chatmux.sock`） | 同機的 sidecar / plugin consumer（如 chat.nvim 的 Bun sidecar） | 檔案權限即存取控制；Bun 的 `fetch({ unix })` 直接支援 |
| **TCP** | `127.0.0.1:<port>`（預設 `7717`） | 標準 MCP client（Claude Code 等） | **MCP spec 只定義 stdio 與 streamable HTTP 兩種 transport，不含 unix socket** |

> ⚠️ **不要把 unix socket 路徑餵給 Claude Code**。MCP 設定沒有 `socketPath` 這個欄位——client 只接受 stdio（`command`/`args`）或 streamable HTTP 的 TCP `url`。這是 spec 層級的限制，不是實作缺漏。

### Claude Code 設定

```bash
claude mcp add --transport http chatmux http://127.0.0.1:7717/mcp
```

驗證連線：

```bash
claude mcp list
# chatmux: http://127.0.0.1:7717/mcp (HTTP) - ✔ Connected
```

### TCP port 設定

優先序：環境變數 > 設定檔 > 預設值。

| 來源 | 形式 | 備註 |
|------|------|------|
| `CHATMUX_MCP_PORT` | 環境變數 | 最高優先 |
| `adapters.json` 的 `mcp.port` | `{ "mcp": { "port": 7717 }, "adapters": [...] }` | 次之 |
| 預設 | `7717` | 都沒設定時 |

設 `0` 可**停用 TCP listener**，只留 unix socket。

值不合法（非整數、超出 `0-65535`）時 daemon 直接啟動失敗，不會安靜退回預設值。

**安全性**：TCP listener 只綁 `127.0.0.1`，永不綁 wildcard——聊天全文都在這條線上。但要注意 loopback 沒有 unix socket 的檔案權限保護：**同機任何 process 都連得上**。多使用者主機或不信任同機程式時，設 `mcp.port: 0` 關掉 TCP，改用 unix socket。

## Tools

### `list_chats`

列出所有聊天。支援平台篩選、搜尋、分頁。

**Input Schema**：
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

**Output 範例**：
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

讀取特定聊天的訊息。支援 cursor-based pagination（before/after timestamp）。

**Input Schema**：
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

**Output 範例**：
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

從 cursor 續讀事件日誌。這是 **push consumer 的基礎 primitive**——回答「這個位置之後發生了什麼」。

**為什麼不能用 `read_messages({ after })` 代替**：`after` 篩的是 **timestamp**，而 backfill 會插入比既有資料更舊的訊息。consumer 用 timestamp 記進度，那些訊息**永遠看不到**。cursor 走的是 **core 接受寫入的順序**，所以照樣送達。

**Input Schema**：
```json
{
  "type": "object",
  "properties": {
    "since": { "type": "string", "description": "Opaque cursor from a previous read_events / get_status call. Omit to start tailing from now." },
    "limit": { "type": "number", "default": 100 }
  }
}
```

**Output 範例**：
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

**Cursor 契約**：

| 規則 | 說明 |
|------|------|
| **Opaque** | cursor 是不透明 token。原封不動回傳，**不要 parse、比較大小或做算術**。編碼將來會變 |
| **省略 `since`** | 回傳當前 head、events 為空。新 consumer 用這個「從現在開始跟」，不必 replay 全部歷史 |
| **`next_cursor`** | 下次呼叫要傳回來的位置。沒有新事件時**維持原位**，所以閒置的 consumer 不會失去有效 cursor |
| **`head_cursor`** | 日誌目前的尾端。若你存的 cursor 超前 head（SQLite 被重建或截斷），代表該重置——否則會永久停滯 |
| **無效 cursor** | 回 `{ "error": "invalid_cursor", "detail": ... }`，不是靜默回空 |
| **順序** | 事件依 core 接受順序**遞增**排列，與 `timestamp` 順序無關 |
| **稀疏** | cursor 序列**有斷點，不連續**。不要假設相鄰、也**不要用兩個 cursor 相減當待處理筆數**——實測 1644 筆訊息的序列已燒到 18744。只能問「有沒有更多」（`has_more`），不能問「還剩幾筆」 |
| **Dedup** | 被 `INSERT OR IGNORE` 擋掉的重複訊息不會推進 cursor（NEVER #7） |

**目前涵蓋範圍**：只有 `message` 事件會進 SQLite（見 `syncEventToSQLite`），所以只有這類被編號。將來持久化其他事件類型時，它們會加入**同一條**序列。

**與 subscription 搭配使用**（見下方 Resource Subscription）：

```
subscribe chat://chats  →  收到 notifications/resources/updated
                        →  read_events({ since: 上次的 next_cursor })
                        →  存下新的 next_cursor
```

subscription 只說「有變動」，read_events 說「變動是什麼」。兩者合起來才是完整的 push 管線。

### `search_messages`

全文搜尋訊息。使用 FTS5 + highlight snippet。

**Input Schema**：
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

**Output 範例**：
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

**FTS5 查詢邏輯**（依 Phase 2.1 結果）：
- query 長度 ≥ 3 字元 → FTS5 trigram 查詢
- query 長度 < 3 字元 → fallback LIKE 查詢（Phase 2.1 確定：trigram FTS5 + LIKE fallback for <3 char queries）

### `send_message`

發送訊息。經過 SafetyRail 檢查後轉發給對應 adapter。

**Input Schema**：
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

**Output 範例**（成功）：
```json
{
  "success": true,
  "message_id": "line:m9876543210",
  "timestamp": 1690000001000
}
```

**Output 範例**（SafetyRail 攔截）：
```json
{
  "success": false,
  "error": "rate_limited",
  "detail": "Send rate limit exceeded (5/min). Next allowed in 12s."
}
```

**Output 範例**（adapter 不可用）：
```json
{
  "success": false,
  "error": "adapter_unavailable",
  "detail": "LINE adapter is not connected"
}
```

### `get_status`

取得系統狀態：adapter 連線狀態 + storage 統計。

**Input Schema**：
```json
{
  "type": "object",
  "properties": {}
}
```

**Output 範例**：
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

`storage.cursor` 是當前 head cursor——consumer 可以直接拿去餵 `read_events({ since })` 開始跟。

## Resources

### `chat://chats`

所有聊天列表（含最近訊息摘要）。

**URI**：`chat://chats`

**回傳格式**：同 `list_chats` tool 的 output（不帶分頁，回傳所有聊天）。

### `chat://chats/{id}/messages`

特定聊天的最近訊息。

**URI**：`chat://chats/line:c1234567890abcdef/messages?limit=20`

**回傳格式**：同 `read_messages` tool 的 output（最近 N 筆，預設 20）。

### `chat://chats/{id}/info`

特定聊天的詳細資訊。

**URI**：`chat://chats/line:c1234567890abcdef/info`

**回傳格式**：
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

系統狀態摘要。

**URI**：`chat://status`

**回傳格式**：同 `get_status` tool 的 output。

## Resource Subscription

### 機制

MCP resource subscription 採 **notify-then-fetch** 模式：

1. Client（Claude Code）subscribe 特定 resource URI
2. 有新訊息寫入 Storage 時，core MCP server 發送 `notifications/resources/updated` notification
3. Client 收到 notification 後自行 fetch resource 取得最新資料

### 觸發流程

```
Adapter event notification → Core Storage 寫入
  → 判斷 affected resources:
    - 新訊息 → chat://chats (last_message 更新)
                + chat://chats/{affected_chat_id}/messages
    - 新聯絡人 → chat://chats/{affected_chat_id}/info
    - 狀態變更 → chat://status
  → 對每個 affected resource 發送 notifications/resources/updated
  → Subscribed clients fetch 最新資料
```

### Dual-Track 策略

Resource subscription 是較新的 MCP feature，可能不是所有 client 都支援。chatmux 同時支援：

1. **Subscription**（主要）：支援 subscription 的 client 會收到即時通知
2. **Tool polling**（fallback）：client 可定期呼叫 `list_chats` 或 `read_messages` 取得最新資料

兩種方式回傳格式完全一致，client 可依自身能力選擇。
