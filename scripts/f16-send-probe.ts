// F16 three-way reconciliation probe: send one message with a marker YOU chose, then print
// everything needed to look it up in JSONL, in `messages`, and in `chats.last_message_at`.
//
// This talks to the *running daemon* over its MCP socket — the full production path, on the
// real database. (The Phase 3.4/3.5 scripts do the opposite: they bypass the daemon and open
// a throwaway copy. Do not merge the two.)
//
// Bun only: `fetch(url, { unix })` is a Bun extension, node cannot run this.
//   bun run scripts/f16-send-probe.ts <marker> [chat_id]

const marker = process.argv[2];
const chatId = process.argv[3] ?? "telegram:7869659098";

if (!marker) {
  console.error("usage: bun run scripts/f16-send-probe.ts <marker> [chat_id]");
  process.exit(1);
}

const socketPath = process.env.CHATMUX_SOCKET ?? `${process.env.HOME}/.local/share/chatmux/chatmux.sock`;
let sessionId: string | null = null;
let nextId = 1;

function parseResponse(text: string): any {
  const dataMatch = text.match(/^data: (.+)$/m);
  return dataMatch?.[1] ? JSON.parse(dataMatch[1]) : JSON.parse(text);
}

async function rpc(method: string, params: Record<string, unknown>, notify = false): Promise<any> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (!notify) body.id = nextId++;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch("http://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    unix: socketPath,
  } as RequestInit);

  if (!sessionId) sessionId = res.headers.get("mcp-session-id");
  if (notify) return null;

  const parsed = parseResponse(await res.text());
  if (parsed?.error) throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
  return parsed;
}

// The server rejects tool calls before the session handshake completes.
await rpc("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "f16-send-probe", version: "1.0.0" },
});
await rpc("notifications/initialized", {}, true);

const sentAt = Date.now();
const response = await rpc("tools/call", {
  name: "send_message",
  arguments: { chat_id: chatId, text: marker },
});

const content = response?.result?.content?.[0]?.text;
const result = content ? JSON.parse(content) : response?.result;

console.log(JSON.stringify({ marker, chat_id: chatId, sent_at: sentAt, result }, null, 2));
