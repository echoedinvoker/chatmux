import type { JsonlEvent } from "./jsonl.js";

const LANDED_TTL_MS = 60_000;

export interface LandEventDeps {
  jsonl: { append: (event: JsonlEvent) => void };
  syncToSQLite: (event: JsonlEvent) => void;
  subscriptions: { notifyMessageReceived: (chatCompositeId: string) => void };
}

/**
 * 建立唯一的落地入口。回 true ＝ 已落地（JSONL 有那行）；回 false ＝ 同一則已落地過（正常去重）。
 *
 * live 回吐與 core 主動落地兩條路徑都走這裡，check-and-set 在函式內，誰先到誰贏。
 * 單向查表（在 onEvent 入口擋）有 race：回吐走 adapter 的常駐推播連線，可能比 send RPC 的
 * 回應先到，那時 key 還沒寫入 → 兩條路徑各 append 一次 → JSONL 兩行（SQLite 因
 * INSERT OR IGNORE 看不出來）。
 *
 * landedKeys 用 in-memory Map 而非查 DB：daemon 是單一長駐 process。重啟後最壞情況是漏擋
 * 一則跨重啟的回吐（極窄窗口，SQLite 仍免疫，只有 JSONL 多一行），用 per-event DB 查詢換
 * 這個窄窗口不值得。TTL 清理是「有新事件進來時順手掃」，沒有主動計時器。
 *
 * backfill 不走這裡：量大（GLOBAL_TARGET = 500）會把 map 灌爆，且它本來就靠 SQLite 的
 * INSERT OR IGNORE。
 *
 * key 含 type：Telegram 的 unsend 重用被收回訊息本身的 platform_message_id（刪除事件沒有
 * 獨立 ID），key 不含 type 時「收到訊息後 60 秒內收回」的 unsend 會命中原訊息的 key 而被
 * 靜默吃掉。兩條路徑要防的回吐撞擊 type 都是 message，加上 type 對它無損。
 *
 * notify 只對 message：unsend / read_receipt 不改變 SQLite 中 consumer 讀得到的狀態。
 */
export function makeLandEvent(deps: LandEventDeps): (event: JsonlEvent) => boolean {
  const landedKeys = new Map<string, number>();

  return function landEvent(event: JsonlEvent): boolean {
    const key = `${event.type}:${event.platform}:${event.platform_message_id}`;
    const now = Date.now();
    for (const [k, t] of landedKeys) if (now - t > LANDED_TTL_MS) landedKeys.delete(k);
    if (landedKeys.has(key)) return false;
    landedKeys.set(key, now);

    // JSONL 是 truth source。它失敗 ＝ 什麼都沒寫 → 復原 key，讓另一條路徑或重試能補。
    // 本函式全同步無 await，delete 不會重新引入原本要防的 race。
    try {
      deps.jsonl.append(event);
    } catch (err) {
      landedKeys.delete(key);
      throw err;
    }

    // SQLite 只是衍生 view。它失敗時 JSONL 已經有那行了，這則訊息在 truth source 的意義上
    // 「已落地」，所以 key 必須留著——若在此 delete，另一條路徑會再 append 一次 JSONL。
    // 補救靠 daemon 啟動時的 syncCheck()（掃 JSONL 尾端補 SQLite 缺漏）。
    try {
      deps.syncToSQLite(event);
    } catch (err) {
      console.error("[daemon] landed to JSONL but SQLite sync failed (syncCheck will recover on restart):", err);
    }

    // 只有 message 改變了 consumer 讀得到的 SQLite 狀態。unsend / read_receipt 發推播
    // 只會讓 chat.nvim 白跑一趟 re-read。
    if (event.type === "message") {
      deps.subscriptions.notifyMessageReceived(`${event.platform}:${event.chat.platform_id}`);
    }
    return true;
  };
}
