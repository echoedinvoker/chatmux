/**
 * An MCP client that follows the spec instead of following chatmux.
 *
 * F6's whole problem is that our own sidecar cannot detect it: it adds a uri to its
 * subscribed set even when subscribe throws, and the server used to broadcast to everyone
 * anyway, so the two bugs cancelled out. Verifying against that sidecar proves nothing.
 * This client shares none of those coincidences:
 *
 *   1. If `resources/subscribe` fails, it does NOT record the uri.
 *   2. It only handles notifications for uris it actually subscribed to.
 *   3. It opens a SECOND session that subscribes to nothing — the only way to observe
 *      whether the server still broadcasts unconditionally.
 *
 * Uses no sidecar code and no MCP SDK: raw JSON-RPC over streamable HTTP.
 *
 *   Usage: bun scripts/f6-strict-client.ts [--url http://127.0.0.1:47719/mcp] [--wait 6000]
 */

interface Args {
  url: string;
  waitMs: number;
}

function parseArgs(argv: string[]): Args | null {
  if (argv.includes("--help") || argv.includes("-h")) return null;
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    url: get("--url", "http://127.0.0.1:47719/mcp"),
    waitMs: Number(get("--wait", "6000")),
  };
}

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

const SUBSCRIBE_URI = "chat://chats";

async function readJsonRpc(res: Response): Promise<Record<string, unknown>> {
  const body = await res.text();
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const line = body.split("\n").find((l) => l.startsWith("data:"));
    if (!line) throw new Error(`no SSE data frame in: ${body}`);
    return JSON.parse(line.slice(5).trim());
  }
  return JSON.parse(body);
}

interface Session {
  id: string;
  /** Only uris this session successfully subscribed to. Empty means empty. */
  subscribed: Set<string>;
  /** Notifications the server pushed, whether or not we asked for them. */
  received: { uri: string; handled: boolean }[];
  capabilities: Record<string, unknown>;
  stop: () => Promise<void>;
}

async function openSession(url: string, label: string): Promise<Session> {
  const init = await fetch(url, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: `f6-strict-${label}`, version: "1.0.0" },
      },
    }),
  });
  const id = init.headers.get("mcp-session-id");
  if (!id) throw new Error("server returned no mcp-session-id");
  const initJson = await readJsonRpc(init);
  const capabilities = (initJson.result as { capabilities: Record<string, unknown> })
    .capabilities;

  const subscribed = new Set<string>();
  const received: { uri: string; handled: boolean }[] = [];

  const sse = await fetch(url, {
    method: "GET",
    headers: { ...HEADERS, "mcp-session-id": id },
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
        if (!l.startsWith("data:")) continue;
        const msg = JSON.parse(l.slice(5).trim());
        if (msg.method !== "notifications/resources/updated") continue;
        const uri = msg.params?.uri as string;
        // A spec client only acts on what it subscribed to.
        const handled = subscribed.has(uri);
        received.push({ uri, handled });
        console.log(
          `  [${label}] notification uri=${uri} ${handled ? "→ handled" : "→ IGNORED (never subscribed)"}`,
        );
      }
    }
  })().catch(() => {});

  const stop = async () => {
    await reader.cancel();
    await fetch(url, { method: "DELETE", headers: { ...HEADERS, "mcp-session-id": id } });
  };

  return { id, subscribed, received, capabilities, stop };
}

async function subscribe(url: string, s: Session, uri: string): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...HEADERS, "mcp-session-id": s.id },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/subscribe",
      params: { uri },
    }),
  });
  const json = await readJsonRpc(res);
  if (json.error) return json.error;
  // Only on success does the uri enter the set — this is the line the sidecar gets wrong.
  s.subscribed.add(uri);
  return undefined;
}

const args = parseArgs(process.argv.slice(2));
if (!args) {
  console.log(
    "Usage: bun scripts/f6-strict-client.ts [--url http://127.0.0.1:47719/mcp] [--wait 6000]\n" +
      "\n" +
      "Connects two sessions to an MCP server: A subscribes to chat://chats, B subscribes\n" +
      "to nothing. Reports what each received. B receiving anything means the server is\n" +
      "still broadcasting unconditionally.",
  );
  process.exit(0);
}

console.log(`server: ${args.url}`);

const a = await openSession(args.url, "A");
console.log(`\n[A] initialize capabilities.resources = ${JSON.stringify(a.capabilities.resources)}`);

const declaresSubscribe =
  (a.capabilities.resources as { subscribe?: boolean } | undefined)?.subscribe === true;
console.log(`[A] server declares resources.subscribe: ${declaresSubscribe}`);

let subError: unknown;
if (declaresSubscribe) {
  subError = await subscribe(args.url, a, SUBSCRIBE_URI);
  console.log(
    subError
      ? `[A] resources/subscribe FAILED: ${JSON.stringify(subError)} → uri not tracked`
      : `[A] resources/subscribe ok → tracking ${SUBSCRIBE_URI}`,
  );
} else {
  // A spec client would normally stop here. Send it anyway so the failure is on the record.
  subError = await subscribe(args.url, a, SUBSCRIBE_URI);
  console.log(
    `[A] capability not declared; sent subscribe anyway to record the response: ${JSON.stringify(subError ?? "ok")}`,
  );
}

const b = await openSession(args.url, "B");
console.log(`[B] opened, subscribed to nothing\n`);

console.log(`waiting ${args.waitMs}ms for notifications...`);
await Bun.sleep(args.waitMs);

await a.stop();
await b.stop();

const aHandled = a.received.filter((r) => r.handled).length;
console.log(`
=== result ===
capabilities.resources        : ${JSON.stringify(a.capabilities.resources)}
resources/subscribe response  : ${subError ? JSON.stringify(subError) : "ok"}
A tracked uris                : ${JSON.stringify([...a.subscribed])}
A notifications received      : ${a.received.length} (handled ${aHandled})
B notifications received      : ${b.received.length}   <- must be 0
`);

process.exit(b.received.length === 0 && aHandled > 0 ? 0 : 1);
