# Adapter Protocol

> **Validated against**: LINE only. 跨平台通用性未證，待 adapter #2（v0.2）。

chatmux adapter 是 child process，透過 stdin/stdout 的 newline-delimited JSON-RPC 與 core daemon 通訊。

## 傳輸層

- **編碼**：UTF-8 JSON，每行一個完整 JSON object（newline `\n` 分隔）
- **管道**：stdin（core → adapter）、stdout（adapter → core）
- **stderr**：adapter 自由使用，core 轉錄到 daemon log

## 訊息格式

### Request（Core → Adapter，預期 response）

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": { ... }
}
```

### Response（Adapter → Core，回覆 request）

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { ... }
}
```

### Error Response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": -32000, "message": "auth failed" }
}
```

### Notification（Adapter → Core，fire-and-forget）

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": { ... }
}
```

Notification 沒有 `id` 欄位，core 不回覆。

## Core → Adapter Requests

### `initialize`

首次 spawn 後 core 送出，adapter 回報 capabilities。

**Request params**：
```json
{
  "data_dir": "/home/user/.local/share/chatmux/adapters/line",
  "platform": "line"
}
```

**Response result**：
```json
{
  "platform": "line",
  "supported_events": ["message", "read_receipt", "unsend"],
  "can_send": true,
  "can_backfill": true,
  "platform_rate_limits": {
    "send": { "max": 5, "window_seconds": 60 }
  }
}
```

`platform_rate_limits` 是選填。回報後 core SafetyRail 取嚴者（core 預設 vs adapter 回報）。**Adapter 只能更嚴，不能放寬**——core 底線是安全網。

### `get_contacts`

取得平台所有可見聯絡人（好友 + 群組成員 + DM 對象）。

**Request params**：`{}`

**Response result**：
```json
{
  "contacts": [
    {
      "platform_id": "u1234567890abcdef",
      "display_name": "Alice",
      "avatar_url": "https://...",
      "raw": { ... }
    }
  ]
}
```

### `get_chats`

取得聊天列表（群組 + DM）。LINE adapter 從 `getAllChatMids` 取群組，從 `getMessageBoxes` 補 DM（u-prefix）。

**Request params**：`{}`

**Response result**：
```json
{
  "chats": [
    {
      "platform_id": "c1234567890abcdef",
      "type": "group",
      "name": "工作群組",
      "raw": { ... }
    },
    {
      "platform_id": "u1234567890abcdef",
      "type": "direct",
      "name": "Alice"
    }
  ]
}
```

`type`：`"direct"` | `"group"` | `"room"`

DM 的 `name` 取自 contacts map（由先前 `get_contacts` 結果建立）。未知 DM 的 name 為 null。

### `get_message_boxes`

取得所有有訊息的對話（含 1:1 + 群組），用於冷啟動 backfill 發現。

**Request params**：`{}`

**Response result**：
```json
{
  "chats": [
    {
      "platform_id": "c1234567890abcdef",
      "type": "group",
      "name": "工作群組",
      "members": ["u1234", "u5678"],
      "raw": { ... }
    }
  ]
}
```

### `send_message`

透過平台發送訊息。Core 在轉發前已通過 SafetyRail 檢查。

**Request params**：
```json
{
  "chat_id": "c1234567890abcdef",
  "content": {
    "type": "text",
    "text": "Hello!"
  }
}
```

**Response result**（成功）：
```json
{
  "message_id": "m9876543210",
  "timestamp": 1690000000000
}
```

**Error**（失敗）：
```json
{
  "code": -32001,
  "message": "recipient not found"
}
```

### `backfill`

取回歷史訊息。Core 指定 chat、時間點、數量，adapter 負責分頁取回。

**Request params**：
```json
{
  "chat_id": "c1234567890abcdef",
  "before_timestamp": 1690000000000,
  "count": 50
}
```

**Response result**：
```json
{
  "events": [ ... ],
  "has_more": true,
  "oldest_timestamp": 1689900000000
}
```

`events` 內容格式同 `event` notification 的 params。`has_more` 為 false 表示該 chat 已見底。

**冷啟動流程**（core 側邏輯）：
1. 取 chats 列表，按 last_message_time 降序排列
2. 逐 chat 呼叫 backfill，每輪 count=50
3. 全域計數器累加，達 500 即停（不等遍歷完所有 chat）
4. 若首輪未達 500 且仍有 chat 未見底則再輪，直到全域 ≥ 500 或所有 chat 見底

