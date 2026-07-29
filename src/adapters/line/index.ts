import type { Writable, Readable } from "node:stream";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleOp, handleSendMessage, handleBackfill, type MessageClient, type AdapterEvent } from "./messages.js";
import { handleGetContacts, handleGetChats, ContactCache, enrichSenderName, type ContactClient } from "./contacts.js";
import { login } from "./auth.js";
import {
  createPushSource,
  ConnectionManager,
  installPushCrashGuard,
  createSuspendDetector,
  type SuspendDetector,
} from "./push.js";
import { subscribeClientLog, safeStringify } from "./diagnostics.js";

export interface InitializeParams {
  data_dir: string;
  platform: string;
}

export interface Capabilities {
  platform: string;
  supported_events: string[];
  can_send: boolean;
  can_backfill: boolean;
  platform_rate_limits?: {
    send: { max: number; window_seconds: number };
  };
}

export interface LineHandlerDeps {
  getClient?: () => MessageClient & ContactClient;
}

export function registerLineHandlers(responder: AdapterResponder, deps?: LineHandlerDeps): void {
  responder.onRequest("initialize", async (params: unknown) => {
    const caps: Capabilities = {
      platform: "line",
      // ⚠️ 這個陣列有三項，本輪（F29，2026-07-29）兌現的**只有 `unsend`**。
      // `read_receipt` 仍未實作：core 側 ingest.ts:159 已有處理邏輯在等（不是死碼，
      // 是等米下鍋），但 adapter 側 `grep read_receipt\|READ_MESSAGE messages.ts` 零命中，
      // LINE 的 NOTIFIED_READ_MESSAGE op 落在白名單外被當雜訊丟掉（F23 觀測窗內 126 次）。
      // ⇒ 它是第二張空頭支票，形狀與 unsend 修之前一模一樣。見 F32。
      supported_events: ["message", "read_receipt", "unsend"],
      can_send: true,
      can_backfill: true,
      platform_rate_limits: {
        send: { max: 5, window_seconds: 60 },
      },
    };
    return caps;
  });

  responder.onRequest("send_message", async (params: unknown) => {
    const client = deps?.getClient?.();
    if (!client) throw new Error("Client not initialized");
    return handleSendMessage(client, params as any);
  });

  responder.onRequest("backfill", async (params: unknown) => {
    const client = deps?.getClient?.();
    if (!client) throw new Error("Client not initialized");
    return handleBackfill(client, params as any);
  });

  responder.onRequest("get_contacts", async () => {
    const client = deps?.getClient?.();
    if (!client) throw new Error("Client not initialized");
    return handleGetContacts(client);
  });

  responder.onRequest("get_chats", async () => {
    const client = deps?.getClient?.();
    if (!client) throw new Error("Client not initialized");
    return handleGetChats(client);
  });

  responder.onRequest("shutdown", async () => {
    return {};
  });
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: unknown;
}

type RequestHandler = (params: unknown) => Promise<unknown>;

export class AdapterResponder {
  private handlers = new Map<string, RequestHandler>();
  private rl: ReturnType<typeof createInterface> | null = null;
  private stdin: Readable;
  private stdout: Writable;

  constructor(stdin: Readable, stdout: Writable) {
    this.stdin = stdin;
    this.stdout = stdout;
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler);
  }

  start(): void {
    this.rl = createInterface({ input: this.stdin });
    this.rl.on("line", (line: string) => this.handleLine(line));
  }

  notify(method: string, params: unknown): void {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.stdout.write(JSON.stringify(msg) + "\n");
  }

  destroy(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  private async handleLine(line: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (!("id" in msg) || !("method" in msg)) return;

    const request = msg as JsonRpcRequest;
    const handler = this.handlers.get(request.method);

    if (!handler) {
      this.sendResponse(request.id, undefined, {
        code: -32601,
        message: `Method not found: ${request.method}`,
      });
      return;
    }

    try {
      const result = await handler(request.params);
      this.sendResponse(request.id, result);
    } catch (err: any) {
      this.sendResponse(request.id, undefined, {
        code: -32000,
        message: err?.message ?? "Unknown error",
      });
    }
  }

  get isStarted(): boolean {
    return this.rl !== null;
  }

  private sendResponse(
    id: number,
    result?: unknown,
    error?: { code: number; message: string },
  ): void {
    const msg: JsonRpcResponse = { jsonrpc: "2.0", id };
    if (error) {
      msg.error = error;
    } else {
      msg.result = result;
    }
    this.stdout.write(JSON.stringify(msg) + "\n");
  }
}

