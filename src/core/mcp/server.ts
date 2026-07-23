import { createServer, type Server } from "node:http";
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

export async function startMcpServer(
  socketPath: string,
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

  const httpServer: Server = createServer(async (req, res) => {
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
  });

  if (existsSync(socketPath)) unlinkSync(socketPath);

  return new Promise((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(socketPath, () => {
      console.error(`[MCP] server listening on ${socketPath}`);
      resolve(() => {
        httpServer.close();
        for (const s of sessions.values()) s.server.close();
        sessions.clear();
      });
    });
  });
}
