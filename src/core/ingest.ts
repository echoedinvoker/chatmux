import type { JsonlEvent } from "./storage/jsonl.js";

export type IngestResult = "landed" | "deduped" | "dropped" | "error";

export interface IngestDeps {
  land: (event: JsonlEvent) => boolean;
  log?: (msg: string, ...rest: unknown[]) => void;
}

/** 入口收到的 payload 尚未驗證，narrow 前一律當成任意形狀處理。 */
type RawEvent = {
  type?: unknown;
  platform?: unknown;
  platform_message_id?: unknown;
  chat?: { platform_id?: unknown; type?: unknown; name?: unknown };
  sender?: { platform_id?: unknown; display_name?: unknown };
  timestamp?: unknown;
  content?: Record<string, unknown>;
  raw?: unknown;
  source?: unknown;
  received_at?: unknown;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * 事件攝入隔離邊界：一則畸形事件只損失那一則。
 *
 * 放在 land 之上而不是 landEvent 裡面，因為 backfill 刻意不走 landEvent（見 land-event.ts）。
 * live 與 backfill 各建一個 instance 注入不同的 land，共享同一套形狀驗證與 per-event 隔離。
 *
 * 回傳同步值、絕不拋出：AdapterManager 的派發是同步 for 迴圈，listener 拋出會炸掉 stdout
 * 解析迴圈並跳過其餘 listener；而 async listener 的 rejection 沒有任何人持有，正是 daemon
 * exit 1 的載體。
 */
export function makeIngestEvent(
  deps: IngestDeps,
): (platform: string, params: unknown, source: string) => IngestResult {
  const log = deps.log ?? ((msg: string, ...rest: unknown[]) => console.error(msg, ...rest));

  return function ingest(platform: string, params: unknown, source: string): IngestResult {
    try {
      if (!isObject(params)) {
        log(`[daemon] [${platform}] WARN: dropped event — payload is not an object`);
        return "dropped";
      }

      const raw = params as RawEvent;
      const type = nonEmptyString(raw.type) ? raw.type : "";
      const isMessage = type === "message";

      if (!nonEmptyString(raw.platform_message_id)) {
        log(`[daemon] [${platform}] WARN: dropped ${type || "event"} — missing platform_message_id`);
        return "dropped";
      }
      if (!isObject(raw.chat) || !nonEmptyString(raw.chat.platform_id)) {
        log(
          `[daemon] [${platform}] WARN: dropped ${type || "event"} ${raw.platform_message_id} — missing chat.platform_id`,
        );
        return "dropped";
      }
      if (isMessage && (!isObject(raw.content) || !nonEmptyString(raw.content.type))) {
        log(
          `[daemon] [${platform}] WARN: dropped message ${raw.platform_message_id} — missing content.type`,
        );
        return "dropped";
      }
      if (isMessage && (!isObject(raw.sender) || !nonEmptyString(raw.sender.platform_id))) {
        log(
          `[daemon] [${platform}] WARN: dropped message ${raw.platform_message_id} — missing sender.platform_id`,
        );
        return "dropped";
      }

      const event = {
        ...(raw as object),
        type: type || "unknown",
        platform: nonEmptyString(raw.platform) ? raw.platform : platform,
        chat: {
          ...raw.chat,
          // 僅為滿足 JsonlEvent 型別。非 message 事件不會寫進 chats 表，
          // 這個值不得被任何下游邏輯採信——用 "unknown" 讓假造值在 JSONL 裡一眼可辨。
          type: nonEmptyString(raw.chat.type) ? raw.chat.type : "unknown",
        },
        timestamp: typeof raw.timestamp === "number" ? raw.timestamp : 0,
        source,
        received_at: Date.now(),
      } as unknown as JsonlEvent;

      const landed = deps.land(event);
      if (!landed) {
        log(`[daemon] [${platform}] deduped echo: ${raw.platform_message_id}`);
        return "deduped";
      }

      // log 在 land 之後。它失敗不得把已落地的事實改寫成 "error"——否則依
      // 「error ⇒ 可安全重試」重送時，backfill 的 land 沒有 dedup 保護會重複 append。
      try {
        logEvent(log, platform, type, raw);
      } catch (err) {
        try {
          log(`[daemon] [${platform}] event logged with fallback (log formatting failed):`, err);
        } catch {}
      }

      return "landed";
    } catch (err) {
      try {
        log(`[daemon] [${platform}] ERROR ingesting event:`, err instanceof Error ? (err.stack ?? err.message) : String(err));
      } catch {}
      return "error";
    }
  };
}

function logEvent(
  log: (msg: string, ...rest: unknown[]) => void,
  platform: string,
  type: string,
  raw: RawEvent,
): void {
  const prefix = `[daemon] [${platform}] `;

  if (type === "message") {
    const displayName = raw.sender?.display_name;
    if (!nonEmptyString(displayName)) {
      log(`${prefix}WARN: event missing display_name`, raw.sender?.platform_id);
    }
    log(`${prefix}event: ${String(raw.content?.type)} from ${String(displayName ?? raw.sender?.platform_id)}`);
    return;
  }

  if (type === "unsend") {
    log(`${prefix}unsend: message ${String(raw.content?.message_id ?? raw.platform_message_id)} retracted`);
    return;
  }

  if (type === "read_receipt") {
    log(`${prefix}read_receipt: up to ${String(raw.content?.read_up_to)}`);
    return;
  }

  log(`${prefix}WARN: unknown event type ${type} (${String(raw.platform_message_id)}) — landed to JSONL anyway`);
}
