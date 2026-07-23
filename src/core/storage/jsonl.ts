import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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

  readTailLines(count: number): JsonlEvent[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, "utf-8").trim();
    if (!content) return [];
    const lines = content.split("\n");
    return lines.slice(-count).map((line) => JSON.parse(line));
  }

  close(): void {
    // no-op for sync file operations
  }
}
