import { resolve, join } from "node:path";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { JsonlWriter, type JsonlEvent } from "./storage/jsonl.js";
import { initSchema, syncEventToSQLite } from "./storage/sqlite.js";
import { replayFrom } from "./storage/replay.js";
import { upsertChatsFromAdapter, applyMessageBoxRecency, type AdapterChat } from "./storage/adapter-recency.js";
import { initFTS } from "./storage/fts.js";
import { makeLandEvent } from "./storage/land-event.js";
import { makeLandBackfillEvent } from "./storage/land-backfill.js";
import { makeIngestEvent } from "./ingest.js";
import { SafetyRail } from "./safety.js";
import { isMethodNotFound, type SpawnResult } from "./adapter-runner.js";
import { AdapterManager } from "./adapter-manager.js";
import { loadAdapterConfigs, loadMcpPort, loadMcpHost } from "./config.js";
import { startMcpServer } from "./mcp/server.js";
import {
  handleListChats,
  handleReadMessages,
  handleReadEvents,
  handleSearchMessages,
  handleSendMessage,
  handleGetStatus,
  handleProbeLatest,
  handleGetMedia,
  type SendDeps,
  type ProbeDeps,
} from "./mcp/tools.js";
import { MediaCache } from "./media-cache.js";
import {
  handleResource,
  ResourceSubscriptionManager,
  registerSubscriptionHandlers,
} from "./mcp/resources.js";
import { needsBackfill, backfillChat, type BackfillDeps } from "./backfill-on-demand.js";
import { catchUpAdapter } from "./cold-start-catchup.js";
import { createReconnectCatchupTrigger } from "./reconnect-catchup.js";

const dataDir = resolve(
  process.env.CHATMUX_DATA_DIR ?? join(process.env.HOME ?? "~", ".local/share/chatmux"),
);
const socketPath =
  process.env.CHATMUX_SOCKET ?? join(dataDir, "chatmux.sock");

mkdirSync(dataDir, { recursive: true });

const mcpPort = loadMcpPort(dataDir);
const mcpHost = loadMcpHost(dataDir);

console.error(`[daemon] data dir: ${dataDir}`);
console.error(`[daemon] socket: ${socketPath}`);
console.error(
  `[daemon] mcp tcp: ${mcpPort > 0 ? `${mcpHost}:${mcpPort}` : "disabled (unix socket only)"}`,
);

const jsonlPath = join(dataDir, "events.jsonl");
const dbPath = join(dataDir, "chatmux.db");

const jsonl = new JsonlWriter(jsonlPath);
const db = new Database(dbPath);
initSchema(db);
initFTS(db);
console.error("[daemon] storage initialized");

syncCheck();

const safety = new SafetyRail();
const subscriptions = new ResourceSubscriptionManager();

const landEvent = makeLandEvent({
  jsonl,
  syncToSQLite: (event) => syncEventToSQLite(db, event),
  subscriptions,
});

// live 走 landEvent（含跨路徑去重）；backfill 走 landBackfillEvent，不進 dedup map
// （量大會把 map 灌爆，且它本來就靠 SQLite 的 INSERT OR IGNORE）。
const ingestLive = makeIngestEvent({ land: landEvent });
const ingestBackfill = makeIngestEvent({
  land: makeLandBackfillEvent({
    jsonl,
    syncToSQLite: (event) => syncEventToSQLite(db, event),
    db,
  }),
});

const backfillDeps: BackfillDeps = {
  db,
  sendRequest: (platform, method, params) => manager.sendRequest(platform, method, params),
  ingest: (platform, event, source) => ingestBackfill(platform, event, source),
  notify: (chatId) => subscriptions.notifyMessageReceived(chatId),
};

const adapterConfigs = loadAdapterConfigs(dataDir);
console.error(`[daemon] loaded ${adapterConfigs.length} adapter config(s): ${adapterConfigs.map(c => c.platform).join(", ")}`);

