# Architecture

chatmux 是三層拓撲：**Adapter**（連接 IM 平台）→ **Core Daemon**（資料層中心）→ **Consumer**（AI 工具）。

## 三層拓撲

```
┌─────────────┐                          ┌──────────────────────────────────┐      MCP Streamable HTTP      ┌──────────────┐
│ LINE Adapter │      stdio JSON-RPC      │         Core Daemon              │ ◄────────────────────────── │ Claude Code  │
│ (Node+tsx)   │ ◄──────────────────────► │                                  │  127.0.0.1 TCP / unix sock  │ (MCP client)  │
└─────────────┘   child process          │  ┌──────────┐  ┌─────────────┐  │   ~/.local/share/chatmux/   │              │
                   stdin/stdout           │  │ Storage   │  │ SafetyRail  │  │   chatmux.sock              └──────────────┘
┌──────────────┐                         │  │ JSONL+SQL │  │ Rate+Error  │  │
│ Telegram     │      stdio JSON-RPC      │  └──────────┘  │ +KillSwitch │  │
│ Adapter      │ ◄──────────────────────► │                 └─────────────┘  │
│ (Python)     │   child process          │  ┌──────────────┐               │
└──────────────┘   stdin/stdout           │  │AdapterManager │               │
                                          │  │ config+routing│               │
┌──────────────┐                         │  └──────────────┘               │
│ Future       │      stdio JSON-RPC      │  ┌──────────────┐               │
│ Adapter      │ ◄ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─► │  │ MCP Server    │               │
│ (any lang)   │   child process          │  │ tools+resources│              │
└──────────────┘                          │  └──────────────┘               │
                                          └──────────────────────────────────┘
```

## Process Model

| 元件 | Runtime | Process | 理由 |
|------|---------|---------|------|
| Core Daemon | Bun | 主程序 | bun:sqlite 原生綁定、快速啟動、MCP Streamable HTTP 零 config |
| LINE Adapter | Node + tsx | 子程序（child process） | LEGY Push 需 HTTP/2 duplex，Bun 不支援 |
| Telegram Adapter | Python (Telethon) | 子程序（child process） | MTProto user session，獨立 repo |
| MCP Server | Bun | 與 Core 同程序 | 直接存取 Storage，無 IPC 開銷 |
| Future adapters | 任意 runtime | 子程序 | stdio JSON-RPC 是語言無關協議 |

**為什麼 adapter 是 child process**：
1. **安全邊界**：adapter 只能透過 stdio 跟 core 通訊，所有 send_message 強制經過 SafetyRail，無法繞過
2. **穩定性隔離**：adapter crash 不影響 core daemon 和其他 adapter
3. **語言無關**：stdio JSON-RPC 允許任意語言實作 adapter（v0.2+ 可用 Python/Go 寫新 adapter）
4. **效能驗證**：E1 spike 確認 p99 round-trip = 1.075ms，~1000 msg/day 使用量級毫無壓力

## 通訊協議

### Adapter ↔ Core：stdio JSON-RPC

雙向通訊，newline-delimited JSON over stdin/stdout：

| 方向 | 類型 | 語義 | 範例 |
|------|------|------|------|
| Core → Adapter | Request | 預期 response（有 id） | `initialize`, `get_contacts`, `get_chats`, `send_message`, `backfill`, `shutdown` |
| Adapter → Core | Notification | fire-and-forget（無 id） | `event`（訊息/已讀/狀態更新）, `status`（連線狀態）, `error`（錯誤回報） |

完整規格見 `adapter-protocol.md`。

### Core ↔ Consumer：MCP Streamable HTTP

HTTP/1.1 + SSE，**同時開兩個 listener、共用同一組 handler 與 session map**：

- **TCP** `127.0.0.1:<port>`（`CHATMUX_MCP_PORT` / `adapters.json` 的 `mcp.port`，預設 `7717`；`0` 停用）
  ——給標準 MCP client（Claude Code）。MCP spec 只定義 stdio 與 streamable HTTP，**沒有 unix socket transport**。
- **Unix socket** `$CHATMUX_SOCKET`（預設 `~/.local/share/chatmux/chatmux.sock`）
  ——給同機 sidecar / plugin consumer（chat.nvim）。


