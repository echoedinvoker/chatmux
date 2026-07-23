import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PassThrough } from "node:stream";

function createMockStreams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  return { stdin, stdout };
}

function writeLine(stream: PassThrough, obj: unknown) {
  stream.write(JSON.stringify(obj) + "\n");
}

function readLine(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      stream.removeListener("data", onData);
      resolve(chunk.toString().trim());
    };
    stream.on("data", onData);
  });
}

describe("AdapterResponder", () => {
  let stdin: PassThrough;
  let stdout: PassThrough;
  let responder: any;

  beforeEach(async () => {
    const streams = createMockStreams();
    stdin = streams.stdin;
    stdout = streams.stdout;
    const { AdapterResponder } = await import("../../../src/adapters/line/index.js");
    responder = new AdapterResponder(stdin, stdout);
  });

  afterEach(() => {
    responder.destroy();
    stdin.destroy();
    stdout.destroy();
  });

  describe("request/response dispatch", () => {
    it("dispatches a request to a registered handler and writes response", async () => {
      responder.onRequest("initialize", async (params: any) => {
        return { platform: "line", can_send: true };
      });
      responder.start();

      const responsePromise = readLine(stdout);

      await new Promise((r) => setImmediate(r));
      writeLine(stdin, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { data_dir: "/tmp/test", platform: "line" },
      });

      const raw = await responsePromise;
      const response = JSON.parse(raw);
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(1);
      expect(response.result).toEqual({ platform: "line", can_send: true });
      expect(response.error).toBeUndefined();
    });

    it("returns error response for unknown method", async () => {
      responder.start();

      const responsePromise = readLine(stdout);

      await new Promise((r) => setImmediate(r));
      writeLine(stdin, {
        jsonrpc: "2.0",
        id: 2,
        method: "unknown_method",
        params: {},
      });

      const raw = await responsePromise;
      const response = JSON.parse(raw);
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(2);
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toContain("unknown_method");
    });

    it("returns error response when handler throws", async () => {
      responder.onRequest("fail", async () => {
        throw new Error("handler failed");
      });
      responder.start();

      const responsePromise = readLine(stdout);

      await new Promise((r) => setImmediate(r));
      writeLine(stdin, {
        jsonrpc: "2.0",
        id: 3,
        method: "fail",
        params: {},
      });

      const raw = await responsePromise;
      const response = JSON.parse(raw);
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(3);
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32000);
      expect(response.error.message).toContain("handler failed");
    });
  });

  describe("notifications", () => {
    it("sends notification without id", async () => {
      responder.start();

      const notifPromise = readLine(stdout);

      responder.notify("event", { type: "message", text: "hello" });

      const raw = await notifPromise;
      const notif = JSON.parse(raw);
      expect(notif.jsonrpc).toBe("2.0");
      expect(notif.method).toBe("event");
      expect(notif.params).toEqual({ type: "message", text: "hello" });
      expect(notif.id).toBeUndefined();
    });
  });

    describe("initialize handler capabilities", () => {
    it("returns capabilities matching adapter-protocol.md schema", async () => {
      const { registerLineHandlers } = await import("../../../src/adapters/line/index.js");
      registerLineHandlers(responder);
      responder.start();

      const responsePromise = readLine(stdout);

      await new Promise((r) => setImmediate(r));
      writeLine(stdin, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { data_dir: "/tmp/test", platform: "line" },
      });

      const raw = await responsePromise;
      const response = JSON.parse(raw);
      expect(response.id).toBe(1);

      const caps = response.result;
      expect(caps.platform).toBe("line");
      expect(caps.supported_events).toBeArrayOfSize(3);
      expect(caps.supported_events).toContain("message");
      expect(caps.supported_events).toContain("read_receipt");
      expect(caps.supported_events).toContain("unsend");
      expect(caps.can_send).toBe(true);
      expect(caps.can_backfill).toBe(true);
      expect(caps.platform_rate_limits).toBeDefined();
      expect(caps.platform_rate_limits.send.max).toBe(5);
      expect(caps.platform_rate_limits.send.window_seconds).toBe(60);
    });
  });

  describe("send_message handler via registerLineHandlers", () => {
    it("dispatches send_message and returns message_id + timestamp", async () => {
      const { registerLineHandlers } = await import("../../../src/adapters/line/index.js");
      const mockClient = {
        myMid: "u_me",
        async sendCompactMessage(to: string, text: string) {
          return { sequenceId: 1, messageId: BigInt(42), createdTime: 1690000000000 };
        },
      };
      registerLineHandlers(responder, { getClient: () => mockClient as any });
      responder.start();

      const responsePromise = readLine(stdout);

      await new Promise((r) => setImmediate(r));
      writeLine(stdin, {
        jsonrpc: "2.0",
        id: 5,
        method: "send_message",
        params: { chat_id: "u_target", content: { type: "text", text: "hello" } },
      });

      const raw = await responsePromise;
      const response = JSON.parse(raw);
      expect(response.id).toBe(5);
      expect(response.result.message_id).toBe("42");
      expect(response.result.timestamp).toBe(1690000000000);
    });
  });

  describe("shutdown handler", () => {
    it("responds to shutdown request", async () => {
      const { registerLineHandlers } = await import("../../../src/adapters/line/index.js");
      registerLineHandlers(responder);
      responder.start();

      const responsePromise = readLine(stdout);

      await new Promise((r) => setImmediate(r));
      writeLine(stdin, {
        jsonrpc: "2.0",
        id: 6,
        method: "shutdown",
        params: {},
      });

      const raw = await responsePromise;
      const response = JSON.parse(raw);
      expect(response.id).toBe(6);
      expect(response.result).toEqual({});
    });
  });

  describe("ignores invalid JSON", () => {
    it("does not crash on malformed input", async () => {
      responder.start();

      stdin.write("not json\n");

      await new Promise((r) => setTimeout(r, 50));
      // Should still be alive — send a valid request
      responder.onRequest("ping", async () => ({ pong: true }));

      const responsePromise = readLine(stdout);
      writeLine(stdin, { jsonrpc: "2.0", id: 10, method: "ping", params: {} });

      const raw = await responsePromise;
      const response = JSON.parse(raw);
      expect(response.result).toEqual({ pong: true });
    });
  });
});
