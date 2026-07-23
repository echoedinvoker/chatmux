# LINE Adapter

LINE adapter 是 chatmux v0.1 唯一的 adapter，連接 LINE IOSIPAD slot 接收推送訊息。

## linejs（`@evex/linejs`）

非官方 LINE client library，提供：
- QR 碼登入 + authToken 登入
- LEGY Push（HTTP/2 長連線接收推送）
- E2EE 訊息加解密
- 訊息發送（`sendCompactMessage`）
- 歷史訊息拉取（`getPreviousMessages`）
- 聯絡人/群組/聊天室查詢

**安裝**：透過 JSR registry — `npm:@jsr/evex__linejs`，需 `.npmrc` 設定 `@jsr:registry=https://npm.jsr.io`。

**帳號風險**：linejs 使用非官方 API，LINE 可能限制或封鎖帳號。README 必須揭露此風險。

## IOSIPAD Device Slot

LINE 允許多裝置同時登入，iPad 是其中一個 device slot。chatmux 佔用 IOSIPAD slot：

- **不影響手機 LINE**：手機用的是 PRIMARY slot
- **不能同時跑兩個 IOSIPAD client**：chatmux 和 line-tui 共用同一 slot，不能同時運行
- **登入參數**：`{ device: "IOSIPAD" as const, storage }`

## LEGY Push（HTTP/2 長連線）

LINE 使用 LEGY Push 協議推送即時訊息，是一個 HTTP/2 長連線。

### 為什麼 adapter 必須用 Node+tsx

LEGY Push 需要 HTTP/2 duplex（雙向同時讀寫同一個 HTTP/2 stream）。**Bun 的 HTTP/2 duplex 實作有 bug**——連線建立後無法同時讀寫。因此 LINE adapter 必須用 Node+tsx runtime。

Core daemon 用 Bun 沒問題——MCP Streamable HTTP 走 HTTP/1.1 + SSE，不需要 HTTP/2。

### 連線管理（ConnectionManager）

從 line-tui `src/connection.ts` 遷移。兩個並行迴圈：

1. **pushLoop**：呼叫 `initLegyPusher()` 建立 HTTP/2 長連線
   - 成功 → state = `"connected"`
   - 網路錯誤 → state = `"reconnecting"` → sleep 5s → 重試（不計入 ErrorTracker）
   - 其他錯誤 → emit error → 由外部 ErrorTracker 處理

2. **consumeLoop**：從 `push.stream` ReadableStream 讀取事件
   - 讀到事件 → dispatch to event listeners
   - stream 結束（done=true）→ `push.renew()` → sleep 1s → 重新讀取（自動重連）
   - stream error → catch → renew → retry

### 連線狀態

| state | 說明 |
|-------|------|
| `"connected"` | LEGY Push 連線正常 |
| `"reconnecting"` | 連線斷開，正在重連 |
| `"killed"` | 被 KillSwitch 殺掉，不再重連 |

### 重連策略

- **網路斷線**（`isNetworkError`）：5 秒後自動重連，不計入 ErrorTracker
- **stream 結束**：1 秒後 renew stream，自動重連
- **非網路錯誤**：emit error → adapter runner 的 ErrorTracker 決定 retry/kill
- **graceful stop**：AbortController abort → 兩個迴圈同時結束

網路錯誤判斷（`isNetworkError`）：
- Error code：`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENETUNREACH`, `EPIPE`
- Error message：含 `"fetch failed"`, `"network"`, `"socket hang up"`, `"econnrefused"`

## E2EE（端對端加密）

LINE 訊息端對端加密。linejs 的 `decryptMessage()` 處理解密：

```typescript
const decrypted = await client.decryptMessage(rawMessage);
```

- **E2EE key 儲存**：`$CHATMUX_DATA_DIR/adapters/line/storage.json`（linejs `FileStorage`）
- chatmux 儲存**明文**（解密後的文字）——FTS5 全文搜尋需要明文。DB 檔案權限 600 是 v0.1 安全基線
- 解密失敗的訊息標記為 `"[無法解密]"`，不丟棄（保留 metadata）

