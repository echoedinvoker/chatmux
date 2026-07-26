import { appendFileSync, readFileSync, existsSync, openSync, closeSync, readSync, fstatSync, statSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** How far past `maxBytes` a chunk reaches at a time while hunting for the next newline. */
const READ_STEP = 64 * 1024;

export interface JsonlEvent {
  type: string;
  platform: string;
  platform_message_id: string;
  chat: {
    platform_id: string;
    type: string;
    name?: string;
  };
  sender: {
    platform_id: string;
    display_name: string;
  };
  timestamp: number;
  content: {
    type: string;
    text?: string;
    media_url?: string;
  };
  raw: unknown;
  source: string;
  received_at?: number;
}

export interface JsonlChunk {
  events: JsonlEvent[];
  nextOffset: number;
}

export class JsonlWriter {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
  }

  append(event: JsonlEvent): void {
    const record = { ...event, received_at: event.received_at ?? Date.now() };
    appendFileSync(this.filePath, JSON.stringify(record) + "\n");
  }

  readLines(): JsonlEvent[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, "utf-8").trim();
    if (!content) return [];
    return content.split("\n").map((line) => JSON.parse(line));
  }

  byteSize(): number {
    if (!existsSync(this.filePath)) return 0;
    return statSync(this.filePath).size;
  }

  /**
   * Read forward from a byte offset, stopping at the last complete line.
   *
   * The log is appended to while it is being read, so the tail of a chunk is routinely half a
   * line. Dropping it keeps `nextOffset` on a line boundary — swallowing it would both throw in
   * JSON.parse and desynchronise every subsequent checkpoint.
   *
   * `maxBytes` is a batching hint, not a hard cap: a chunk that contains no newline keeps
   * reading until it finds one, otherwise a line longer than the batch size would leave
   * `nextOffset` where it started and spin the replay loop forever.
   */
  readFrom(offset: number, maxBytes?: number): JsonlChunk {
    if (!existsSync(this.filePath)) return { events: [], nextOffset: offset };

    const fd = openSync(this.filePath, "r");
    try {
      const size = fstatSync(fd).size;
      if (offset >= size) return { events: [], nextOffset: offset };

      const chunks: Buffer[] = [];
      let read = 0;
      let seenNewline = false;

      while (offset + read < size) {
        const want = maxBytes === undefined ? size - offset : read === 0 ? maxBytes : READ_STEP;
        const buffer = Buffer.allocUnsafe(Math.min(want, size - offset - read));
        const got = readSync(fd, buffer, 0, buffer.length, offset + read);
        if (got === 0) break;

        const slice = buffer.subarray(0, got);
        if (slice.includes(0x0a)) seenNewline = true;

        chunks.push(slice);
        read += got;

        if (seenNewline && maxBytes !== undefined && read >= maxBytes) break;
      }

      const buf = Buffer.concat(chunks, read);
      const cap = maxBytes === undefined ? read : Math.min(maxBytes, read);
      // Prefer the last line boundary inside the batch; if the batch cannot hold even one line,
      // overshoot to the next boundary so the caller's offset always advances.
      let cut = buf.subarray(0, cap).lastIndexOf(0x0a);
      if (cut === -1) cut = buf.indexOf(0x0a, cap);
      if (cut === -1) return { events: [], nextOffset: offset };

      const text = buf.subarray(0, cut).toString("utf-8");
      const events = text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as JsonlEvent);

      return { events, nextOffset: offset + cut + 1 };
    } finally {
      closeSync(fd);
    }
  }

  close(): void {
    // no-op for sync file operations
  }
}
