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
bun test                           # 全部
bun test tests/core/storage.test.ts  # 單檔
bun test --timeout 10000           # 長超時（整合測試）
```