## QR 碼登入 + authToken 持久化

### 首次登入流程

1. 沒有 authToken → 啟動 QR 碼登入
2. 在 terminal 顯示 QR 碼（`qrcode-terminal` library）
3. 用手機 LINE 掃碼 → 可能要求輸入 PIN
4. QR 碼 30 秒過期，過期自動生成新的（最多 5 次重試）
5. 登入成功 → 儲存 authToken 到 `$CHATMUX_DATA_DIR/adapters/line/auth.json`

### 後續登入

1. 讀取 authToken → `loginWithAuthToken(savedToken, opts)`
2. 成功 → 直接使用
3. 失敗（token 過期）→ fallback 到 QR 碼登入

### Token 更新

linejs 自動更新 token，監聽 `update:authtoken` event：

```typescript
client.base.on("update:authtoken", async (token) => {
  await saveAuthToken(token);
});
```

### 路徑遷移

| 項目 | line-tui | chatmux |
|------|---------|---------|
| authToken | `data/auth.json` | `$CHATMUX_DATA_DIR/adapters/line/auth.json` |
| E2EE storage | `data/storage.json` | `$CHATMUX_DATA_DIR/adapters/line/storage.json` |

## LINE OBS Media 下載

LINE 圖片/影片/音訊的 URL（OBS URL）需要 auth header 才能存取，且 URL 會過期。

### 處理策略

收到 media 類型訊息時立即下載到本機：

```
收到 image/video/audio/file 訊息
  → 立即下載到 $CHATMUX_DATA_DIR/media/line/<message_id>.<ext>
  → SQLite attachments 表記錄 original_url + local_path
  → MCP tools 回傳 local_path（不回傳過期的 original_url）
```

## Content Type 對應表

LINE 訊息有多種 content type，adapter 需轉換成統一格式：

| LINE contentType | chatmux content.type | 說明 |
|-----------------|---------------------|------|
| 0 / `"NONE"` | `"text"` | 純文字 |
| 1 / `"IMAGE"` | `"image"` | 圖片 |
| 2 / `"VIDEO"` | `"video"` | 影片 |
| 3 / `"AUDIO"` | `"audio"` | 語音 |
| 7 / `"STICKER"` | `"sticker"` | 貼圖（`sticker_id` = contentMetadata.STKID） |
| 14 / `"FILE"` | `"file"` | 檔案 |
| 其他 | `"text"` | 格式化為 `"[類型名]"`（如 `"[通話]"`, `"[位置]"`） |

## 已知限制

1. **Bun HTTP/2 不支援** → adapter 必須 Node+tsx runtime
2. **首次 QR 碼** → 非無人值守，需人工掃碼
3. **E2EE key 依賴 linejs** → 換 client library 需要重新登入
4. **LINE 可能封鎖** → 非官方 API，無保證
5. **同 IOSIPAD slot 只能一個 client** → chatmux 和 line-tui 不能同時跑

## linejs API 已知坑

- `client.base.profile!.mid`（not `client.user.mid`）to get own user ID
- `getUserFriendIds` 需 `{ request: { blockStatus: "ALL" } }`，回傳 `res.userFriendMids`
- `getAllChatMids` 需 `{ request: { withMemberChats: true }, syncReason: "INTERNAL" }`
- `getContactsV3` 需 `{ mids }`，回傳 `res.responses[].targetUserMid` + `targetProfileDetail.profileName`
- `getChats` 需 `{ chatMids }`，回傳 `res.chats[].chatMid` + `.chatName`
- `getPreviousMessages` 不存在——改用 `getPreviousMessagesV2WithRequest({ request: { messageBoxId, endMessageId, messagesCount }, syncReason: "UNKNOWN" })`
- `getMessageBoxes({ messageBoxListRequest: {} })` 取得所有有訊息的對話（含 1:1 + 群組）
- `auth.ts` 的 `login()` 需先 `mkdir(dataDir)` 確保目錄存在，否則 `FileStorage` 讀取 storage.json 會 ENOENT
