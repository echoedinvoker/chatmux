import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import {
  subscribeClientLog,
  NOISY_LOG_TYPES,
} from "../../../src/adapters/line/diagnostics.js";

test("linejs 的 log event 轉成一行 stderr 輸出", () => {
  const client = new EventEmitter() as any;
  const lines: string[] = [];
  subscribeClientLog(client, (s) => lines.push(s));

  client.emit("log", { type: "LegyPusherError", data: { message: "stream timeout" } });

  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("[LINE][linejs]");
  expect(lines[0]).toContain("LegyPusherError");
  expect(lines[0]).toContain("stream timeout");
});

test("data 無法序列化時不得讓訂閱者拋錯", () => {
  const client = new EventEmitter() as any;
  const lines: string[] = [];
  subscribeClientLog(client, (s) => lines.push(s));

  const cyclic: any = { name: "x" };
  cyclic.self = cyclic;
  expect(() => client.emit("log", { type: "Weird", data: cyclic })).not.toThrow();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("Weird");
});

test("逐位元組與 poll 週期雜訊被丟棄（避免 journald rate limit 丟掉真訊號）", () => {
  const client = new EventEmitter() as any;
  const lines: string[] = [];
  subscribeClientLog(client, (s) => lines.push(s));

  for (const type of NOISY_LOG_TYPES) {
    client.emit("log", { type, data: { chunk: [1, 2, 3] } });
  }
  client.emit("log", { type: "[LEGY/PUSH] send ping", data: {} });

  expect(lines).toHaveLength(0);
});

test("未知型別仍放行（denylist 而非 allowlist，不讓新訊號靜默消失）", () => {
  const client = new EventEmitter() as any;
  const lines: string[] = [];
  subscribeClientLog(client, (s) => lines.push(s));

  client.emit("log", { type: "BrandNewSignal", data: { detail: "unseen" } });

  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("BrandNewSignal");
});

test("Error 物件要帶出 message，不能序列化成 {}", () => {
  const client = new EventEmitter() as any;
  const lines: string[] = [];
  subscribeClientLog(client, (s) => lines.push(s));

  client.emit("log", { type: "LegyPusherError", data: { error: new Error("stream timeout") } });

  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("stream timeout");
  expect(lines[0]).not.toContain('{"error":{}}');
});
