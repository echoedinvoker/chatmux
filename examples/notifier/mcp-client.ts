/**
 * Minimal MCP Streamable HTTP client — raw fetch, no SDK.
 *
 * Deliberately dependency-free so this file doubles as the wire-protocol reference
 * for consumers written in any language: it is all HTTP + JSON-RPC 2.0.
 *
 * This file must never import from `src/core/` (NEVER #11). A consumer that reaches
 * into core internals stops exercising the MCP boundary, which is the only reason
 * this example is worth keeping.
 */

const PROTOCOL_VERSION = "2025-06-18";

export interface ChatmuxEndpoint {
  /** Unix socket path, e.g. ~/.local/share/chatmux/chatmux.sock */
  socketPath?: string;
  /** TCP URL, e.g. http://127.0.0.1:7717/mcp */
  url?: string;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

/** MCP Streamable HTTP replies with either JSON or a single SSE frame. */
async function readJsonRpc(res: Response): Promise<JsonRpcResponse> {
  const body = await res.text();
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const dataLine = body.split("\n").find(l => l.startsWith("data:"));
    if (!dataLine) throw new Error(`no SSE data frame in: ${body}`);
    return JSON.parse(dataLine.slice(5).trim());
  }
  return JSON.parse(body);
}

export class McpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private readonly url: string;
  private readonly unix?: string;

  constructor(endpoint: ChatmuxEndpoint) {
    if (endpoint.socketPath) {
      // Bun's fetch takes a `unix` option; the host in the URL is ignored.
      this.url = "http://localhost/mcp";
      this.unix = endpoint.socketPath;
    } else if (endpoint.url) {
      this.url = endpoint.url;
    } else {
      throw new Error("endpoint requires either socketPath or url");
    }
  }

  private async post(body: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const init: RequestInit & { unix?: string } = {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    };
    if (this.unix) init.unix = this.unix;

    return fetch(this.url, init as RequestInit);
  }

  async connect(): Promise<void> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "chatmux-notifier-example", version: "0.1.0" },
      },
    });

    if (!res.ok) {
      throw new Error(`initialize failed: HTTP ${res.status} ${await res.text()}`);
    }

    this.sessionId = res.headers.get("mcp-session-id");
    if (!this.sessionId) throw new Error("server did not return mcp-session-id");

    const json = await readJsonRpc(res);
    if (json.error) throw new Error(`initialize failed: ${json.error.message}`);

    // Required by the MCP handshake; the server ignores the (absent) response.
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }).then(r => r.text());
  }

  /**
   * Call a tool and parse its JSON payload.
   *
   * MCP tool results are wrapped: `{ content: [{ type: "text", text: "<json>" }] }`.
   * chatmux puts a JSON document in that text field, so consumers unwrap twice.
   */
  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });

    if (!res.ok) {
      throw new Error(`${name} failed: HTTP ${res.status} ${await res.text()}`);
    }

    const json = await readJsonRpc(res);
    if (json.error) throw new Error(`${name} failed: ${json.error.message}`);

    const content = (json.result as { content?: { type: string; text?: string }[] })?.content;
    const text = content?.find(c => c.type === "text")?.text;
    if (text == null) throw new Error(`${name} returned no text content`);

    return JSON.parse(text) as T;
  }
}

/** Prefers the unix socket; falls back to loopback TCP. */
export function endpointFromEnv(): ChatmuxEndpoint {
  const socketPath = process.env.CHATMUX_SOCKET;
  if (socketPath) return { socketPath };

  const port = process.env.CHATMUX_MCP_PORT ?? "7717";
  return { url: `http://127.0.0.1:${port}/mcp` };
}
