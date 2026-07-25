import { resolve, join } from "node:path";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { JsonlWriter, type JsonlEvent } from "./storage/jsonl.js";
import { initSchema, syncEventToSQLite } from "./storage/sqlite.js";
import { initFTS } from "./storage/fts.js";
import { makeLandEvent } from "./storage/land-event.js";
import { makeIngestEvent } from "./ingest.js";
import { SafetyRail } from "./safety.js";
import { isMethodNotFound, type SpawnResult } from "./adapter-runner.js";
import { AdapterManager } from "./adapter-manager.js";
import { loadAdapterConfigs, loadMcpPort } from "./config.js";
import { startMcpServer } from "./mcp/server.js";
import {
  handleListChats,
  handleReadMessages,
  handleReadEvents,
  handleSearchMessages,
  handleSendMessage,
  handleGetStatus,
  type SendDeps,
} from "./mcp/tools.js";
import { handleResource, ResourceSubscriptionManager } from "./mcp/resources.js";

const dataDir = resolve(
  process.env.CHATMUX_DATA_DIR ?? join(process.env.HOME ?? "~", ".local/share/chatmux"),
);
const socketPath =
  process.env.CHATMUX_SOCKET ?? join(dataDir, "chatmux.sock");

mkdirSync(dataDir, { recursive: true });

const mcpPort = loadMcpPort(dataDir);