/**
 * 事件送出前的 enrichment（補 sender 顯示名、chat 名）。
 *
 * F29：unsend 事件沒有 `sender`／`content`（協定如此，見 docs/adapter-protocol.md:533），
 * 無守衛地存取 `event.sender.display_name` 會直接 TypeError 打掛 adapter ⇒ 第一行就擋掉
 * 非 message 事件。
 *
 * 抽成具名 export 的理由：這段邏輯原本只能靠跑起真的 daemon 才測得到，而 F11 的教訓
 * 正是「測到函式 ≠ 測到呼叫」——抽出來讓它可測，`onEvent` 那行呼叫由 Phase 2.4 的端對端負責。
 */
export async function enrichEvent(
  event: AdapterEvent,
  contactCache: ContactCache,
  lineClient: ContactClient,
): Promise<AdapterEvent> {
  if (event.type !== "message") return event;

  if (!event.sender.display_name) {
    event.sender.display_name = await enrichSenderName(
      event.sender.platform_id,
      contactCache,
      lineClient,
    );
  }
  if (!event.chat.name) {
    const cachedChat = contactCache.getChat(event.chat.platform_id);
    if (cachedChat) event.chat.name = cachedChat.chatName;
  }
  return event;
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main();
}

async function main(): Promise<void> {
  let lineClient: (MessageClient & ContactClient) | null = null;
  let connection: ConnectionManager | null = null;
  let suspendDetector: SuspendDetector | null = null;
  let contactCache = new ContactCache([], []);

  const responder = new AdapterResponder(process.stdin, process.stdout);

  const origInitialize = responder as any;
  let dataDir = "";

  responder.onRequest("initialize", async (params: unknown) => {
    const p = params as InitializeParams;
    dataDir = join(p.data_dir, "adapters/line");

    const caps: Capabilities = {
      platform: "line",
      // ⚠️ 這個陣列有三項，本輪（F29，2026-07-29）兌現的**只有 `unsend`**。
      // `read_receipt` 仍未實作：core 側 ingest.ts:159 已有處理邏輯在等（不是死碼，
      // 是等米下鍋），但 adapter 側 `grep read_receipt\|READ_MESSAGE messages.ts` 零命中，
      // LINE 的 NOTIFIED_READ_MESSAGE op 落在白名單外被當雜訊丟掉（F23 觀測窗內 126 次）。
      // ⇒ 它是第二張空頭支票，形狀與 unsend 修之前一模一樣。見 F32。
      supported_events: ["message", "read_receipt", "unsend"],
      can_send: true,
      can_backfill: true,
      platform_rate_limits: {
        send: { max: 5, window_seconds: 60 },
      },
    };

    connectLine(dataDir, responder).catch((err) => {
      console.error("[LINE] connection failed:", err instanceof Error ? err.message : err);
      responder.notify("error", { message: `LINE login failed: ${err instanceof Error ? err.message : err}` });
    });

    return caps;
  });

  responder.onRequest("send_message", async (params: unknown) => {
    if (!lineClient) throw new Error("Client not initialized");
    return handleSendMessage(lineClient, params as any);
  });

  responder.onRequest("get_self", async () => {
    if (!lineClient) throw new Error("Client not initialized");
    const self = {
      platform_id: lineClient.myMid,
      display_name: lineClient.myDisplayName,
    };
    // Lets enrichSenderName resolve our own outgoing messages instead of
    // falling back to the raw MID.
    contactCache.addContacts([{ mid: self.platform_id, displayName: self.display_name }]);
    return self;
  });

  responder.onRequest("backfill", async (params: unknown) => {
    if (!lineClient) throw new Error("Client not initialized");
    return handleBackfill(lineClient, params as any);
  });

  responder.onRequest("get_contacts", async () => {
    if (!lineClient) throw new Error("Client not initialized");
    const result = await handleGetContacts(lineClient);
    contactCache.addContacts(
      result.contacts.map((c) => ({ mid: c.platform_id, displayName: c.display_name })),
    );
    return result;
  });

  responder.onRequest("get_chats", async () => {
    if (!lineClient) throw new Error("Client not initialized");
    const contactsMap = new Map<string, string>();
    for (const c of contactCache.search("")) {
      contactsMap.set(c.mid, c.displayName);
    }
    return handleGetChats(lineClient, contactsMap);
  });

  responder.onRequest("get_message_boxes", async () => {
    if (!lineClient) throw new Error("Client not initialized");
    return (lineClient as any).getMessageBoxes();
  });

  responder.onRequest("shutdown", async () => {
    suspendDetector?.stop();
    connection?.stop();
    responder.destroy();
    return {};
  });

  // The undici h2 stream timeout surfaces as an orphan rejection that no
  // try/catch inside push.ts can reach, so it has to be caught at process level.
  // Everything we do not recognise keeps today's fail-fast behaviour.
  installPushCrashGuard({
    proc: process,
    onStreamFailure: (err) => {
      console.error(
        "[LINE] push liveness: stream failure caught, will reconnect:",
        err instanceof Error ? err.message : err,
      );
      connection?.markStreamDead("push-stream-failure");
    },
    onFatal: (reason) => {
      console.error("[LINE] unhandled rejection (not a push stream failure):", reason);
      setImmediate(() => {
        throw reason;
      });
    },
  });

  responder.start();
  console.error("[LINE] adapter started, waiting for initialize...");

  async function connectLine(adapterDataDir: string, resp: AdapterResponder): Promise<void> {
    console.error("[LINE] logging in...");
    const client = await login(adapterDataDir);
    console.error("[LINE] logged in successfully");

    lineClient = {
      myMid: client.base.profile!.mid,
      myDisplayName: client.base.profile!.displayName,
      async decryptMessage(msg: any) {
        try {
          return await client.base.e2ee.decryptE2EEMessage(msg);
        } catch {
          return msg;
        }
      },
      async sendCompactMessage(to: string, text: string) {
        return client.base.talk.sendCompactMessage({ to, text });
      },
      async getPreviousMessages(chatMid: string, count: number, before?: { deliveredTime: bigint; messageId: bigint }) {
        let endMessageId: any;
        if (before && before.messageId !== BigInt(0)) {
          endMessageId = { deliveredTime: before.deliveredTime, messageId: before.messageId };
        } else {
          const boxes = await client.base.talk.getMessageBoxes({ messageBoxListRequest: {} });
          const box = (boxes as any).messageBoxes?.find((b: any) => b.id === chatMid);
          if (!box?.lastDeliveredMessageId) return [];
          endMessageId = {
            deliveredTime: box.lastDeliveredMessageId.deliveredTime,
            messageId: box.lastDeliveredMessageId.messageId,
          };
        }
        const result = await client.base.talk.getPreviousMessagesV2WithRequest({
          request: { messageBoxId: chatMid, endMessageId, messagesCount: count },
          syncReason: "UNKNOWN",
        });
        return (result as any[]) ?? [];
      },
      async getUserFriendIds() {
        const res = await client.base.relation.getUserFriendIds({
          request: { blockStatus: "ALL" },
        });
        return (res as any).userFriendMids;
      },
      async getContactsV3(mids: string[]) {
        const res = await client.base.relation.getContactsV3({ mids });
        return (res as any).responses.map((r: any) => ({
          mid: r.targetUserMid,
          displayName: r.targetProfileDetail?.profileName ?? "",
        }));
      },
      async getAllChatMids() {
        return client.base.talk.getAllChatMids({
          request: { withMemberChats: true },
          syncReason: "INTERNAL",
        });
      },
      async getChats(chatMids: string[]) {
        const res = await client.base.talk.getChats({ chatMids });
        return (res as any).chats.map((c: any) => ({
          chatMid: c.chatMid,
          chatName: c.chatName,
          members: Object.keys(c.extra?.groupExtra?.memberMids ?? {}),
        }));
      },
      async getMessageBoxes() {
        const boxes = await client.base.talk.getMessageBoxes({
          messageBoxListRequest: { withUnreadCount: true },
        });
        const list = (boxes as any).messageBoxes ?? [];
        return list.map((b: any) => ({
          id: b.id as string,
          lastDeliveredTime: Number(b.lastDeliveredMessageId?.deliveredTime ?? 0),
        }));
      },
    };

    // No status announcement here: login succeeding says nothing about whether
    // the push stream is up. Connection state is produced solely by
    // ConnectionManager, from evidence.
    // 放在 push 建立之前，才接得到 push 初始化本身噴的 log（含 LegyPusherError_cannot_init）。
    // ⚠️ 必須訂閱 `client.base`：`log()` 定義在 BaseClient（base/core/mod.ts:211），
    // `Client`（client/client.ts:85）是獨立的 emitter 且不轉發 "log"。掛在 client 上的 listener
    // 永遠不會被觸發，且完全靜默——2026-07-29 斷網反證抓到過一次。
    subscribeClientLog(client.base, (l) => console.error(l));

    const push = createPushSource(client);
    connection = new ConnectionManager(push, {
      livenessReportMs: Number(process.env.CHATMUX_F27_LIVENESS_REPORT_MS ?? 30_000),
      onLivenessReport: (state, lastLivenessEvidenceAt) => {
        resp.notify("status", {
          state,
          ...(lastLivenessEvidenceAt !== null
            ? { last_liveness_evidence_at: lastLivenessEvidenceAt }
            : {}),
        });
      },
    });

    connection.onEvent(async (op: any) => {
      const event = await handleOp(op, lineClient!, (o) => {
        // 既有單行格式不變（F23 儀器的下游可能在 parse 它）。
        console.error(`[LINE] op ${o.kind}: ${o.opType} chat=${o.chatId} t=${o.t}`);
        if (o.raw !== undefined) {
          console.error(`[LINE] op raw: ${safeStringify(o.raw)}`);
        }
      });
      if (event) {
        resp.notify("event", await enrichEvent(event, contactCache, lineClient!));
      }
    });

    connection.onStateChange((state, lastLivenessEvidenceAt) => {
      console.error(`[LINE] connection state: ${state}`);
      resp.notify("status", {
        state,
        ...(lastLivenessEvidenceAt !== null
          ? { last_liveness_evidence_at: lastLivenessEvidenceAt }
          : {}),
      });
    });

    connection.onError(async (err) => {
      console.error("[LINE] connection error:", err.message);
      resp.notify("error", { message: err.message });
    });

    connection.start();
    console.error("[LINE] push connection started");

    // A suspended host leaves the push stream dead but locally silent: nothing
    // errors, so without this we keep claiming `connected` until undici's 300s
    // h2 timeout fires ~7-10 minutes later.
    suspendDetector = createSuspendDetector({
      intervalMs: Number(process.env.CHATMUX_F27_TICK_MS ?? 30_000),
      thresholdMs: Number(process.env.CHATMUX_F27_GAP_MS ?? 90_000),
      now: Date.now,
      onSuspendDetected: (gap) => {
        console.error(`[LINE] push liveness: suspend gap ${gap}ms detected`);
        connection?.markStreamDead("suspend-gap");
      },
    });
    suspendDetector.start();
  }
}
