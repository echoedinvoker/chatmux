import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startMcpServer } from "../../src/core/mcp/server";
import {
  ResourceSubscriptionManager,
  registerSubscriptionHandlers,
} from "../../src/core/mcp/resources";

const TEST_DIR = join(import.meta.dir, "../../.test-mcp-subscribe-tmp");
const SOCKET_PATH = join(TEST_DIR, "test.sock");
// High port, distinct from the real daemon (7717) and from mcp-server.test.ts (47717).
const TCP_PORT = 47718;
const BASE_URL = `http://127.0.0.1:${TCP_PORT}/mcp`;

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

// The trigger source under test. The fixture wires this into every session the same way
// daemon.ts wires its own module-level `subscriptions`, so the code path being asserted
// is the shipped one — daemon.ts itself cannot be imported (module-level side effects
// open the DB and build an AdapterManager).
const subscriptionsUnderTest = new ResourceSubscriptionManager();

function registerTools(): void {
  // This suite is about resource subscription, not tools.
}

function registerResources(server: McpServer): () => void {
  server.resource("chats", "chat://chats", { description: "All chat list" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: "[]" }],
  }));

  // The same function daemon.ts calls — not a re-implementation of it.
  return registerSubscriptionHandlers(server, subscriptionsUnderTest);
}

/** MCP Streamable HTTP responses may be JSON or an SSE stream — normalize both. */
async function readJsonRpc(res: Response): Promise<Record<string, unknown>> {
  const body = await res.text();
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const dataLine = body.split("\n").find((l) => l.startsWith("data:"));
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

// Time to wait after A's notification before declaring B empty. A and B are fed by the
// same synchronous loop (resources.ts `for (const fn of this.listeners)`), so if B were
// going to receive anything it would arrive within the same event-loop turn plus one SSE
// flush. 500ms is orders of magnitude above that path — this asserts *whether* a
// notification is sent, not how fast.
const QUIET_WINDOW_MS = 500;

describe("MCP resource subscription", () => {
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

  test("initialize declares resources.subscribe", async () => {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(INITIALIZE_BODY),
    });
    const json = await readJsonRpc(res);
    const caps = (json.result as { capabilities: { resources?: Record<string, unknown> } })
      .capabilities;
    expect(caps.resources?.listChanged).toBe(true);
    expect(caps.resources?.subscribe).toBe(true);
  });

  /** Open a session and return its id plus a live queue of the notifications it receives. */
  async function openSession() {
    const init = await fetch(BASE_URL, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(INITIALIZE_BODY),
    });
    const sessionId = init.headers.get("mcp-session-id")!;
    await readJsonRpc(init);

    const notes: Record<string, unknown>[] = [];
    const sse = await fetch(BASE_URL, {
      method: "GET",
      headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    });
    const reader = sse.body!.getReader();
    void (async () => {
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) {
          if (l.startsWith("data:")) notes.push(JSON.parse(l.slice(5).trim()));
        }
      }
    })().catch(() => {});

    // Cancelling the SSE stream only tears down that one channel (SDK
    // webStandardStreamableHttp.js:222-224). Terminating the *session* — the thing that
    // fires transport.onclose — is an HTTP DELETE, per the MCP spec.
    const close = async () => {
      await reader.cancel();
      await fetch(BASE_URL, {
        method: "DELETE",
        headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
      });
    };

    return { sessionId, notes, close };
  }

  const updates = (ns: Record<string, unknown>[]) =>
    ns.filter((n) => n.method === "notifications/resources/updated");

  test("a session that did not subscribe receives nothing", async () => {
    const a = await openSession();
    const b = await openSession();

    const sub = await fetch(BASE_URL, {
      method: "POST",
      headers: { ...MCP_HEADERS, "mcp-session-id": a.sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/subscribe",
        params: { uri: "chat://chats" },
      }),
    });
    const subJson = await readJsonRpc(sub);
    expect(subJson.error).toBeUndefined();

    subscriptionsUnderTest.notifyMessageReceived("telegram:1");
    await Bun.sleep(QUIET_WINDOW_MS);

    expect(updates(a.notes).map((n) => (n.params as { uri: string }).uri)).toContain(
      "chat://chats",
    );
    expect(updates(b.notes)).toHaveLength(0);

    await a.close();
    await b.close();
  });

  test("notifying a server that just closed does not become an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onRejection = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onRejection);
    try {
      const s = await openSession();
      await fetch(BASE_URL, {
        method: "POST",
        headers: { ...MCP_HEADERS, "mcp-session-id": s.sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "resources/subscribe",
          params: { uri: "chat://chats" },
        }),
      });
      // Deliberately not awaited: the notification is fired while the session is being
      // torn down but before its cleanup has run. That window is the race.
      void s.close();
      subscriptionsUnderTest.notifyMessageReceived("telegram:1");
      await Bun.sleep(QUIET_WINDOW_MS);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toHaveLength(0);
  });

  test("closing a session drops its update listener", async () => {
    const before = subscriptionsUnderTest.listenerCount;
    const sessions = [await openSession(), await openSession(), await openSession()];
    expect(subscriptionsUnderTest.listenerCount).toBe(before + 3);

    for (const s of sessions) await s.close();
    // transport.onclose only fires once the SSE reader is cancelled; give it a turn.
    await Bun.sleep(QUIET_WINDOW_MS);

    expect(subscriptionsUnderTest.listenerCount).toBe(before);
  });
});
