import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export interface McpServerDeps {
  registerTools: (server: McpServer) => void;
  registerResources: (server: McpServer) => void;
}

export interface McpListenOptions {
  /** Unix socket path — for same-host sidecar/plugin consumers (e.g. chat.nvim). */
  socketPath: string;
  /**
   * TCP port bound to 127.0.0.1 — for standard MCP clients (Claude Code), which
   * only speak stdio or streamable HTTP. Omit or set 0 to disable.
   */
  port?: number;
}

export async function startMcpServer(
  listen: McpListenOptions,
  deps: McpServerDeps,
): Promise<() => void> {
  const sessions = new Map<string, Session>();

  function createMcp(): McpServer {
    const server = new McpServer({
      name: "chatmux",
      version: "0.1.0",
    });
    deps.registerTools(server);
    deps.registerResources(server);
    return server;
  }

  // Named handler so every listener (unix socket + TCP) shares one request path
  // and one `sessions` map.
  async function handleMcpRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      try {
        await sessions.get(sessionId)!.transport.handleRequest(req, res);
      } catch (err) {
        console.error("[MCP] request error:", err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end("Internal server error");
        }
      }
      return;
    }

    if (sessionId) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session not found" },
      }));
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server });
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };
    const server = createMcp();
    await server.connect(transport);

    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[MCP] request error:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal server error");
      }
    }
  }

  const { socketPath, port } = listen;
  const listeners: Server[] = [];

  if (existsSync(socketPath)) unlinkSync(socketPath);

  const unixServer = createServer(handleMcpRequest);
  await listenOn(unixServer, socketPath);
  listeners.push(unixServer);
  console.error(`[MCP] listening on unix socket ${socketPath}`);

  if (port && port > 0) {
    const tcpServer = createServer(handleMcpRequest);
    // Loopback only — never bind the wildcard address; this exposes all chat history.
    await listenOn(tcpServer, { port, host: "127.0.0.1" });
    listeners.push(tcpServer);
    console.error(`[MCP] listening on http://127.0.0.1:${port}/mcp`);
  }

  return () => {
    for (const l of listeners) l.close();
    for (const s of sessions.values()) s.server.close();
    sessions.clear();
  };
}

function listenOn(
  server: Server,
  target: string | { port: number; host: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onStartupError = (err: Error) => reject(err);
    server.once("error", onStartupError);

    const onListening = () => {
      server.removeListener("error", onStartupError);
      server.on("error", (err) => console.error("[MCP] server error:", err));
      resolve();
    };

    if (typeof target === "string") server.listen(target, onListening);
    else server.listen(target.port, target.host, onListening);
  });
}
