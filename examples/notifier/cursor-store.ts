/**
 * Cursor persistence. The whole point of the cursor is surviving a restart, so this
 * has to be durable: write to a temp file and rename, never truncate-in-place. A
 * half-written cursor file is worse than no cursor file.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export class CursorStore {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  load(): string | null {
    if (!existsSync(this.filePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as { cursor?: unknown };
      return typeof parsed.cursor === "string" ? parsed.cursor : null;
    } catch {
      // Corrupt file: treat as "no cursor" rather than crash-looping. The caller
      // resyncs from head, which loses backlog but keeps the consumer alive.
      console.error(`[notifier] cursor file unreadable, resyncing from head: ${this.filePath}`);
      return null;
    }
  }

  save(cursor: string): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ cursor }) + "\n");
    renameSync(tmp, this.filePath);
  }
}

export function defaultCursorPath(): string {
  const dataDir =
    process.env.CHATMUX_DATA_DIR ??
    join(process.env.HOME ?? ".", ".local/share/chatmux");
  return join(dataDir, "consumers/notifier/cursor.json");
}
