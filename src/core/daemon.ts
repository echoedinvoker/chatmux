import { resolve, join } from "node:path";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { JsonlWriter, type JsonlEvent } from "./storage/jsonl.js";
import { initSchema, syncEventToSQLite } from "./storage/sqlite.js";
import { initFTS } from "./storage/fts.js";
import { SafetyRail } from "./safety.js";
import { AdapterRunner, type SpawnResult } from "./adapter-runner.js";
import { startMcpServer } from "./mcp/server.js";
import {
  handleListChats,
  handleReadMessages,
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

console.error(`[daemon] data dir: ${dataDir}`);
console.error(`[daemon] socket: ${socketPath}`);

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

let adapterConnected = false;
let adapterStartTime = 0;
let adapterConnectedResolve: (() => void) | null = null;
const adapterConnectedPromise = new Promise<void>((resolve) => {
  adapterConnectedResolve = resolve;
});

const runner = new AdapterRunner({
  command: ["node", "--import", "tsx", resolve(import.meta.dir, "../adapters/line/index.ts")],
  platform: "line",
  dataDir,
  spawn: (cmd) => {
    const proc = spawn(cmd[0], cmd.slice(1), {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: resolve(import.meta.dir, "../.."),
    });
    const exitListeners: ((code: number) => void)[] = [];
    proc.on("exit", (code) => {
      adapterConnected = false;
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
  },
  safetyRail: safety,
});

runner.onEvent(async (params: unknown) => {
  const event = params as JsonlEvent;
  event.source = "live";
  event.received_at = Date.now();
  if (!event.sender.display_name) {
    console.error("[daemon] WARN: event missing display_name", event.sender.platform_id);
  }

  try {
    jsonl.append(event);
    syncEventToSQLite(db, event);

    const chatCompositeId = `${event.platform}:${event.chat.platform_id}`;
    subscriptions.notifyMessageReceived(chatCompositeId);

    console.error(`[daemon] event: ${event.content.type} from ${event.sender.display_name}`);
  } catch (err) {
    console.error("[daemon] event processing error:", err);
  }
});

runner.onStatus((params) => {
  const status = params as { state: string };
  console.error(`[daemon] adapter status: ${status.state}`);
  if (status.state === "connected") {
    adapterConnected = true;
    adapterStartTime = Date.now();
    if (adapterConnectedResolve) {
      adapterConnectedResolve();
      adapterConnectedResolve = null;
    }
  }
});

runner.onError((params) => {
  console.error("[daemon] adapter error:", params);
});

runner.onKill(() => {
  console.error("[daemon] adapter killed after repeated crashes");
  adapterConnected = false;
});

function registerTools(server: McpServer): void {
  server.tool(
    "list_chats",
    "List all chats with last message preview",
    {
      platform: z.string().optional().describe("Filter by platform (e.g. 'line')"),
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
      chat_id: z.string().describe("Chat ID (e.g. 'line:c1234')"),
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
      chat_id: z.string().describe("Target chat ID (e.g. 'line:c1234')"),
      text: z.string().describe("Message text to send"),
    },
    async ({ chat_id, text }) => {
      const deps: SendDeps = {
        safetyRail: safety,
        sendToAdapter: (method, params) => runner.sendRequest(method, params),
        isAdapterConnected: () => adapterConnected,
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
      const uptime = adapterConnected ? Math.floor((Date.now() - adapterStartTime) / 1000) : 0;

      const result = handleGetStatus(db, {
        adapters: {
          line: {
            state: adapterConnected ? "connected" : runner.isKilled ? "killed" : "disconnected",
            uptime_seconds: uptime,
            rate_limit: { remaining: 5 - safety.rateLimiter.getCount(), resets_in_seconds: 60 },
          },
        },
        dbSizeMb: Math.round(dbSize * 100) / 100,
        jsonlSizeMb: Math.round(jsonlSize * 100) / 100,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}

function registerResources(server: McpServer): void {
  const resourceCtx = () => ({
    adapters: {
      line: {
        state: adapterConnected ? "connected" : "disconnected",
      },
    },
    dbSizeMb: existsSync(dbPath) ? Math.round(statSync(dbPath).size / (1024 * 1024) * 100) / 100 : 0,
    jsonlSizeMb: existsSync(jsonlPath) ? Math.round(statSync(jsonlPath).size / (1024 * 1024) * 100) / 100 : 0,
  });

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

async function coldStart(): Promise<void> {
  console.error("[daemon] starting cold start flow...");

  try {
    const contactsResult = await runner.sendRequest("get_contacts", {}) as {
      contacts: { platform_id: string; display_name: string }[];
    };
    console.error(`[daemon] fetched ${contactsResult.contacts.length} contacts`);

    for (const contact of contactsResult.contacts) {
      const upsert = db.prepare(`
        INSERT INTO contacts (platform, platform_id, display_name)
        VALUES ('line', ?, ?)
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
      upsert.run(contact.platform_id, contact.display_name);
    }
  } catch (err) {
    console.error("[daemon] get_contacts failed:", err);
  }

  try {
    const chatsResult = await runner.sendRequest("get_chats", {}) as {
      chats: { platform_id: string; type: string; name: string }[];
    };
    console.error(`[daemon] fetched ${chatsResult.chats.length} chats`);

    for (const chat of chatsResult.chats) {
      const upsert = db.prepare(`
        INSERT INTO chats (platform, platform_id, type, name)
        VALUES ('line', ?, ?, ?)
        ON CONFLICT(platform, platform_id) DO UPDATE SET
          name = COALESCE(excluded.name, chats.name),
          updated_at = (unixepoch('now', 'subsec') * 1000)
      `);
      upsert.run(chat.platform_id, chat.type, chat.name);
    }
  } catch (err) {
    console.error("[daemon] get_chats failed:", err);
  }

  try {
    const boxes = await runner.sendRequest("get_message_boxes", {}) as {
      id: string;
      lastDeliveredTime: number;
    }[];
    console.error(`[daemon] discovered ${boxes.length} active conversations (incl. 1:1)`);

    for (const box of boxes) {
      const isGroup = box.id.startsWith("c");
      const exists = db.query<{ id: number }, [string]>(
        "SELECT id FROM chats WHERE platform_id = ?"
      ).get(box.id);

      if (exists) {
        db.prepare(`
          UPDATE chats SET last_message_at = MAX(COALESCE(last_message_at, 0), ?)
          WHERE platform_id = ? AND platform = 'line'
        `).run(box.lastDeliveredTime || null, box.id);
      } else {
        const contactName = db.query<{ display_name: string }, [string]>(
          "SELECT display_name FROM contacts WHERE platform_id = ?"
        ).get(box.id);

        db.prepare(`
          INSERT OR IGNORE INTO chats (platform, platform_id, type, name, last_message_at)
          VALUES ('line', ?, ?, ?, ?)
        `).run(
          box.id,
          isGroup ? "group" : "direct",
          contactName?.display_name ?? null,
          box.lastDeliveredTime || null,
        );
      }
    }
  } catch (err) {
    console.error("[daemon] get_message_boxes failed:", err instanceof Error ? err.message : err);
  }

  await backfill();
}

async function backfill(): Promise<void> {
  const chats = db.query<{ platform_id: string; last_message_at: number | null }, []>(
    "SELECT platform_id, last_message_at FROM chats WHERE platform = 'line' ORDER BY last_message_at DESC NULLS LAST"
  ).all();

  let totalBackfilled = 0;
  const PER_CHAT_BATCH = 50;
  const GLOBAL_TARGET = 500;

  for (const chat of chats) {
    if (totalBackfilled >= GLOBAL_TARGET) break;

    try {
      const result = await runner.sendRequest("backfill", {
        chat_id: chat.platform_id,
        before_timestamp: Date.now(),
        count: PER_CHAT_BATCH,
      }) as { events: JsonlEvent[]; has_more: boolean };

      for (const event of result.events) {
        event.source = "backfill";
        event.received_at = Date.now();
        if (!event.sender.display_name) {
          console.error("[daemon] WARN: backfill event missing display_name", event.sender.platform_id);
        }
        jsonl.append(event);
        syncEventToSQLite(db, event);
      }

      totalBackfilled += result.events.length;
      console.error(`[daemon] backfill ${chat.platform_id}: ${result.events.length} msgs (total: ${totalBackfilled})`);
    } catch (err) {
      console.error(`[daemon] backfill ${chat.platform_id} failed:`, err);
    }
  }

  console.error(`[daemon] cold start complete. ${totalBackfilled} messages backfilled.`);
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
  console.error("[daemon] starting adapter...");
  try {
    await runner.start();
    console.error("[daemon] adapter protocol initialized, waiting for LINE login...");

    const loginTimeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 120_000),
    );
    const result = await Promise.race([adapterConnectedPromise, loginTimeout]);

    if (result === "timeout") {
      console.error("[daemon] LINE login timeout (120s). MCP server will start without cold start.");
    } else {
      console.error("[daemon] adapter connected");
      await coldStart();
    }
  } catch (err) {
    console.error("[daemon] adapter start failed (MCP server will start without adapter):", err instanceof Error ? err.message : err);
    adapterConnected = false;
  }

  console.error("[daemon] starting MCP server...");
  const closeMcp = await startMcpServer(socketPath, { registerTools, registerResources });
  console.error("[daemon] MCP server started");

  const shutdown = async (signal: string) => {
    console.error(`\n[daemon] ${signal} received, shutting down...`);
    closeMcp();
    await runner.stop();
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
