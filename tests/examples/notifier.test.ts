/**
 * Tests the reference consumer's drain semantics with a fake event source.
 *
 * These are the guarantees a third party will copy out of this example, so they need
 * to be true: no gaps, at-least-once on hook failure, and recovery from a cursor the
 * daemon no longer recognises.
 */

import { describe, test, expect } from "bun:test";
import { drain, head, type EventSource, type Sink } from "../../examples/notifier/index";
import type { ChatmuxEvent } from "../../examples/notifier/notify";

function makeEvent(seq: number, text: string): ChatmuxEvent {
  return {
    cursor: `evt:${seq}`,
    type: "message",
    message: {
      id: `line:m_${seq}`,
      chat_id: "line:c_001",
      sender: { id: "line:u_001", display_name: "Alice" },
      timestamp: 1690000000000 + seq,
      content: { type: "text", text },
    },
  };
}

/** Serves canned read_events pages in order. */
function fakeSource(pages: unknown[]): EventSource & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  let i = 0;
  return {
    calls,
    async callTool<T>(_name: string, args: Record<string, unknown>): Promise<T> {
      calls.push(args);
      return (pages[Math.min(i++, pages.length - 1)] ?? {}) as T;
    },
  };
}

function recordingSink(onNotify?: (e: ChatmuxEvent) => void) {
  const delivered: string[] = [];
  const saved: string[] = [];
  const sink: Sink = {
    async notify(event) {
      onNotify?.(event);
      delivered.push(event.message.id);
    },
    save(cursor) {
      saved.push(cursor);
    },
  };
  return { sink, delivered, saved };
}

describe("notifier drain", () => {
  test("head starts from now without replaying history", async () => {
    const source = fakeSource([
      { events: [], next_cursor: "evt:99", head_cursor: "evt:99", has_more: false },
    ]);

    expect(await head(source)).toBe("evt:99");
    expect(source.calls[0]).toEqual({});
  });

  test("delivers a page and advances to its last cursor", async () => {
    const source = fakeSource([
      {
        events: [makeEvent(1, "一"), makeEvent(2, "二")],
        next_cursor: "evt:2",
        head_cursor: "evt:2",
        has_more: false,
      },
    ]);
    const { sink, delivered, saved } = recordingSink();

    const result = await drain(source, sink, "evt:0");

    expect(delivered).toEqual(["line:m_1", "line:m_2"]);
    expect(saved).toEqual(["evt:1", "evt:2"]);
    expect(result).toBe("evt:2");
  });

  test("follows has_more across pages without gaps", async () => {
    const source = fakeSource([
      { events: [makeEvent(1, "一")], next_cursor: "evt:1", head_cursor: "evt:2", has_more: true },
      { events: [makeEvent(2, "二")], next_cursor: "evt:2", head_cursor: "evt:2", has_more: false },
    ]);
    const { sink, delivered } = recordingSink();

    expect(await drain(source, sink, "evt:0")).toBe("evt:2");
    expect(delivered).toEqual(["line:m_1", "line:m_2"]);
  });

  test("a throwing hook leaves the cursor at the last delivered event", async () => {
    const source = fakeSource([
      {
        events: [makeEvent(1, "一"), makeEvent(2, "boom"), makeEvent(3, "三")],
        next_cursor: "evt:3",
        head_cursor: "evt:3",
        has_more: false,
      },
    ]);
    const { sink, delivered, saved } = recordingSink(e => {
      if (e.message.content.text === "boom") throw new Error("hook failed");
    });

    await expect(drain(source, sink, "evt:0")).rejects.toThrow("hook failed");

    // evt:1 delivered and committed; evt:2 not committed, so it retries. evt:3 is
    // never skipped — that is the no-gap guarantee.
    expect(delivered).toEqual(["line:m_1"]);
    expect(saved).toEqual(["evt:1"]);
  });

  test("resyncs from head when the daemon rejects the stored cursor", async () => {
    const source = fakeSource([
      { error: "invalid_cursor", detail: "not a cursor issued by this core: bogus" },
      { events: [], next_cursor: "evt:7", head_cursor: "evt:7", has_more: false },
    ]);
    const { sink, delivered, saved } = recordingSink();

    expect(await drain(source, sink, "bogus")).toBe("evt:7");
    expect(delivered).toEqual([]);
    expect(saved).toEqual(["evt:7"]);
  });

  test("resyncs when the cursor is ahead of head (log shrank)", async () => {
    const source = fakeSource([
      { events: [], next_cursor: "evt:9999", head_cursor: "evt:5", has_more: false },
    ]);
    const { sink, saved } = recordingSink();

    expect(await drain(source, sink, "evt:9999")).toBe("evt:5");
    expect(saved).toEqual(["evt:5"]);
  });

  test("an idle poll neither delivers nor rewinds", async () => {
    const source = fakeSource([
      { events: [], next_cursor: "evt:5", head_cursor: "evt:5", has_more: false },
    ]);
    const { sink, delivered, saved } = recordingSink();

    expect(await drain(source, sink, "evt:5")).toBe("evt:5");
    expect(delivered).toEqual([]);
    expect(saved).toEqual([]);
  });
});
