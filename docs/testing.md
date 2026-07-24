# Testing

chatmux 使用 `bun:test` 作為測試框架，遵循 TDD（Test-Driven Development）慣例。

## TDD 慣例

### Core Logic 必須 TDD

以下模組的所有行為必須 test-first：

- `src/core/storage/`（JSONL、SQLite、FTS5、query）
- `src/core/safety.ts`（SafetyRail）
- `src/core/adapter-runner.ts`（JSON-RPC protocol + process management）
- `src/core/mcp/tools.ts`（MCP tools）
- `src/core/mcp/resources.ts`（MCP resources）

### TDD Cycle

1. **Red**：寫 test → 跑 `bun test` → 確認 test 失敗（功能不存在）
2. **Green**：寫最小實作 → 跑 `bun test` → 確認 test 通過
3. **Refactor**（可選）：重構 → 確認 test 仍通過

### 不需要 TDD 的部分

- LINE adapter 的平台 API 互動（mock 成本太高，用整合測試）
- daemon.ts 入口組裝（純 wiring，用整合測試）
- systemd service 設定

## Test 檔案結構

```
tests/
├── core/
│   ├── safety.test.ts           # SafetyRail（from line-tui）
│   ├── adapter-runner.test.ts   # JSON-RPC protocol + spawn/restart
│   ├── storage.test.ts          # JSONL + SQLite + FTS5 + query
│   └── mcp-tools.test.ts        # MCP tools + resources
└── adapters/
    └── line/
        ├── messages.test.ts     # handleEvent + E2EE decrypt（from line-tui）
        ├── contacts.test.ts     # contact fetch + cache（from line-tui）
        ├── adapter-responder.test.ts # adapter 端 JSON-RPC request handler
        └── connection.test.ts   # ConnectionManager（from line-tui）
```

## line-tui Test Suite 遷移

line-tui 有 9 個 test file、187 個 tests。chatmux 遷移其中與 core/adapter 相關的部分。

### 遷移對應表

| line-tui test file | chatmux 目標 | 遷移方式 | 備註 |
|--------------------|--------------|---------|----|
| `safety.test.ts` | `tests/core/safety.test.ts` | 直接複製 + 修 import | SafetyRail 邏輯不變 |
| `connection.test.ts` | `tests/adapters/line/connection.test.ts` | 複製 + 修 import + 調整 event 格式 | ConnectionManager mock 不變 |
| `messages.test.ts` | `tests/adapters/line/messages.test.ts` | 複製 + 修 import + 輸出格式改 adapter protocol | handleEvent 輸出從 DisplayMessage 改為 event notification |
| `contacts.test.ts` | `tests/adapters/line/contacts.test.ts` | 複製 + 修 import | contact fetch 邏輯不變 |
| `mcp-tools.test.ts` | `tests/core/mcp-tools.test.ts` | 重寫 | MCP server 從 stdio 改 Streamable HTTP、tools 改查 SQLite |

### 不遷移的 test files

| line-tui test file | 原因 |
|--------------------|----|
| `capture.test.ts` | TUI 截圖功能，chatmux 無 UI |
| `input-box.test.ts` | TUI 輸入框，chatmux 無 UI |
| `stickers.test.ts` | TUI 貼圖渲染，chatmux 不渲染 |
| `vim-navigation.test.ts` | TUI vim 導航，chatmux 無 UI |

### 遷移注意事項

1. **import path**：`@evex/linejs` → `npm:@jsr/evex__linejs`（JSR registry）
2. **mock 策略不變**：mock `PushSource`/`MessageClient`/`ContactClient` interfaces
3. **bun:test vs jest**：line-tui 也用 bun:test，語法完全相容
4. **fast opts**：safety test 使用 `{ initialBackoffMs: 1, maxBackoffMs: 2 }` 避免真的 sleep

## Mock 策略

### 原則

- Mock **外部邊界**（linejs API、child process），不 mock 內部模組
- 使用 interface（`PushSource`、`MessageClient`、`ContactClient`）定義 mock 邊界
- Storage test 使用 in-memory SQLite（`:memory:`）

### 常見 Mock 對象

| 模組 | Mock 什麼 | 怎麼 Mock |
|------|----------|----------|
| `connection.test.ts` | `PushSource` | 假 ReadableStream + `initLegyPusher()` 可控制成功/失敗 |
| `messages.test.ts` | `MessageClient` | `decryptMessage()` return 明文、`sendCompactMessage()` return success |
| `contacts.test.ts` | `ContactClient` | `getContacts()` return 假聯絡人列表 |
| `adapter-runner.test.ts` | child process | 假 stdin/stdout stream，模擬 JSON-RPC request/response |
| `mcp-tools.test.ts` | Storage + Adapter Runner | 預填 SQLite 測試資料、mock adapter runner 的 send_message |
| `storage.test.ts` | 無 | 使用真的 `bun:sqlite`（`:memory:`），不 mock |

