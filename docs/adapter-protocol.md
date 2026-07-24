# Adapter Protocol

> **Protocol Version**: 0.2
> **Validated against**: LINE (v0.1), Telegram (v0.2)
> **Changelog**: see bottom of document

chatmux adapter 是 child process，透過 stdin/stdout 的 newline-delimited JSON-RPC 與 core daemon 通訊。Adapter 可以用任何語言實作，可以在 chatmux monorepo 內或獨立 repo。

## 傳輸層

- **編碼**：UTF-8 JSON，每行一個完整 JSON object（newline `\n` 分隔）
- **管道**：stdin（core → adapter）、stdout（adapter → core）
- **stderr**：adapter 自由使用，core 轉錄到 daemon log

> **非 Node.js adapter 注意**：Python、Go、Rust 等語言的 stdout 在 pipe 模式下預設**區塊緩衝**（不是行緩衝）。Adapter 必須確保每寫完一行 JSON 就 flush。Python 範例：`sys.stdout.reconfigure(line_buffering=True)`（模組頂層）。不解決此問題會導致 JSON-RPC response 卡在緩衝區、core readline 永遠收不到。

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

## Adapter 配置

Adapter 的啟動命令、工作目錄、環境變數由 `$CHATMUX_DATA_DIR/adapters.json` 配置：

```json
{
  "adapters": [
    {
      "platform": "line",
      "command": "node",
      "args": ["--import", "tsx", "src/adapters/line/index.ts"],
      "cwd": "/path/to/chatmux",
      "enabled": true
    },
    {
      "platform": "telegram",
      "command": "/path/to/venv/bin/python",
      "args": ["/path/to/chatmux-adapter-telegram/main.py"],
      "env": {
        "TELEGRAM_API_ID": "12345678",
        "TELEGRAM_API_HASH": "abcdef..."
      },
      "enabled": true
    }
  ]
}
```

| 欄位 | 必填 | 說明 |
|------|------|------|
| `platform` | 是 | 平台識別符，與 `initialize` response 的 platform 一致 |
| `command` | 是 | 可執行檔路徑（外部 adapter 建議用**絕對路徑**，如 venv 的 python） |
| `args` | 是 | 命令參數陣列 |
| `cwd` | 否 | 工作目錄，預設為 adapter 檔案所在目錄 |
| `env` | 否 | Per-adapter 環境變數，merge 進 subprocess env。用於 API key 等機密，避免全域 env 撞名 |
| `enabled` | 是 | 是否啟用 |

Config 不存在時 → core 退回內建預設（向後相容 v0.1）。

## Core → Adapter Requests

### `initialize`

首次 spawn 後 core 送出，adapter 回報 capabilities。

**Request params**：
```json
{
  "data_dir": "/home/user/.local/share/chatmux",
  "platform": "line"
}
```

`data_dir` 是 chatmux 的頂層資料目錄。Adapter 應在 `{data_dir}/adapters/{platform}/` 下建立自己的子目錄，存放 session 檔、cache 等平台特有資料。例如 Telegram adapter 把 session 檔存在 `{data_dir}/adapters/telegram/chatmux.session`。

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

取得平台定義的聯絡人。不同平台的聯絡人範圍差異很大——LINE 有明確的好友列表，Telegram 只回傳手機通訊錄中的聯絡人（可能為空）。Core 用聯絡人做 display_name 查詢，但不依賴聯絡人列表的完整性——backfill/live event 中的 sender 資訊由 adapter 自行解析（如 Telegram 用 `msg.get_sender()` 查 entity cache）。

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

`raw` 是選填，保留平台原始資料供 debug。

### `get_chats`

取得聊天列表（群組 + DM）。

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

`raw` 是選填。DM 的 `name` 取自 contacts map 或 adapter 自行解析。未知 DM 的 name 為 null。

### `get_message_boxes`（optional）

> **v0.2 起為 optional**。若 adapter 不支援，回 JSON-RPC error `-32601` (Method not found)，core 跳過此步驟，直接用 `get_chats` 結果做 backfill 排序。

取得所有有訊息的對話清單，用於冷啟動 backfill 發現。此方法源自 LINE 的 messageBoxes API，其他平台的 dialogs/conversations API 通常已由 `get_chats` 涵蓋。

**Request params**：`{}`

