import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface AdapterConfig {
  platform: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface RawAdapterEntry {
  platform?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled?: boolean;
}

/** Default TCP port for the MCP Streamable HTTP listener (bound to 127.0.0.1 only). */
export const DEFAULT_MCP_PORT = 7717;

/**
 * Resolve the MCP TCP port.
 *
 * Precedence: `CHATMUX_MCP_PORT` env > `adapters.json` `mcp.port` > DEFAULT_MCP_PORT.
 * `0` disables the TCP listener, leaving only the unix socket.
 */
export function loadMcpPort(dataDir: string): number {
  const fromEnv = process.env.CHATMUX_MCP_PORT;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return parsePort(fromEnv, "CHATMUX_MCP_PORT");
  }

  const configPath = join(dataDir, "adapters.json");
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const port = raw?.mcp?.port;
    if (port !== undefined && port !== null) {
      return parsePort(port, "adapters.json: mcp.port");
    }
  }

  return DEFAULT_MCP_PORT;
}

/**
 * Default bind address for the MCP Streamable HTTP listener.
 *
 * Loopback only. Overriding this exposes the full text of every conversation
 * to anything that can reach the chosen address — see `loadMcpHost`.
 */
export const DEFAULT_MCP_HOST = "127.0.0.1";

/**
 * Resolve the MCP TCP bind host.
 *
 * Precedence: `CHATMUX_MCP_HOST` env > `adapters.json` `mcp.host` > DEFAULT_MCP_HOST.
 * Any non-empty address is accepted (binding a single Tailscale interface is a
 * legitimate use); an invalid value throws rather than silently falling back,
 * because a silent fallback produces the worst failure mode there is — the
 * setting looks applied but nothing outside loopback can connect.
 */
export function loadMcpHost(dataDir: string): string {
  const fromEnv = process.env.CHATMUX_MCP_HOST;
  if (fromEnv !== undefined && fromEnv !== "") {
    return parseHost(fromEnv, "CHATMUX_MCP_HOST");
  }

  const configPath = join(dataDir, "adapters.json");
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const host = raw?.mcp?.host;
    if (host !== undefined && host !== null) {
      return parseHost(host, "adapters.json: mcp.host");
    }
  }

  return DEFAULT_MCP_HOST;
}

/**
 * Is this bind address confined to the local machine?
 *
 * Covers `localhost`, the whole `127.0.0.0/8` range, `::1` and IPv4-mapped
 * loopback (`::ffff:127.x.x.x`). Used only to decide whether to print the
 * exposure warning — a warning that cries wolf on safe values (`localhost` is
 * one of the most likely things a user types) stops being read at all.
 *
 * `localhost` could in principle be re-pointed via /etc/hosts. That
 * imprecision is accepted: this is a reminder, not a security control.
 */
export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost") return true;
  if (h === "::1") return true;

  const v4 = h.startsWith("::ffff:") ? h.slice("::ffff:".length) : h;
  const octets = v4.split(".");
  if (octets.length !== 4) return false;
  if (!octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return false;
  return octets[0] === "127";
}

function parseHost(value: unknown, source: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "") {
    throw new Error(
      `${source}: must be a non-empty host address, got ${JSON.stringify(value)}`,
    );
  }
  return trimmed;
}

function parsePort(value: unknown, source: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(
      `${source}: must be an integer 0-65535 (0 disables the TCP listener), got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

export function loadAdapterConfigs(dataDir: string): AdapterConfig[] {
  const configPath = join(dataDir, "adapters.json");

  if (!existsSync(configPath)) {
    return [
      {
        platform: "line",
        command: ["node", "--import", "tsx", resolve(__dirname, "../adapters/line/index.ts")],
        cwd: resolve(__dirname, "../.."),
      },
    ];
  }

  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  const entries: RawAdapterEntry[] = raw.adapters;

  if (!Array.isArray(entries)) {
    throw new Error("adapters.json: 'adapters' must be an array");
  }

  const seen = new Set<string>();
  const configs: AdapterConfig[] = [];

  for (const entry of entries) {
    if (!entry.platform || typeof entry.platform !== "string") {
      throw new Error("adapters.json: each adapter must have a 'platform' string");
    }
    if (!entry.command || typeof entry.command !== "string") {
      throw new Error(`adapters.json: adapter '${entry.platform}' must have a 'command' string`);
    }
    if (!Array.isArray(entry.args)) {
      throw new Error(`adapters.json: adapter '${entry.platform}' must have an 'args' array`);
    }

    if (entry.enabled === false) continue;

    if (seen.has(entry.platform)) {
      throw new Error(`adapters.json: duplicate platform '${entry.platform}'`);
    }
    seen.add(entry.platform);

    const config: AdapterConfig = {
      platform: entry.platform,
      command: [entry.command, ...entry.args],
    };

    if (entry.cwd) config.cwd = entry.cwd;
    if (entry.env && Object.keys(entry.env).length > 0) config.env = entry.env;

    configs.push(config);
  }

  return configs;
}
