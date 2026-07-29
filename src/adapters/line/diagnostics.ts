/**
 * linejs 內部診斷的可見層。
 *
 * `client.log()` 只做 `this.emit("log", {type, data})`（@evex/linejs/base/core/mod.ts:211-213），
 * 沒有任何一處訂閱它 ⇒ 整層 linejs 診斷（重試、連線失敗、LegyPusherError）一行都不進 journal。
 * F27 規劃時把「有沒有 LegyPusherError」當分支裁決依據，實測 0 次——0 是「沒量測」不是「沒發生」。
 *
 * ⚠️ 必須過濾：`log()` 是逐 byte-chunk 被呼叫的（base/push/conn.ts:150 writeByte、:169 readByte
 * 在 `for await (const chunk of this.resStream)` 裡），全量轉出會撞 journald 的
 * RateLimitBurst=10000/30s 而開始丟行——很可能連這個儀器唯一想抓的 LegyPusherError 一起丟掉。
 *
 * 過濾採 **denylist 而非 allowlist**：allowlist 會吞掉所有未知型別的訊號，那正是這個儀器要避免的
 * 失效形態（不認識的訊號寫不出來）。
 */

/** 逐位元組與 poll 週期的固定雜訊——量體來源，全部丟棄。 */
export const NOISY_LOG_TYPES = [
  "readByte",
  "writeByte",
  "_OnPushResponse",
  "fetchOps",
  "individualRev",
  "globalRev",
] as const;

/** 這個前綴的行是 push 連線的逐封包 trace（base/push/conn.ts）。 */
export const NOISY_LOG_PREFIX = "[LEGY/PUSH]";

const NOISY = new Set<string>(NOISY_LOG_TYPES);

function isNoisy(type: string): boolean {
  return NOISY.has(type) || type.startsWith(NOISY_LOG_PREFIX);
}

/**
 * data 的內容不受我們控制（來自 linejs 內部），一個循環參照就會把整個 adapter 打掛。
 * 序列化失敗一律降級成 String()，不得往外拋。
 */
export function safeStringify(data: unknown): string {
  try {
    // ⚠️ Error 的 message/stack 是不可列舉屬性 ⇒ JSON.stringify(new Error("x")) 回 "{}"。
    // 2026-07-29 斷網反證抓到的第一行就是 `LegyPusherError {"error":{}}`：儀器響了但沒帶診斷內容。
    return (
      JSON.stringify(data, (_key, value) =>
        value instanceof Error
          ? {
              name: value.name,
              message: value.message,
              at: value.stack?.split("\n")[1]?.trim(),
            }
          : value,
      ) ?? String(data)
    );
  } catch {
    return String(data);
  }
}

export interface LogEmitter {
  on(event: string, handler: (payload: any) => void): void;
}

/** 把 linejs 的 log event 轉成一行文字餵給 sink（正式環境為 console.error）。 */
export function subscribeClientLog(
  client: LogEmitter,
  sink: (line: string) => void,
): void {
  client.on("log", (payload: any) => {
    const type = String(payload?.type ?? "unknown");
    if (isNoisy(type)) return;
    sink(`[LINE][linejs] ${type} ${safeStringify(payload?.data)}`);
  });
}