| 方向 | 類型 | 語義 |
|------|------|------|
| Consumer → Core | Tool call | `list_chats`, `read_messages`, `search_messages`, `send_message`, `get_status` |
| Core → Consumer | Resource notification | `notifications/resources/updated`（新訊息到達時推送） |

完整規格見 `mcp-interface.md`。

## 資料流

### 接收路徑（Adapter → Consumer）

```
LINE 推送訊息
  → LINE Adapter 收到 + E2EE 解密
  → stdio notification: { method: "event", params: { type: "message", ... } }
  → Core Adapter Runner 收到 event
  → Storage: append JSONL (truth source)
  → Storage: INSERT OR IGNORE SQLite (query view, dedup by UNIQUE constraint)
  → FTS5 trigger: 同步更新全文索引
  → MCP Server: notifications/resources/updated → Consumer fetch 最新資料
```

### 發送路徑（Consumer → Adapter）

```
Claude Code 呼叫 send_message tool
  → MCP Server 收到 tool call
  → SafetyRail 檢查: RateLimiter(5/min) → ErrorTracker → KillSwitch
  → 通過 → Adapter Runner 轉發 send_message request 到 LINE Adapter
  → LINE Adapter 呼叫 linejs sendMessage
  → 回傳 success/error → MCP tool response → Claude Code
```

```
SafetyRail 攔截:
  → RateLimiter 超限 → 拒絕，回傳 rate_limited error
  → ErrorTracker 連續失敗 → 退避（5→10→20s）
  → KillSwitch 觸發（3 次） → 斷開 adapter 連線，需手動 reset
```

### 冷啟動流程

```
Daemon 啟動
  → Storage 初始化（建表、JSONL sync check）
  → SafetyRail 初始化
  → AdapterManager 讀 adapters.json → 對每個 enabled adapter spawn 子程序
  → 各 adapter initialize → 回報 capabilities + platform_rate_limits
  → Core 等待各 adapter status "connected" 通知（120s timeout）
  → 對每個 connected adapter:
    → get_contacts → contacts 寫入 Storage
    → get_chats → chats 寫入 Storage
    → get_message_boxes (optional, skip on -32601) → 補充 chats 的 lastDeliveredTime
    → backfill: 按 last_message_time 降序逐 chat 取 50 筆/輪
      → 全域計數器達 500 即停（不等遍歷完所有 chat）
      → 若首輪未達 500 且仍有 chat 未見底則再輪
  → MCP Server 啟動
  → 開始監聽 live push events
```

## 元件責任邊界

| 元件 | 負責 | 不負責 |
|------|------|--------|
| **Adapter** | 平台連接（auth/push/reconnect）、E2EE 解密、event 格式轉換、回報 platform rate limits | 儲存、搜尋、rate limit 決策、MCP 服務 |
| **Adapter Runner** | spawn/watch/restart adapter、stdio JSON-RPC 路由、process crash ErrorTracker（kill at 5） | 平台特有邏輯、儲存 |
| **Storage** | JSONL 寫入、SQLite sync、FTS5 索引、dedup、query API | 通訊協議、rate limit |
| **SafetyRail** | send rate limit、send failure ErrorTracker（kill at 3）、KillSwitch | 儲存、adapter 生命週期 |
| **MCP Server** | tool dispatch、resource serving、subscription notification | 平台連接、直接 SQLite 操作（透過 Storage query API） |

## 資料目錄結構

```
~/.local/share/chatmux/           # $CHATMUX_DATA_DIR
├── adapters.json                  # Adapter 配置（見 adapter-protocol.md）
├── chatmux.sock                   # MCP unix socket (TCP listener has no file)
├── events.jsonl                   # JSONL truth source (append-only)
├── chatmux.db                     # SQLite query view
├── media/                         # 下載的圖片/影片/音訊
│   └── line/                      # 按平台分目錄
└── adapters/                      # 各 adapter 的平台資料
    ├── line/
    │   ├── auth.json              # authToken（首次 QR 登入後持久化）
    │   └── storage.json           # E2EE key storage
    └── telegram/
        └── chatmux.session        # Telethon SQLite session
```