**Response result**（raw array，非 object 包裝）：
```json
[
  {
    "id": "c1234567890abcdef",
    "lastDeliveredTime": 1690000000000
  }
]
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

`chat_id` 是 raw `platform_id`（不帶 `platform:` 前綴）。Core 負責路由（從 composite ID 提取 platform 和 platform_id），adapter 收到的永遠是 bare platform_id。

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

`chat_id` 是 raw `platform_id`（不帶前綴），同 `send_message`。

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

`raw` 是選填——保留平台原始資料供 debug，core 不解析但會存到 JSONL。若平台原始物件無法直接 JSON 序列化（如 Telethon 的 Message 含 circular reference），可省略或萃取可序列化子集。

#### Event Type Enum

| type | 說明 | content 結構 |
|------|------|-------------|
| `message` | 新訊息 | `{ type: "text"\|"image"\|"video"\|"audio"\|"sticker"\|"file", text?, media_url?, sticker_id?, file_name? }` |
| `read_receipt` | 已讀（v0.2 defer：語義因平台而異，adapter 視能力決定是否支援） | `{ chat_id, read_up_to: timestamp }` |
| `unsend` | 撤回訊息 | `{ message_id }` |

**`unsend` 注意事項**：
- `timestamp` 可為 0 或 null——部分平台（如 Telegram）的刪除事件不提供撤回時間，core 應容忍。
- 若平台一次刪除多則訊息（如 Telegram 的 `MessageDeleted` 帶多個 ID），adapter 應對每個被刪訊息各發一個 unsend notification。
- 部分平台（如 Telegram 私聊）的刪除事件不帶 `chat_id`，adapter 應跳過這些事件並在 stderr log 警告。

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
  ├─ Core sends: get_message_boxes {} (optional, skip on -32601)
  │   └─ Adapter responds: [ { id, lastDeliveredTime } ] or error -32601
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

## Auth 策略

不同平台的首次認證方式差異很大：

| 策略 | 說明 | 範例 |
|------|------|------|
| **stdin 互動** | Adapter 在 daemon spawn 模式下透過 stdin 與使用者互動（QR 碼、authToken） | LINE adapter |
| **獨立登入流程** | 首次 auth 需要獨立執行（如 `python main.py --auth`），產出 session/token 檔。後續 daemon spawn 用 session 檔自動重連 | Telegram adapter（`--auth` 模式） |
| **API token** | 透過 `adapters.json` 的 `env` 欄位注入 API token，不需互動登入 | Bot-based adapter |

Adapter 應在 README 中記載其 auth 流程。若採用「獨立登入流程」策略，`--auth` 模式下的 `data_dir` 應讀 `CHATMUX_DATA_DIR` 環境變數（或預設 `~/.local/share/chatmux`），確保與 daemon spawn 路徑用同一個 session 檔位置。

## 如何寫一個新 Adapter

### 最小實作

一個合法的 adapter 是任意語言的獨立程式，只需要：

1. **讀 stdin、寫 stdout**：newline-delimited JSON-RPC（注意非 Node.js 語言的 stdout 緩衝問題——見§傳輸層）
2. **處理 `initialize` request**：回報 capabilities
3. **處理 `shutdown` request**：優雅退出
4. **發送 `event` notification**：把平台事件轉成統一格式

### 步驟

1. 建立獨立 repo 或 monorepo 子目錄，任意語言的入口程式
2. 實作 stdin JSON-RPC reader + stdout writer（確保 stdout 行緩衝）
3. 實作 `initialize` handler，回報：
   - `supported_events`：支援的 event type subset
   - `can_send`：是否支援發送
   - `can_backfill`：是否支援歷史拉取
   - `platform_rate_limits`（選填）：平台特有的 rate limit
4. 連接平台，收到事件後發 `event` notification
5. 若 `can_send: true`，實作 `send_message` handler
6. 若 `can_backfill: true`，實作 `backfill` handler
7. 在 `$CHATMUX_DATA_DIR/adapters.json` 中註冊 adapter 的啟動命令和環境變數

### 注意事項

- Adapter 可以是 monorepo 內的 TypeScript/Node、獨立 repo 的 Python、或任何語言——只要能讀寫 stdin/stdout JSON-RPC
- Adapter **不可以**直接讀寫 Storage（JSONL/SQLite）——只能透過 stdio 跟 core 通訊
- Adapter **不可以**放寬 rate limit——只能回報更嚴的限制
- `raw` 欄位選填，放平台原始資料供 debug。無法 JSON 序列化時可省略
- Core → adapter 的 `chat_id` 一律是 raw `platform_id`（不帶 `platform:` 前綴），adapter 不需要自行剝除前綴
- Adapter 應在 `{data_dir}/adapters/{platform}/` 下建子目錄存放 session 檔等平台資料
- Adapter crash 由 core 的 Adapter Runner 自動重啟（有 backoff），不需要自己處理
- 外部 adapter 的環境變數（API key 等）透過 `adapters.json` 的 `env` 欄位注入

---

## Changelog

### v0.2（Telegram adapter 驗證後泛化）

| 改動 | Gap ID | 說明 |
|------|--------|------|
| 新增 §Adapter 配置 | G-new-3 | 記載 adapters.json 格式與 env 欄位 |
| §傳輸層加 stdout 緩衝提醒 | G-new-2 | 非 Node.js adapter 必讀 |
| §initialize 修正 data_dir 說明 | G7 | 記載子目錄慣例 `{data_dir}/adapters/{platform}/` |
| §get_contacts 措辭修正 | G-new-5 | 「所有可見聯絡人」→「平台定義的聯絡人」，承認跨平台差異 |
| §get_message_boxes 改為 optional | G1, G-new-11 | 非 LINE 平台的 dialogs API 通常已由 get_chats 涵蓋；response 格式改為實際的 raw array |
| §send_message chat_id 說明 | G-new-12, G-new-6 | 明確 chat_id 是 raw platform_id（無前綴）；core 負責路由和剝除前綴 |
| §backfill chat_id 說明 | G-new-12 | 同上 |
| `raw` 欄位標為選填 | G-new-9 | 無法 JSON 序列化時可省略 |
| §Event unsend 注意事項 | G-new-10, G5, G8 | timestamp 可為 0；多 ID 拆成多 notification；缺 chat_id 跳過 |
| 新增 §Auth 策略 | G-new-1 | 記載 stdin 互動 / 獨立登入 / API token 三種模式 |
| §如何寫一個新 Adapter 重寫 | G6 | 移除 monorepo 假設，改為「任意語言的獨立程式」 |
| read_receipt 加 defer 標記 | G3 | 語義因平台而異，v0.2 暫不強制 |