**Backfill × live event 交錯**：backfill 和 live push event 可能產生相同 message_id 的 event。Core 的 Storage 以 INSERT OR IGNORE（UNIQUE constraint on platform + platform_message_id）處理 dedup。Adapter 不需要處理——dedup 是 core 的責任。

### `shutdown`

優雅關閉。Adapter 收到後應斷開平台連線、清理資源、exit 0。

**Request params**：`{}`

**Response result**：`{}`

Core 送出 shutdown 後等最多 5 秒。超時則 SIGTERM → 再等 3 秒 → SIGKILL。

## Adapter → Core Notifications

### `event`

平台事件。最核心的 notification——新訊息、已讀、撤回都走這裡。

**Params**：
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
  "raw": { ... }
}
```

#### Event Type Enum

| type | 說明 | content 結構 |
|------|------|-------------|
| `message` | 新訊息 | `{ type: "text"\|"image"\|"video"\|"audio"\|"sticker"\|"file", text?, media_url?, sticker_id?, file_name? }` |
| `read_receipt` | 已讀 | `{ chat_id, read_up_to: timestamp }` |
| `unsend` | 撤回訊息 | `{ message_id }` |

`raw` 欄位保留平台原始資料（debug 用），不索引到 FTS。

### `status`

Adapter 連線狀態變更。

**Params**：
```json
{
  "state": "connected",
  "detail": "LEGY Push connected"
}
```

`state`：`"connecting"` | `"connected"` | `"reconnecting"` | `"disconnected"` | `"auth_required"`

### `error`

Adapter 內部錯誤。

**Params**：
```json
{
  "severity": "warning",
  "message": "LEGY Push connection lost, reconnecting...",
  "code": "PUSH_DISCONNECTED"
}
```

`severity`：`"info"` | `"warning"` | `"error"` | `"fatal"`

`"fatal"` 表示 adapter 即將 exit。

## Adapter 生命週期

```
Core spawn adapter process
  │
  ├─ Core sends: initialize { data_dir, platform }
  │   └─ Adapter responds: { capabilities, platform_rate_limits }
  │
  ├─ Core waits for adapter status: "connected" notification
  │   └─ Timeout: 120s
  │
  ├─ Core sends: get_contacts {}
  │   └─ Adapter responds: { contacts: [...] }
  │
  ├─ Core sends: get_chats {}
  │   └─ Adapter responds: { chats: [...] }
  │
  ├─ Core sends: backfill { chat_id, before_timestamp, count }  (repeated per chat)
  │   └─ Adapter responds: { events, has_more, oldest_timestamp }
  │
  ├─ [Normal operation]
  │   ├─ Adapter sends: event notifications (continuous)
  │   ├─ Core sends: send_message requests (on demand)
  │   └─ Adapter sends: status notifications (on state change)
  │
  ├─ [Shutdown]
  │   ├─ Core sends: shutdown {}
  │   └─ Adapter responds: {} → exit 0
  │
  └─ [Crash recovery]
      ├─ Adapter exits non-zero
      ├─ Adapter Runner ErrorTracker: backoff 5→10→20s
      ├─ Restart with backoff
      └─ KillSwitch at 5 consecutive crashes → stop restart attempts
```

## 如何寫一個新 Adapter

> 本指南適用於 v0.2+ 新增平台。v0.1 只有 LINE adapter。

### 最小實作

一個合法的 adapter 只需要：

1. **讀 stdin、寫 stdout**：newline-delimited JSON-RPC
2. **處理 `initialize` request**：回報 capabilities
3. **處理 `shutdown` request**：優雅退出
4. **發送 `event` notification**：把平台事件轉成統一格式

### 步驟

1. 建立 `src/adapters/<platform>/index.ts`（或任意語言的入口）
2. 實作 stdin JSON-RPC reader + stdout writer
3. 實作 `initialize` handler，回報：
   - `supported_events`：支援的 event type subset
   - `can_send`：是否支援發送
   - `can_backfill`：是否支援歷史拉取
   - `platform_rate_limits`（選填）：平台特有的 rate limit
4. 連接平台，收到事件後發 `event` notification
5. 若 `can_send: true`，實作 `send_message` handler
6. 若 `can_backfill: true`，實作 `backfill` handler
7. 在 `config/` 或 core 設定中註冊新 adapter 的啟動命令

### 注意事項

- Adapter **不可以**直接讀寫 Storage（JSONL/SQLite）——只能透過 stdio 跟 core 通訊
- Adapter **不可以**放寬 rate limit——只能回報更嚴的限制
- `raw` 欄位放平台原始資料，core 不解析但會存到 JSONL
- Adapter crash 由 core 的 Adapter Runner 自動重啟（有 backoff），不需要自己處理