const manager = new AdapterManager(adapterConfigs, {
  dataDir,
  safetyRail: safety,
  spawn: (platform) => {
    const config = adapterConfigs.find(c => c.platform === platform)!;
    return (cmd) => {
      const proc = spawn(cmd[0], cmd.slice(1), {
        stdio: ["pipe", "pipe", "inherit"],
        cwd: config.cwd ?? resolve(import.meta.dir, "../.."),
        env: config.env ? { ...process.env, ...config.env } : undefined,
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
      } satisfies SpawnResult;
    };
  },
});

// 同步 handler：onEvent 的型別是 => void，async handler 回傳的 promise 沒有任何人持有，
// 是 unhandled rejection 逸出（daemon exit 1）的載體。改成同步後這條路徑連 promise 都沒有。
manager.onEvent((platform: string, params: unknown) => {
  ingestLive(platform, params, "live");
});

// Fires on the adapter's raw three states, not the boolean core exposes through
// get_status — so `reconnecting` is visible here even though the query APIs
// never emit that string.
const reconnectCatchup = createReconnectCatchupTrigger({
  runCatchup: async (platform) => {
    console.error(`[daemon] [${platform}] reconnect catch-up: starting`);
    await backfillAdapter(platform);
    console.error(`[daemon] [${platform}] reconnect catch-up: done`);
  },
});

manager.onStatus((platform: string, params: unknown) => {
  const status = params as { state: string };
  console.error(`[daemon] [${platform}] adapter status: ${status.state}`);
  // onStatus is typed `=> void`, so this promise has no owner. Keep the handler
  // synchronous and attach the platform to any failure — an anonymous top-level
  // rejection log is precisely the silence this project is removing.
  void reconnectCatchup.onStatus(platform, status.state).catch((e) =>
    console.error(`[daemon] [${platform}] reconnect catch-up failed:`, e),
  );
});

manager.onError((platform: string, params: unknown) => {
  console.error(`[daemon] [${platform}] adapter error:`, params);
});

// Media lives under XDG_CACHE_HOME, not the data dir: it is all re-downloadable, so it is
// cache in the strict sense — losing it costs a re-fetch, never a message.
const mediaCache = new MediaCache({
  root: join(
    process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? "~", ".cache"),
    "chatmux/media",
  ),
  maxBytes: 200 * 1024 * 1024,
  callAdapter: (platform, method, params, opts) =>
    manager.sendRequest(platform, method, params, opts),
  fetchPublicUrl: async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mime: res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream",
    };
  },
});

