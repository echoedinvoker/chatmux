import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startMcpServer } from "../../src/core/mcp/server";

const TEST_DIR = join(import.meta.dir, "../../.test-mcp-server-tmp");
const SOCKET_PATH = join(TEST_DIR, "test.sock");
// High port, unlikely to collide with the real daemon (7717) or anything else.
const TCP_PORT = 47717;
const BASE_URL = `http://127.0.0.1:${TCP_PORT}/mcp`;

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

// Stubs, not the daemon's real registrations — this suite is about transport. Kept in
// sync with daemon.ts registerTools() so the list does not quietly drift.
const TOOL_NAMES = [
  "list_chats",
  "read_messages",
  "read_events",
  "search_messages",
  "send_message",
  "get_status",
];

function registerTools(server: McpServer): void {
  for (const name of TOOL_NAMES) {
    server.tool(name, `stub ${name}`, { arg: z.string().optional() }, async () => ({
      content: [{ type: "text" as const, text: "{}" }],
    }));
  }
}

function registerResources(): void {
  // Resources are covered by mcp-tools.test.ts; this suite is about transport.
}

/** MCP Streamable HTTP responses may be JSON or an SSE stream — normalize both. */
async function readJsonRpc(res: Response): Promise<Record<string, unknown>> {
  const body = await res.text();
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const dataLine = body
      .split("\n")
      .find((l) => l.startsWith("data:"));
    if (!dataLine) throw new Error(`no SSE data frame in: ${body}`);
    return JSON.parse(dataLine.slice(5).trim());
  }
  return JSON.parse(body);
}

const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  },
};

describe("MCP server transports", () => {
  let close: () => void;

  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    close = await startMcpServer(
      { socketPath: SOCKET_PATH, port: TCP_PORT },
      { registerTools, registerResources },
    );
  });

  afterAll(() => {
    close?.();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("TCP: initialize returns a session id", async () => {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(INITIALIZE_BODY),
    });

    expect(res.status).toBe(200);
    const sessionId = res.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const json = await readJsonRpc(res);
    expect((json.result as { serverInfo: { name: string } }).serverInfo.name).toBe("chatmux");
  });

  test("TCP: tools/list returns every registered tool", async () => {
    const initRes = await fetch(BASE_URL, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(INITIALIZE_BODY),
    });
    const sessionId = initRes.headers.get("mcp-session-id")!;
    await initRes.text();

    await fetch(BASE_URL, {
      method: "POST",
      headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });

    expect(res.status).toBe(200);
    const json = await readJsonRpc(res);
    const tools = (json.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  test("TCP: non-/mcp path returns 404", async () => {
    const res = await fetch(`http://127.0.0.1:${TCP_PORT}/nope`);
    expect(res.status).toBe(404);
  });

  test("TCP: unknown session id returns JSON-RPC error", async () => {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: { ...MCP_HEADERS, "mcp-session-id": "does-not-exist" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect((json.error as { code: number }).code).toBe(-32000);
  });

  test("unix socket still works (chat.nvim sidecar path must not regress)", async () => {
    const res = await fetch("http://localhost/mcp", {
      unix: SOCKET_PATH,
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(INITIALIZE_BODY),
    } as RequestInit);

    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
    const json = await readJsonRpc(res);
    expect((json.result as { serverInfo: { name: string } }).serverInfo.name).toBe("chatmux");
  });

  test("TCP listener binds loopback only, not the wildcard address", async () => {
    // `ss -ltnH` columns: State Recv-Q Send-Q Local-Address:Port Peer-Address:Port
    // Only the *local* address matters; the peer column is always 0.0.0.0:* for a listener.
    const proc = Bun.spawnSync(["ss", "-ltnH", `sport = :${TCP_PORT}`]);
    const rows = proc.stdout
      .toString()
      .split("\n")
      .filter((l) => l.trim() !== "");

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const localAddr = row.trim().split(/\s+/)[3];
      expect(localAddr).toBe(`127.0.0.1:${TCP_PORT}`);
    }
  });
});

describe("MCP server without TCP port", () => {
  test("port omitted: unix socket only, nothing listening on TCP", async () => {
    const dir = join(import.meta.dir, "../../.test-mcp-nosock-tmp");
    mkdirSync(dir, { recursive: true });
    const sock = join(dir, "unix-only.sock");

    const close = await startMcpServer(
      { socketPath: sock },
      { registerTools, registerResources },
    );

    try {
      const res = await fetch("http://localhost/mcp", {
        unix: sock,
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify(INITIALIZE_BODY),
      } as RequestInit);
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