## bun:test 使用慣例

### 基本結構

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

### 非同步測試

```typescript
test("should handle async operation", async () => {
  const result = await sut.asyncMethod();
  expect(result).toBeDefined();
});
```

### Test 命名慣例

- `should <動作> when <條件>`
- 中文也可：`2 字 CJK 搜尋召回率 ≥ 80%`（storage test 特有）

### 跑測試

```bash
bun test                           # 全部（integration test 預設 skip）
bun test tests/core/storage.test.ts  # 單檔
bun test --timeout 10000           # 長超時（整合測試）
```

## Live Integration Test

Unit test 用 mock 隔離每一層，但 mock 恰好隱藏了跨層串接的 bug（v0.1 的三個 send bug 全因此漏網）。Live integration test 走完 `handleSendMessage` (tools.ts) → `AdapterRunner` → adapter 子程序 → 平台 API 全鏈路，用真實平台 session 驗證。

### 為什麼 gate

Live test 需要：真實平台登入 session、安全的 send target。不能進 CI，手動觸發。

**Per-platform 注意事項**：
- **LINE**：IOSIPAD device slot 只能一個 client，跑 live test 前必須停 chatmux daemon 和 line-tui
- **Telegram**：MTProto session 是 SQLite 檔，兩個 process 同時開會 `database is locked`，跑 live test 前必須停 chatmux daemon

### Gating 機制

| 環境變數 | 必要性 | 說明 |
|---------|--------|------|
| `CHATMUX_LIVE_TEST` | 必要 | 設為 `1` 啟用，未設或其他值 → `describe.skipIf` 跳過 |
| `CHATMUX_TEST_CHAT_ID` | 必要 | Send target（帶 platform prefix，如 `line:u1234...` 或 `telegram:123456789`）。推薦用 self-id（send-to-self） |
| `CHATMUX_DATA_DIR` | 選填 | 預設 `~/.local/share/chatmux`。需含有效的 auth session |

### 跑法

```bash
# 前置：停 chatmux daemon（避免 session 衝突）
systemctl --user stop chatmux

# 跑 live test（timeout 加長，等平台登入）
CHATMUX_TEST_CHAT_ID=<platform>:<your-id> CHATMUX_LIVE_TEST=1 bun test tests/integration/ --timeout 180000

# 完成後恢復
systemctl --user start chatmux
```

### 如何為你的 adapter 寫 live integration test（黃金範本）

1. 在 `tests/integration/<platform>-send.test.ts` 建測試
2. **Env gating**：`describe.skipIf(process.env.CHATMUX_LIVE_TEST !== "1")`
3. **Setup**（`beforeAll`）：
   - 驗證 `CHATMUX_TEST_CHAT_ID` env 存在（必要參數，不自動發現）
   - 建立 `SafetyRail`（用預設值）
   - 建立 `AdapterRunner`，spawn callback 範例：
     ```typescript
     import { spawn } from "node:child_process";
     import { resolve } from "node:path";
     import type { SpawnResult } from "../src/core/adapter-runner.js";

     const spawnAdapter = (cmd: string[]): SpawnResult => {
       const proc = spawn(cmd[0], cmd.slice(1), {
         stdio: ["pipe", "pipe", "inherit"],
         cwd: resolve(import.meta.dir, ".."),   // 專案根目錄
         env: { ...process.env },                // 繼承 env（含 adapters.json 的 env merge）
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
   - `runner.start()` 只等 `initialize` RPC，不等平台登入。等 `status: "connected"` notification 才算就緒
   - 設 120 秒 connected timeout（平台登入可能需要時間）
4. **選安全 send target**：透過 `CHATMUX_TEST_CHAT_ID` env 指定。推薦用自身帳號（send-to-self）或專用 test group，避免騷擾真人。每個平台的 self-id 取得方式不同，spike 時取得後填入 env
5. **Test case**：呼叫 `handleSendMessage(deps, { chat_id: "<platform>:<target>", text: "..." })`
   - `chat_id` 帶 platform prefix
   - `deps.sendToAdapter` 接 `runner.sendRequest`
   - `deps.isAdapterConnected` 回 `true`（已等 connected）
6. **斷言**：`result.success === true`、`result.message_id` 存在且非空、`result.timestamp` 是數字
7. **Teardown**（`afterAll`）：`runner.stop()`
8. **Mutation sanity check**（手動，不在 CI）：至少驗證一個 regression——暫時破壞 send 路徑的某一層 → test 變紅 → 還原 → test 回綠。證明測試有牙

### Test 檔案結構

```
tests/
├── core/           # unit tests（mock 邊界）
├── adapters/       # unit tests（mock 邊界）
└── integration/    # live integration tests（env-gated，真實平台 API）
    ├── line-send.test.ts
    └── telegram-send.test.ts
```
