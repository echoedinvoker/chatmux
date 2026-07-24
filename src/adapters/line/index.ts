import type { Writable, Readable } from "node:stream";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleOp, handleSendMessage, handleBackfill, type MessageClient } from "./messages.js";
import { handleGetContacts, handleGetChats, type ContactClient } from "./contacts.js";
import { login } from "./auth.js";
import { createPushSource, ConnectionManager } from "./push.js";

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

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main();
}

async function main(): Promise<void> {
  let lineClient: (MessageClient & ContactClient) | null = null;
  let connection: ConnectionManager | null = null;

  const responder = new AdapterResponder(process.stdin, process.stdout);

  const origInitialize = responder as any;
  let dataDir = "";

  responder.onRequest("initialize", async (params: unknown) => {
    const p = params as InitializeParams;
    dataDir = join(p.data_dir, "adapters/line");

    const caps: Capabilities = {
      platform: "line",
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

  responder.onRequest("backfill", async (params: unknown) => {
    if (!lineClient) throw new Error("Client not initialized");
    return handleBackfill(lineClient, params as any);
  });

  responder.onRequest("get_contacts", async () => {
    if (!lineClient) throw new Error("Client not initialized");
    return handleGetContacts(lineClient);
  });

  responder.onRequest("get_chats", async () => {
    if (!lineClient) throw new Error("Client not initialized");
    return handleGetChats(lineClient);
  });

  responder.onRequest("get_message_boxes", async () => {
    if (!lineClient) throw new Error("Client not initialized");
    return (lineClient as any).getMessageBoxes();
  });

  responder.onRequest("shutdown", async () => {
    connection?.stop();
    responder.destroy();
    return {};
  });

  responder.start();
  console.error("[LINE] adapter started, waiting for initialize...");

  async function connectLine(adapterDataDir: string, resp: AdapterResponder): Promise<void> {
    console.error("[LINE] logging in...");
    const client = await login(adapterDataDir);
    console.error("[LINE] logged in successfully");

    lineClient = {
      myMid: client.base.profile!.mid,
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
          displayName: r.targetProfileDetail?.profileName ?? r.targetUserMid.slice(0, 8),
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

    resp.notify("status", { state: "connected" });

    const push = createPushSource(client);
    connection = new ConnectionManager(push);

    connection.onEvent(async (op: any) => {
      const event = await handleOp(op, lineClient!);
      if (event) {
        resp.notify("event", event);
      }
    });

    connection.onStateChange((state) => {
      console.error(`[LINE] connection state: ${state}`);
      resp.notify("status", { state });
    });

    connection.onError(async (err) => {
      console.error("[LINE] connection error:", err.message);
      resp.notify("error", { message: err.message });
    });

    connection.start();
    console.error("[LINE] push connection started");
  }
}
