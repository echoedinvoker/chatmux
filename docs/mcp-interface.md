# MCP Interface

chatmux 透過 MCP Streamable HTTP（unix socket）暴露 5 個 tools + 4 個 resources + resource subscription。

## 傳輸

- **Protocol**：MCP Streamable HTTP（HTTP/1.1 + SSE）
- **Transport**：unix socket（`$CHATMUX_SOCKET`，預設 `~/.local/share/chatmux/chatmux.sock`）
- **SDK**：`@modelcontextprotocol/sdk`

### Claude Code 設定

```json
{
  "mcpServers": {
    "chatmux": {
      "url": "http://localhost/mcp",
      "transport": {
        "type": "streamable-http",
        "socketPath": "/home/user/.local/share/chatmux/chatmux.sock"
      }
    }
  }
}
```

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
    "jsonl_size_mb": 22.8
  }
}
```

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
