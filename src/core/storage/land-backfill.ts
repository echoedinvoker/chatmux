import type { Database } from "bun:sqlite";
import type { JsonlEvent } from "./jsonl.js";
import { hasMessage } from "./query.js";

export interface LandBackfillDeps {
  jsonl: { append: (event: JsonlEvent) => void };
  syncToSQLite: (event: JsonlEvent) => void;
  db: Database;
}

/**
 * backfill 的落地入口。與 live 的 `makeLandEvent` 並列，刻意不共用：
 *
 * - **不進 landedKeys**：那個 map 是 in-memory + TTL 60 秒，存在的唯一目的是擋「core 主動落地的
 *   送出訊息」與「adapter 回吐同一則」的 race。backfill 量大（GLOBAL_TARGET = 500）會把它灌爆，
 *   而它對 backfill 的實際重複來源（跨 cold start 反覆拉回同一批舊訊息）也完全無效——第 N+1 次
 *   啟動時 map 是空的，且距上次落地早已超過 TTL。
 * - **不 notify**：cold start 補抓不是「有新訊息到了」，推播它會讓 consumer 對著幾百則舊訊息閃。
 *
 * **寫 JSONL 前查 DB（F26 Phase 3）——這是對「先寫 log 再投影」原則的唯一例外，只適用 backfill。**
 * 補抓每次冷啟動都會把同一批舊訊息重新拉回來，無條件 append 讓 JSONL 對業務鍵放大到 9.78×，
 * 而每次冷啟動又要重播這份 log（磁碟與啟動時間雙漲）。DB 存在性是**精確**的去重判準：
 * JSONL distinct 與 DB distinct 實測相等，`INSERT OR IGNORE` 本來就在做同一件判斷，這裡只是
 * 把它提前一步用在寫入決策上。
 *
 * 安全的前提是不變式「DB 有這列 ⇒ JSONL 已有對應行」：`messages` 的唯一插入點是
 * `syncEventToSQLite`，而它的三個呼叫點（live 的 landEvent、本函式、replayFrom）全都在
 * JSONL append 之後。⇒ 跳過 append 不會讓任何訊息從 truth source 消失，乾淨 DB 全量 replay
 * 仍重建得出同一份投影。
 *
 * 只擋 message：其餘型別在 DB 沒有這個形狀的列，比照 landEvent 一律直寫。
 * live 事件不套用本例外——它們一律先寫 log。
 */
export function makeLandBackfillEvent(deps: LandBackfillDeps): (event: JsonlEvent) => boolean {
  return function landBackfillEvent(event: JsonlEvent): boolean {
    if (
      event.type === "message" &&
      hasMessage(deps.db, event.platform, event.chat.platform_id, event.platform_message_id)
    ) {
      return false;
    }

    deps.jsonl.append(event);
    deps.syncToSQLite(event);
    return true;
  };
}