function registerTools(server: McpServer): void {
  server.tool(
    "list_chats",
    "List all chats with last message preview",
    {
      platform: z.string().optional().describe("Filter by platform (e.g. 'line', 'telegram')"),
      search: z.string().optional().describe("Search chat name"),
      limit: z.number().optional().default(50),
      offset: z.number().optional().default(0),
    },
    async ({ platform, search, limit, offset }) => {
      const result = handleListChats(db, { platform, search, limit, offset });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "read_messages",
    "Read messages from a specific chat",
    {
      chat_id: z.string().describe("Chat ID (e.g. 'line:c1234', 'telegram:456')"),
      limit: z.number().optional().default(20),
      before: z.number().optional().describe("Messages before this timestamp (ms)"),
      after: z.number().optional().describe("Messages after this timestamp (ms)"),
    },
    async ({ chat_id, limit, before, after }) => {
      const result = handleReadMessages(db, { chat_id, limit, before, after });
      triggerOnDemandBackfill(chat_id);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "get_media",
    "Get a local file path for a message's media (image or sticker). Downloads and caches on first call; later calls hit the cache. Answers { unavailable } when the platform no longer has the content.",
    {
      message_id: z.string().describe("Message ID (e.g. 'line:623174375235650150')"),
      chat_id: z.string().optional().describe("Chat ID the message belongs to (e.g. 'telegram:-1001782953277'). Required on platforms where message ids repeat across chats — see docs/platform-facts.md"),
    },
    async ({ message_id, chat_id }) => {
      const result = await handleGetMedia(db, mediaCache, { message_id, chat_id });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "read_events",
    "Tail the event log from a cursor. Omit `since` to get the current head cursor without replaying history. Cursors are opaque — echo them back verbatim.",
    {
      since: z.string().optional().describe("Opaque cursor from a previous read_events / get_status call. Omit to start tailing from now."),
      limit: z.number().optional().default(100),
    },
    async ({ since, limit }) => {
      const result = handleReadEvents(db, { since, limit });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "search_messages",
    "Full-text search messages (CJK supported)",
    {
      query: z.string().describe("Search query"),
      chat_id: z.string().optional().describe("Limit to specific chat"),
      platform: z.string().optional().describe("Filter by platform"),
      limit: z.number().optional().default(20),
      offset: z.number().optional().default(0),
    },
    async ({ query, chat_id, platform, limit, offset }) => {
      const result = handleSearchMessages(db, { query, chat_id, platform, limit, offset });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "send_message",
    "Send a message through an adapter (rate-limited by SafetyRail)",
    {
      chat_id: z.string().describe("Target chat ID (e.g. 'line:c1234', 'telegram:456')"),
      text: z.string().describe("Message text to send"),
    },
    async ({ chat_id, text }) => {
      const [platform] = chat_id.split(":");
      const deps: SendDeps = {
        safetyRail: safety,
        sendToAdapter: (method, params) => manager.sendRequest(platform, method, params),
        isAdapterConnected: () => manager.isConnected(platform),
        recordOutgoing: (draft) => {
          const self = selfByPlatform.get(draft.platform);
          if (!self) {
            console.error(`[daemon] WARN: no self identity for ${draft.platform}; using sentinel`);
          }
          const chatType = db.query<{ type: string }, [string, string]>(
            "SELECT type FROM chats WHERE platform = ? AND platform_id = ?"
          ).get(draft.platform, draft.chat.platform_id)?.type;
          if (!chatType) {
            console.error(`[daemon] WARN: chat type unknown for ${draft.platform}:${draft.chat.platform_id}; defaulting to direct`);
          }

          const event: JsonlEvent = {
            ...draft,
            chat: { platform_id: draft.chat.platform_id, type: chatType ?? "direct" },
            sender: {
              platform_id: self?.platform_id ?? "self",
              display_name: self?.display_name || "我",
            },
            received_at: Date.now(),
          };

          try {
            if (!landEvent(event)) {
              console.error(`[daemon] [${draft.platform}] outgoing already landed via echo: ${draft.platform_message_id}`);
            }
          } catch (err) {
            console.error(`[daemon] [${draft.platform}] outgoing landing failed:`, err);
          }
        },
      };
      const result = await handleSendMessage(deps, { chat_id, text });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // F23 診斷探針（dev-only、唯讀）。on-demand backfill 的 anchor 在該室最舊訊息、
  // 往回分頁，抓不到「比最後落地訊息更新」的缺口訊息；此探針不帶 before_message_id，
  // 讓 adapter fallback 到 box.lastDeliveredMessageId → 回最新 N 則，且不 ingest。
  server.tool(
    "probe_latest",
    "[F23 diagnostic, read-only] Ask the adapter for a chat's newest N messages without landing them",
    {
      chat_id: z.string().describe("Chat ID (e.g. 'line:c1234')"),
      count: z.number().optional().default(20),
    },
    async ({ chat_id, count }) => {
      const deps: ProbeDeps = {
        db,
        sendRequest: (platform, method, params) => manager.sendRequest(platform, method, params),
      };
      const result = await handleProbeLatest(deps, { chat_id, count });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "get_status",
    "Get system status: adapter connection + storage stats",
    {},
    async () => {
      const dbSize = existsSync(dbPath) ? statSync(dbPath).size / (1024 * 1024) : 0;
      const jsonlSize = existsSync(jsonlPath) ? statSync(jsonlPath).size / (1024 * 1024) : 0;

      const adaptersStatus: Record<string, { state: string; uptime_seconds?: number; last_liveness_evidence_at?: number; liveness_age_seconds?: number; rate_limit?: { remaining: number; resets_in_seconds: number } }> = {};
      const statuses = manager.getStatuses();
      for (const [platform, status] of Object.entries(statuses)) {
        const uptime = status.connected ? Math.floor((Date.now() - status.startTime) / 1000) : 0;
        adaptersStatus[platform] = {
          // `connected` here means "no evidence the stream is dead", NOT
          // "proven alive". Consumers judging trustworthiness should read
          // last_liveness_evidence_at, which only moves on real evidence.
          state: status.connected ? "connected" : manager.isKilled(platform) ? "killed" : "disconnected",
          uptime_seconds: uptime,
          ...(status.lastLivenessEvidenceAt !== undefined
            ? {
                last_liveness_evidence_at: status.lastLivenessEvidenceAt,
                liveness_age_seconds: Math.floor((Date.now() - status.lastLivenessEvidenceAt) / 1000),
              }
            : {}),
          rate_limit: { remaining: 5 - safety.rateLimiter.getCount(), resets_in_seconds: 60 },
        };
      }

      const result = handleGetStatus(db, {
        adapters: adaptersStatus,
        dbSizeMb: Math.round(dbSize * 100) / 100,
        jsonlSizeMb: Math.round(jsonlSize * 100) / 100,
        sendBlocked: safety.killSwitch.isKilled,
        ...(safety.killSwitch.killDetail !== undefined
          ? { sendBlockedReason: safety.killSwitch.killDetail }
          : {}),
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}

/**
 * Opening a chat is the signal that its history matters. The read itself never waits for
 * the network — the fetched messages arrive later on the existing push path.
 */
function triggerOnDemandBackfill(chatId: string): void {
  if (!needsBackfill(db, chatId)) return;
  void backfillChat(backfillDeps, chatId).catch((err) =>
    console.error(`[daemon] on-demand backfill ${chatId} failed:`, err)
  );
}

function registerResources(server: McpServer): () => void {
  const resourceCtx = () => {
    const adapters: Record<string, { state: string; last_liveness_evidence_at?: number; liveness_age_seconds?: number }> = {};
    const statuses = manager.getStatuses();
    for (const [platform, status] of Object.entries(statuses)) {
      adapters[platform] = {
        state: status.connected ? "connected" : "disconnected",
        ...(status.lastLivenessEvidenceAt !== undefined
          ? {
              last_liveness_evidence_at: status.lastLivenessEvidenceAt,
              liveness_age_seconds: Math.floor((Date.now() - status.lastLivenessEvidenceAt) / 1000),
            }
          : {}),
      };
    }

    return {
      adapters,
      onChatRead: triggerOnDemandBackfill,
      dbSizeMb: existsSync(dbPath) ? Math.round(statSync(dbPath).size / (1024 * 1024) * 100) / 100 : 0,
      jsonlSizeMb: existsSync(jsonlPath) ? Math.round(statSync(jsonlPath).size / (1024 * 1024) * 100) / 100 : 0,
    };
  };

  server.resource("chats", "chat://chats", { description: "All chat list" }, async (uri) => {
    const data = handleResource(db, uri.href, resourceCtx());
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: data ?? "null" }] };
  });

  const messagesTemplate = new ResourceTemplate("chat://chats/{id}/messages", { list: undefined });
  server.resource("messages", messagesTemplate, { description: "Recent messages for a chat" }, async (uri) => {
    const data = handleResource(db, uri.href, resourceCtx());
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: data ?? "null" }] };
  });

  const chatInfoTemplate = new ResourceTemplate("chat://chats/{id}/info", { list: undefined });
  server.resource("chat-info", chatInfoTemplate, { description: "Chat details" }, async (uri) => {
    const data = handleResource(db, uri.href, resourceCtx());
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: data ?? "null" }] };
  });

  server.resource("status", "chat://status", { description: "System status" }, async (uri) => {
    const data = handleResource(db, uri.href, resourceCtx());
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: data ?? "null" }] };
  });

  return registerSubscriptionHandlers(server, subscriptions);
}

