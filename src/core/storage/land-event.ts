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
 * dedup 只守 message：這個 map 存在的唯一目的是防「core 主動落地的送出訊息」與「adapter 回吐
 * 的同一則」互撞，而那個 race 只發生在 message。變更事件沒有兩條來源路徑，一開始就不需要去重。
 * 曾經改成「key 含 type」想擋掉 unsend 被原訊息 key 吃掉的問題，但那只治了 unsend——Telegram 的
 * edit 同樣重用原訊息 ID，串流 bot 一則訊息在 60 秒內連編十次，key `edit:tg:4484` 只有第一次
 * 進得來，其餘九次連 log 都沒有。代價是同一則 unsend 真的送兩次時 JSONL 會多一行，而套用是
 * 冪等的，SQLite 結果不變。
 *
 * notify 涵蓋 message / edit / unsend：三者都改變了 consumer 讀得到的 SQLite 狀態。
 * read_receipt 不改，仍不推播。
 */
const NOTIFYING_TYPES = new Set(["message", "edit", "unsend"]);

export function makeLandEvent(deps: LandEventDeps): (event: JsonlEvent) => boolean {
  const landedKeys = new Map<string, number>();

  return function landEvent(event: JsonlEvent): boolean {
    const deduped = event.type === "message";
    const key = `${event.type}:${event.platform}:${event.platform_message_id}`;
    const now = Date.now();
    for (const [k, t] of landedKeys) if (now - t > LANDED_TTL_MS) landedKeys.delete(k);
    if (deduped) {
      if (landedKeys.has(key)) return false;
      landedKeys.set(key, now);
    }

    // JSONL 是 truth source。它失敗 ＝ 什麼都沒寫 → 復原 key，讓另一條路徑或重試能補。
    // 本函式全同步無 await，delete 不會重新引入原本要防的 race。
    try {
      deps.jsonl.append(event);
    } catch (err) {
      if (deduped) landedKeys.delete(key);
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

    if (NOTIFYING_TYPES.has(event.type)) {
      deps.subscriptions.notifyMessageReceived(`${event.platform}:${event.chat.platform_id}`);
    }
    return true;
  };
}
