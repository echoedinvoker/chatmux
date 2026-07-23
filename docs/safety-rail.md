# SafetyRail

三層防護 + 雙層設計，確保 chatmux 不會意外騷擾聊天對象或因錯誤無限重試。

## 三層架構

```
send_message 請求
  │
  ├─ Layer 1: RateLimiter（頻率控制）
  │   └─ 超限 → 排隊等待（不拒絕，等 window 過）
  │
  ├─ Layer 2: ErrorTracker（連續錯誤退避）
  │   └─ 連續失敗 → 指數退避 5→10→20s
  │   └─ 達 kill threshold → 觸發 KillSwitch
  │
  └─ Layer 3: KillSwitch（緊急停止）
      └─ 觸發 → 斷開 adapter 連線，需手動 reset
```

### RateLimiter

滑動視窗 rate limiter，追蹤最近 60 秒內的發送次數。

| 參數 | 預設值 | 說明 |
|------|--------|------|
| `maxPerMinute` | 5 | 每分鐘最大發送數 |

行為：
- 未超限 → 立即通過，記錄時間戳
- 超限 → 排入佇列，等最早的時間戳超過 60 秒後自動釋放
- 不拒絕請求，只延遲（避免丟失合法訊息）

### ErrorTracker

追蹤連續錯誤次數，指數退避。

| 參數 | 預設值 | 說明 |
|------|--------|------|
| `killThreshold` | 3 | 連續幾次錯誤觸發 kill |
| `initialBackoffMs` | 5,000 | 首次退避毫秒 |
| `maxBackoffMs` | 20,000 | 最大退避毫秒 |

行為：
- 錯誤 → `consecutiveErrors++` → sleep(backoffMs) → `backoffMs *= 2`（上限 `maxBackoffMs`）
- 成功 → `reset()`（計數歸零、退避回初始值）
- 連續錯誤達 `killThreshold` → return `"kill"` → 觸發 KillSwitch
- **網路錯誤排除**：`isNetworkError(err)` 為 true 時不計入（網路斷線由重連機制處理）

### KillSwitch

緊急停止開關。

| 參數 | 預設值 | 說明 |
|------|--------|------|
| `threshold` | 1 | anomaly 記錄幾次後觸發 kill（SafetyRail 預設 1，即 ErrorTracker kill 一次就觸發） |

行為：
- `recordAnomaly()` → 累計，達 threshold → `killed = true` → 觸發所有 kill listeners
- `recordNormal()` → anomaly 計數歸零（但不清除 killed 狀態）
- `reset()` → killed = false + 計數歸零（手動恢復）

### SafetyRail Facade

組合三層為統一介面。

```typescript
class SafetyRail {
  rateLimiter: RateLimiter;      // 5/min
  errorTracker: ErrorTracker;    // kill at 3, backoff 5→10→20s
  killSwitch: KillSwitch;        // threshold 1

  recordError(err): void;        // 網路錯誤跳過；其餘觸發 ErrorTracker → 可能觸發 KillSwitch
  recordSuccess(): void;         // reset ErrorTracker + KillSwitch.recordNormal()
  reset(): void;                 // 全部歸零（手動恢復用）
  onKill(fn): void;              // 註冊 kill callback
}
```

## 雙層設計（Core + Adapter）

### 架構強制原理

Adapter 是 child process，**只能透過 stdio 跟 core 通訊**。所有 `send_message` 必須從 MCP tool → core SafetyRail → adapter runner → adapter。不存在繞過 SafetyRail 的路徑。

### 兩層如何互動

1. **Core 底線**：SafetyRail 預設 5/min，是安全網
2. **Adapter 回報**：`initialize` response 包含 `platform_rate_limits`
3. **取嚴者**：core 比較自己的預設 vs adapter 回報，取嚴的那個

```
Core default: 5/min
Adapter reports: 3/min (platform limit)
→ Core uses: 3/min (stricter)

Core default: 5/min
Adapter reports: 10/min
→ Core uses: 5/min (core default is stricter, adapter cannot loosen)
```

**Adapter 只能更嚴，不能放寬**——core 底線是最後防線。

### 為什麼不讓 adapter 自己 rate limit

- Adapter crash/restart 會丟失計數器狀態
- 多 adapter 場景（v0.2+）core 需要全局視角
- 安全邊界在 core，adapter 是不受信任的——哪怕 adapter 被惡意修改也不能繞過 core

## ErrorTracker 實例分離

chatmux 有**兩個獨立的 ErrorTracker + KillSwitch 實例**，各自計數互不干擾：

### (A) SafetyRail 內：send failure

| 項目 | 值 |
|------|-----|
| 追蹤什麼 | `send_message` 連續失敗 |
| ErrorTracker kill threshold | 3 |
| KillSwitch 動作 | 斷開 adapter 連線 |
| 恢復方式 | `safetyRail.reset()`（手動） |

### (B) Adapter Runner：process crash

| 項目 | 值 |
|------|-----|
| 追蹤什麼 | adapter child process 連續 crash（exit non-zero） |
| ErrorTracker kill threshold | 5 |
| KillSwitch 動作 | 停止重啟嘗試 |
| 恢復方式 | daemon 重啟或 `adapterRunner.reset()`（手動） |

**為什麼分開**：
- Send failure 和 process crash 是不同的故障模式
- Adapter 可能正常運行但 send 持續失敗（例如對方已封鎖）→ 只 kill send，不停 adapter
- Adapter 可能 crash 但 send 沒問題（例如 push connection bug）→ 只停重啟，不影響 SafetyRail 計數

## 恢復流程

### 自動恢復

- **send 成功** → `SafetyRail.recordSuccess()` 自動清除 ErrorTracker 計數 + KillSwitch anomaly（但不清除 killed 狀態）
- **adapter 正常啟動** → Adapter Runner ErrorTracker 自動清除計數

### 手動恢復（KillSwitch 觸發後）

KillSwitch 一旦 `killed = true`，不會自動恢復。需要：

1. `safetyRail.reset()`（清除 SafetyRail 的 KillSwitch）
2. 或重啟 daemon（清除所有狀態）

v0.1 手動恢復方式：重啟 daemon（`systemctl --user restart chatmux`）。v0.2 考慮 MCP tool `reset_safety`。

## 遷移來源

SafetyRail 從 line-tui `src/safety.ts`（164 lines）直接搬運。核心邏輯不變，差異：

| 項目 | line-tui | chatmux |
|------|---------|---------|
| `isNetworkError` 判斷 | import from `connection.ts` | 需抽象化（adapter 平台無關） |
| KillSwitch callback | 直接停 TUI | 通知 adapter runner 斷連 |
| Adapter runner ErrorTracker | 不存在 | 新增，kill at 5 |