/** Who "we" are on each platform, filled by the optional `get_self` request. */
const selfByPlatform = new Map<string, { platform_id: string; display_name: string }>();

async function coldStartAdapter(platform: string): Promise<void> {
  console.error(`[daemon] [${platform}] starting cold start flow...`);

  try {
    const self = await manager.sendRequest(platform, "get_self", {}) as {
      platform_id: string;
      display_name: string;
    };
    selfByPlatform.set(platform, self);
    console.error(`[daemon] [${platform}] self: ${self.display_name} (${self.platform_id})`);
  } catch (err) {
    if (isMethodNotFound(err)) {
      console.error(`[daemon] [${platform}] get_self not supported (optional), skipping`);
    } else {
      console.error(
        `[daemon] [${platform}] get_self failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  try {
    const contactsResult = await manager.sendRequest(platform, "get_contacts", {}) as {
      contacts: { platform_id: string; display_name: string }[];
    };
    console.error(`[daemon] [${platform}] fetched ${contactsResult.contacts.length} contacts`);

    for (const contact of contactsResult.contacts) {
      const upsert = db.prepare(`
        INSERT INTO contacts (platform, platform_id, display_name)
        VALUES (?, ?, ?)
        ON CONFLICT(platform, platform_id) DO UPDATE SET
          display_name = CASE
            WHEN LENGTH(excluded.display_name) > 0
              AND NOT (excluded.display_name GLOB '[uc][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*')
            THEN excluded.display_name
            WHEN LENGTH(contacts.display_name) > 0
            THEN contacts.display_name
            ELSE excluded.display_name
          END,
          updated_at = (unixepoch('now', 'subsec') * 1000)
      `);
      upsert.run(platform, contact.platform_id, contact.display_name);
    }
  } catch (err) {
    console.error(`[daemon] [${platform}] get_contacts failed:`, err);
  }

  try {
    const chatsResult = await manager.sendRequest(platform, "get_chats", {}) as {
      chats: AdapterChat[];
    };
    console.error(`[daemon] [${platform}] fetched ${chatsResult.chats.length} chats`);

    upsertChatsFromAdapter(db, platform, chatsResult.chats);
  } catch (err) {
    console.error(`[daemon] [${platform}] get_chats failed:`, err);
  }

  try {
    const boxes = await manager.sendRequest(platform, "get_message_boxes", {}) as {
      id: string;
      lastDeliveredTime: number;
    }[];
    console.error(`[daemon] [${platform}] discovered ${boxes.length} active conversations (incl. 1:1)`);

    // get_message_boxes only refines recency for chats get_chats already reported.
    //
    // It used to insert unknown boxes with `contactName ? "direct" : "group"`,
    // i.e. guessing the type from whether a contact display name was cached.
    // That holds on LINE (1799 contacts) and breaks anywhere contacts are
    // sparse — on Telegram get_contacts returns nothing at all, so every DM
    // would have been filed as a group. There is no honest type to guess here
    // (the column is NOT NULL CHECK IN ('direct','group','room')), so an
    // unknown box is reported as a gap in get_chats instead of invented.
    const unknown = applyMessageBoxRecency(db, platform, boxes);

    if (unknown > 0) {
      console.error(
        `[daemon] [${platform}] WARN: ${unknown} message box(es) refer to chats absent from get_chats — ` +
        `skipped (get_chats must report every chat and its type)`,
      );
    }
  } catch (err) {
    if (isMethodNotFound(err)) {
      console.error(`[daemon] [${platform}] get_message_boxes not supported (optional), skipping`);
    } else {
      console.error(
        `[daemon] [${platform}] get_message_boxes failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  await backfillAdapter(platform);
}

async function backfillAdapter(platform: string): Promise<void> {
  await catchUpAdapter(
    {
      db,
      sendRequest: (p, method, params) => manager.sendRequest(p, method, params),
      ingest: (p, event, source) => ingestBackfill(p, event as JsonlEvent, source),
    },
    platform,
  );
}

/**
 * Re-project the log from the last checkpoint so SQLite catches up on anything the last run
 * dropped.
 *
 * Replaying a fixed tail of 100 lines assumed the only gap is "what arrived while the daemon
 * was down". That holds for a normal restart and fails silently twice over: a rebuilt database
 * recovers only its last hundred lines, and a long stop (backfill produces thousands of lines
 * an hour) loses the middle. The checkpoint in `sync_state` makes the gap exact.
 *
 * Replaying unconditionally — rather than hunting for "missing" messages — is correct because
 * every branch of the projection is idempotent: messages via INSERT OR IGNORE, unsend by
 * refusing to re-stamp an already retracted row, edits by short-circuiting when content and
 * edited_at already match. The earlier missing-message test was meaningless for change events,
 * since an edit's target row exists by definition and was therefore never replayed.
 */
function syncCheck(): void {
  const result = replayFrom(db, jsonl);
  if (result.events === 0) return;

  console.error(
    `[daemon] sync check: replayed ${result.events} events in ${result.batches} batches (offset → ${result.finalOffset})`,
  );
}

// 執行期的 async 漏網不該打掉整個長駐 service（所有 MCP 連線斷掉 + 冷啟動重跑 backfill）。
// 大聲記錄後繼續跑。不加 uncaughtException——同步例外代表 call stack 已在未知狀態中斷，
// 帶病續跑比重啟危險。main().catch 的 exit(1) 保留：那是啟動失敗，該死。
process.on("unhandledRejection", (reason) => {
  console.error(
    "[daemon] UNHANDLED REJECTION (daemon stays up; investigate):",
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  );
});

async function main(): Promise<void> {
  console.error("[daemon] starting adapters...");

  try {
    await manager.startAll();
    console.error("[daemon] all adapters protocol initialized, waiting for connections...");

    // Wait up to 120s for adapters to connect
    const connectedPlatforms: string[] = [];

    const waitForConnections = new Promise<void>((resolve) => {
      let remaining = manager.platforms.length;
      if (remaining === 0) { resolve(); return; }

      const checkDone = () => {
        remaining--;
        if (remaining <= 0) resolve();
      };

      manager.onStatus((platform, params) => {
        const status = params as { state: string };
        if (status.state === "connected" && !connectedPlatforms.includes(platform)) {
          connectedPlatforms.push(platform);
          checkDone();
        }
      });
    });

    const loginTimeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 120_000),
    );
    const result = await Promise.race([waitForConnections, loginTimeout]);

    if (result === "timeout") {
      console.error(`[daemon] login timeout (120s). Connected: [${connectedPlatforms.join(", ")}]`);
    }

    for (const platform of connectedPlatforms) {
      try {
        await coldStartAdapter(platform);
      } catch (err) {
        console.error(`[daemon] [${platform}] cold start failed:`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error("[daemon] adapter start failed (MCP server will start without adapter):", err instanceof Error ? err.message : err);
  }

  console.error("[daemon] starting MCP server...");
  const closeMcp = await startMcpServer(
    { socketPath, port: mcpPort, host: mcpHost },
    { registerTools, registerResources },
  );
  console.error("[daemon] MCP server started");

  const shutdown = async (signal: string) => {
    console.error(`\n[daemon] ${signal} received, shutting down...`);
    closeMcp();
    await manager.shutdownAll();
    db.close();
    jsonl.close();
    console.error("[daemon] shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[daemon] fatal:", err);
  process.exit(1);
});
