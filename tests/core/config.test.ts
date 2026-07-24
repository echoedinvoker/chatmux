import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadAdapterConfigs, type AdapterConfig } from "../../src/core/config.js";

const TEST_DIR = join(import.meta.dir, "../../.test-config-tmp");

function writeConfig(data: unknown) {
  writeFileSync(join(TEST_DIR, "adapters.json"), JSON.stringify(data, null, 2));
}

describe("loadAdapterConfigs", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("parses a valid config with multiple adapters", () => {
    writeConfig({
      adapters: [
        {
          platform: "line",
          command: "node",
          args: ["--import", "tsx", "src/adapters/line/index.ts"],
          cwd: "/home/matt/Documents/chatmux",
          enabled: true,
        },
        {
          platform: "telegram",
          command: "/home/matt/.venv/bin/python",
          args: ["/home/matt/adapter/main.py"],
          env: { TELEGRAM_API_ID: "12345", TELEGRAM_API_HASH: "abc" },
          enabled: true,
        },
      ],
    });

    const configs = loadAdapterConfigs(TEST_DIR);
    expect(configs).toHaveLength(2);

    expect(configs[0].platform).toBe("line");
    expect(configs[0].command).toEqual(["node", "--import", "tsx", "src/adapters/line/index.ts"]);
    expect(configs[0].cwd).toBe("/home/matt/Documents/chatmux");
    expect(configs[0].env).toBeUndefined();

    expect(configs[1].platform).toBe("telegram");
    expect(configs[1].command).toEqual(["/home/matt/.venv/bin/python", "/home/matt/adapter/main.py"]);
    expect(configs[1].env).toEqual({ TELEGRAM_API_ID: "12345", TELEGRAM_API_HASH: "abc" });
  });

  it("filters out disabled adapters", () => {
    writeConfig({
      adapters: [
        { platform: "line", command: "node", args: ["index.ts"], enabled: true },
        { platform: "telegram", command: "python", args: ["main.py"], enabled: false },
      ],
    });

    const configs = loadAdapterConfigs(TEST_DIR);
    expect(configs).toHaveLength(1);
    expect(configs[0].platform).toBe("line");
  });

  it("returns empty array for empty adapters list", () => {
    writeConfig({ adapters: [] });

    const configs = loadAdapterConfigs(TEST_DIR);
    expect(configs).toHaveLength(0);
  });

  it("returns fallback LINE config when file does not exist", () => {
    const configs = loadAdapterConfigs(TEST_DIR);
    expect(configs).toHaveLength(1);
    expect(configs[0].platform).toBe("line");
    expect(configs[0].command[0]).toBe("node");
  });

  it("throws on missing required fields", () => {
    writeConfig({
      adapters: [{ platform: "line" }],
    });

    expect(() => loadAdapterConfigs(TEST_DIR)).toThrow();
  });

  it("throws on duplicate platform names", () => {
    writeConfig({
      adapters: [
        { platform: "line", command: "node", args: ["a.ts"], enabled: true },
        { platform: "line", command: "node", args: ["b.ts"], enabled: true },
      ],
    });

    expect(() => loadAdapterConfigs(TEST_DIR)).toThrow(/duplicate/i);
  });

  it("defaults cwd to undefined when not provided", () => {
    writeConfig({
      adapters: [
        { platform: "line", command: "node", args: ["index.ts"], enabled: true },
      ],
    });

    const configs = loadAdapterConfigs(TEST_DIR);
    expect(configs[0].cwd).toBeUndefined();
  });

  it("defaults env to undefined when not provided", () => {
    writeConfig({
      adapters: [
        { platform: "line", command: "node", args: ["index.ts"], enabled: true },
      ],
    });

    const configs = loadAdapterConfigs(TEST_DIR);
    expect(configs[0].env).toBeUndefined();
  });
});