console.error(`[daemon] data dir: ${dataDir}`);
console.error(`[daemon] socket: ${socketPath}`);
console.error(
  `[daemon] mcp tcp: ${mcpPort > 0 ? `127.0.0.1:${mcpPort}` : "disabled (unix socket only)"}`,
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

// live 走 landEvent（含跨路徑去重）；backfill 維持原本的直寫，不進 dedup map
// （量大會把 map 灌爆，且它本來就靠 SQLite 的 INSERT OR IGNORE）。
const ingestLive = makeIngestEvent({ land: landEvent });
const ingestBackfill = makeIngestEvent({
  land: (event) => {
    jsonl.append(event);
    syncEventToSQLite(db, event);
    return true;
  },
});

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

manager.onStatus((platform: string, params: unknown) => {
  const status = params as { state: string };
  console.error(`[daemon] [${platform}] adapter status: ${status.state}`);
});

manager.onError((platform: string, params: unknown) => {
  console.error(`[daemon] [${platform}] adapter error:`, params);
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

  server.tool(
    "get_status",
    "Get system status: adapter connection + storage stats",
    {},
    async () => {
      const dbSize = existsSync(dbPath) ? statSync(dbPath).size / (1024 * 1024) : 0;
      const jsonlSize = existsSync(jsonlPath) ? statSync(jsonlPath).size / (1024 * 1024) : 0;

      const adaptersStatus: Record<string, { state: string; uptime_seconds?: number; rate_limit?: { remaining: number; resets_in_seconds: number } }> = {};
      const statuses = manager.getStatuses();
      for (const [platform, status] of Object.entries(statuses)) {
        const uptime = status.connected ? Math.floor((Date.now() - status.startTime) / 1000) : 0;
        adaptersStatus[platform] = {
          state: status.connected ? "connected" : manager.isKilled(platform) ? "killed" : "disconnected",
          uptime_seconds: uptime,
          rate_limit: { remaining: 5 - safety.rateLimiter.getCount(), resets_in_seconds: 60 },
        };
      }

      const result = handleGetStatus(db, {
        adapters: adaptersStatus,
        dbSizeMb: Math.round(dbSize * 100) / 100,
        jsonlSizeMb: Math.round(jsonlSize * 100) / 100,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}

function registerResources(server: McpServer): void {
  const resourceCtx = () => {
    const adapters: Record<string, { state: string }> = {};
    const statuses = manager.getStatuses();
    for (const [platform, status] of Object.entries(statuses)) {
      adapters[platform] = { state: status.connected ? "connected" : "disconnected" };
    }

    return {
      adapters,
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

  subscriptions.onUpdate((resourceUri) => {
    server.server.notification({
      method: "notifications/resources/updated",
      params: { uri: resourceUri },
    });
  });
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
      chats: { platform_id: string; type: string; name: string; last_message_at?: number | null }[];
    };
    console.error(`[daemon] [${platform}] fetched ${chatsResult.chats.length} chats`);

    for (const chat of chatsResult.chats) {
      // last_message_at is the optional backfill ordering signal (protocol v0.3).
      // MAX so a null from a v0.2 adapter never clobbers a known value; NULLIF
      // keeps "no signal at all" as NULL rather than epoch 0, so a degraded
      // ordering stays visible instead of masquerading as a real timestamp.
      const upsert = db.prepare(`
        INSERT INTO chats (platform, platform_id, type, name, last_message_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(platform, platform_id) DO UPDATE SET
          name = COALESCE(excluded.name, chats.name),
          last_message_at = NULLIF(MAX(
            COALESCE(chats.last_message_at, 0),
            COALESCE(excluded.last_message_at, 0)
          ), 0),
          updated_at = (unixepoch('now', 'subsec') * 1000)
      `);
      upsert.run(platform, chat.platform_id, chat.type, chat.name, chat.last_message_at ?? null);
    }
  } catch (err) {
    console.error(`[daemon] [${platform}] get_chats failed:`, err);
  }

  try {
    const boxes = await manager.sendRequest(platform, "get_message_boxes", {}) as {
      id: string;
      lastDeliveredTime: number;
    }[];
    console.error(`[daemon] [${platform}] discovered ${boxes.length} active conversations (incl. 1:1)`);

    // get_chats is the sole authority on which chats exist and what type they
    // are. get_message_boxes only refines recency for chats already known.
    //
    // It used to insert unknown boxes with `contactName ? "direct" : "group"`,
    // i.e. guessing the type from whether a contact display name was cached.
    // That holds on LINE (1799 contacts) and breaks anywhere contacts are
    // sparse — on Telegram get_contacts returns nothing at all, so every DM
    // would have been filed as a group. There is no honest type to guess here
    // (the column is NOT NULL CHECK IN ('direct','group','room')), so an
    // unknown box is reported as a gap in get_chats instead of invented.
    let unknown = 0;
    for (const box of boxes) {
      const updated = db.prepare(`
        UPDATE chats SET last_message_at = MAX(COALESCE(last_message_at, 0), ?)
        WHERE platform_id = ? AND platform = ?
      `).run(box.lastDeliveredTime || null, box.id, platform);

      if (updated.changes === 0) unknown++;
    }

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
  const chats = db.query<{ platform_id: string; last_message_at: number | null }, [string]>(
    "SELECT platform_id, last_message_at FROM chats WHERE platform = ? ORDER BY last_message_at DESC NULLS LAST"
  ).all(platform);

  let totalBackfilled = 0;
  const PER_CHAT_BATCH = 50;
  const GLOBAL_TARGET = 500;

  for (const chat of chats) {
    if (totalBackfilled >= GLOBAL_TARGET) break;

    try {
      const result = await manager.sendRequest(platform, "backfill", {
        chat_id: chat.platform_id,
        before_timestamp: Date.now(),
        count: PER_CHAT_BATCH,
      }) as { events: JsonlEvent[]; has_more: boolean };

      for (const event of result.events) {
        ingestBackfill(platform, event, "backfill");
      }

      // 維持 result.events.length：這是對上游平台的請求配額語意（GLOBAL_TARGET），
      // 不是落地筆數。改成只計已落地會讓同樣預算向平台多要訊息。
      totalBackfilled += result.events.length;
      console.error(`[daemon] [${platform}] backfill ${chat.platform_id}: ${result.events.length} msgs (total: ${totalBackfilled})`);
    } catch (err) {
      console.error(`[daemon] [${platform}] backfill ${chat.platform_id} failed:`, err);
    }
  }

  console.error(`[daemon] [${platform}] cold start complete. ${totalBackfilled} messages backfilled.`);
}

function syncCheck(): void {
  const tailEvents = jsonl.readTailLines(100);
  if (tailEvents.length === 0) return;

  const platformIds = tailEvents
    .filter((e) => e.type === "message")
    .map((e) => e.platform_message_id);

  if (platformIds.length === 0) return;

  const placeholders = platformIds.map(() => "?").join(",");
  const found = db
    .query<{ platform_message_id: string }, string[]>(
      `SELECT platform_message_id FROM messages WHERE platform_message_id IN (${placeholders})`
    )
    .all(...platformIds);

  const foundSet = new Set(found.map((r) => r.platform_message_id));
  const missing = platformIds.filter((id) => !foundSet.has(id));

  if (missing.length > 0) {
    console.error(`[daemon] sync check: ${missing.length} JSONL events missing from SQLite, re-syncing...`);
    for (const event of tailEvents) {
      if (event.type === "message" && missing.includes(event.platform_message_id)) {
        syncEventToSQLite(db, event);
      }
    }
    console.error("[daemon] sync check: re-sync complete");
  } else {
    console.error("[daemon] sync check: OK");
  }
}

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
    { socketPath, port: mcpPort },
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
