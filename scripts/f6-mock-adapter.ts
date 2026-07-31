/**
 * A mock adapter that exists to give an isolated daemon something to notify about.
 *
 * F6's acceptance runs against a throwaway daemon (own CHATMUX_DATA_DIR, own port, no real
 * account). A daemon with zero adapters never calls notifyMessageReceived, so a subscriber
 * connected to it would wait forever and "received nothing" would prove nothing. This
 * adapter emits a message event on a timer so the notification path actually fires.
 *
 * Speaks the stdio JSON-RPC adapter protocol (docs/adapter-protocol.md). It logs in to
 * nothing and sends to nothing.
 *
 *   Usage: bun scripts/f6-mock-adapter.ts        (spawned by core via adapters.json)
 *   Env:   MOCK_INTERVAL_MS  gap between emitted events (default 2000)
 */

const PLATFORM = "mock";
const CHAT_ID = "c-mock-1";
const INTERVAL_MS = Number(process.env.MOCK_INTERVAL_MS ?? 2000);

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function respond(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function notify(method: string, params: unknown): void {
  send({ jsonrpc: "2.0", method, params });
}

let seq = 0;

function emitMessage(): void {
  seq += 1;
  notify("event", {
    type: "message",
    platform: PLATFORM,
    platform_message_id: `m-mock-${seq}`,
    chat: { platform_id: CHAT_ID, type: "group", name: "Mock Room" },
    sender: { platform_id: "u-mock-1", display_name: "Mock Sender" },
    timestamp: Date.now(),
    content: { type: "text", text: `mock message ${seq}` },
  });
}

let timer: ReturnType<typeof setInterval> | undefined;

function handle(msg: Record<string, unknown>): void {
  const { id, method } = msg as { id?: unknown; method?: string };

  switch (method) {
    case "initialize":
      respond(id, {
        platform: PLATFORM,
        supported_events: ["message"],
        can_send: false,
        can_backfill: false,
      });
      // Core issues get_self after this, so report connected on the next turn.
      setTimeout(() => {
        notify("status", { state: "connected", detail: "mock adapter ready" });
        timer = setInterval(emitMessage, INTERVAL_MS);
      }, 100);
      return;

    case "get_chats":
      respond(id, {
        chats: [
          {
            platform_id: CHAT_ID,
            type: "group",
            name: "Mock Room",
            last_activity_at: Date.now(),
          },
        ],
      });
      return;

    case "get_contacts":
      respond(id, { contacts: [{ platform_id: "u-mock-1", display_name: "Mock Sender" }] });
      return;

    case "get_self":
      respond(id, { platform_id: "u-mock-self", display_name: "Mock Self" });
      return;

    case "shutdown":
      respond(id, {});
      if (timer) clearInterval(timer);
      setTimeout(() => process.exit(0), 50);
      return;

    default:
      // Everything else is optional; -32601 is the protocol's opt-out.
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      }
  }
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch (err) {
      console.error("[mock-adapter] bad line:", line, err);
    }
  }
});

process.stdin.on("end", () => {
  if (timer) clearInterval(timer);
  process.exit(0);
});
