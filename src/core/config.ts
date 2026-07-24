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
