import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadAdapterConfigs,
  loadMcpPort,
  DEFAULT_MCP_PORT,
  loadMcpHost,
  DEFAULT_MCP_HOST,
  isLoopback,
  type AdapterConfig,
} from "../../src/core/config.js";

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
          cwd: "/opt/chatmux",
          enabled: true,
        },
        {
          platform: "telegram",
          command: "/opt/venv/bin/python",
          args: ["/opt/adapter/main.py"],
          env: { TELEGRAM_API_ID: "12345", TELEGRAM_API_HASH: "abc" },
          enabled: true,
        },
      ],
    });

    const configs = loadAdapterConfigs(TEST_DIR);
    expect(configs).toHaveLength(2);

    expect(configs[0].platform).toBe("line");
    expect(configs[0].command).toEqual(["node", "--import", "tsx", "src/adapters/line/index.ts"]);
    expect(configs[0].cwd).toBe("/opt/chatmux");
    expect(configs[0].env).toBeUndefined();

    expect(configs[1].platform).toBe("telegram");
    expect(configs[1].command).toEqual(["/opt/venv/bin/python", "/opt/adapter/main.py"]);
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

describe("loadMcpPort", () => {
  const savedEnv = process.env.CHATMUX_MCP_PORT;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    delete process.env.CHATMUX_MCP_PORT;
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    if (savedEnv === undefined) delete process.env.CHATMUX_MCP_PORT;
    else process.env.CHATMUX_MCP_PORT = savedEnv;
  });

  it("falls back to the default port when nothing is configured", () => {
    expect(loadMcpPort(TEST_DIR)).toBe(DEFAULT_MCP_PORT);
  });

  it("reads mcp.port from adapters.json", () => {
    writeConfig({ adapters: [], mcp: { port: 9123 } });
    expect(loadMcpPort(TEST_DIR)).toBe(9123);
  });

  it("env var overrides adapters.json", () => {
    writeConfig({ adapters: [], mcp: { port: 9123 } });
    process.env.CHATMUX_MCP_PORT = "9999";
    expect(loadMcpPort(TEST_DIR)).toBe(9999);
  });

  it("env var overrides the default when no config file exists", () => {
    process.env.CHATMUX_MCP_PORT = "9999";
    expect(loadMcpPort(TEST_DIR)).toBe(9999);
  });

  it("ignores an empty env var and falls through", () => {
    process.env.CHATMUX_MCP_PORT = "";
    expect(loadMcpPort(TEST_DIR)).toBe(DEFAULT_MCP_PORT);
  });

  it("accepts 0 to disable the TCP listener", () => {
    writeConfig({ adapters: [], mcp: { port: 0 } });
    expect(loadMcpPort(TEST_DIR)).toBe(0);
  });

  it("throws on a non-numeric port instead of silently defaulting", () => {
    process.env.CHATMUX_MCP_PORT = "not-a-port";
    expect(() => loadMcpPort(TEST_DIR)).toThrow(/CHATMUX_MCP_PORT/);
  });

  it("throws on an out-of-range port", () => {
    writeConfig({ adapters: [], mcp: { port: 70000 } });
    expect(() => loadMcpPort(TEST_DIR)).toThrow(/0-65535/);
  });

  it("ignores mcp.port absence in an otherwise valid config", () => {
    writeConfig({ adapters: [{ platform: "line", command: "node", args: ["a.ts"] }] });
    expect(loadMcpPort(TEST_DIR)).toBe(DEFAULT_MCP_PORT);
  });
});

describe("loadMcpHost", () => {
  const savedEnv = process.env.CHATMUX_MCP_HOST;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    delete process.env.CHATMUX_MCP_HOST;
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    if (savedEnv === undefined) delete process.env.CHATMUX_MCP_HOST;
    else process.env.CHATMUX_MCP_HOST = savedEnv;
  });

  // This default-value assertion is the ONLY thing guarding the config layer:
  // tests/core/mcp-server.test.ts's loopback guard never goes through config,
  // so a DEFAULT_MCP_HOST of "0.0.0.0" would leave it green. Do not delete.
  it("falls back to loopback when nothing is configured", () => {
    expect(loadMcpHost(TEST_DIR)).toBe("127.0.0.1");
    expect(DEFAULT_MCP_HOST).toBe("127.0.0.1");
  });

  it("reads mcp.host from adapters.json", () => {
    writeConfig({ adapters: [], mcp: { host: "0.0.0.0" } });
    expect(loadMcpHost(TEST_DIR)).toBe("0.0.0.0");
  });

  it("env var overrides adapters.json", () => {
    writeConfig({ adapters: [], mcp: { host: "0.0.0.0" } });
    process.env.CHATMUX_MCP_HOST = "100.64.0.1";
    expect(loadMcpHost(TEST_DIR)).toBe("100.64.0.1");
  });

  it("env var overrides the default when no config file exists", () => {
    process.env.CHATMUX_MCP_HOST = "0.0.0.0";
    expect(loadMcpHost(TEST_DIR)).toBe("0.0.0.0");
  });

  it("ignores an empty env var and falls through", () => {
    process.env.CHATMUX_MCP_HOST = "";
    expect(loadMcpHost(TEST_DIR)).toBe(DEFAULT_MCP_HOST);
  });

  it("trims surrounding whitespace from the env var", () => {
    process.env.CHATMUX_MCP_HOST = " 0.0.0.0\n";
    expect(loadMcpHost(TEST_DIR)).toBe("0.0.0.0");
  });

  // Container env files routinely carry trailing whitespace/newlines; a
  // whitespace-only value must not reach listenOn as a bogus address.
  it("throws on a whitespace-only env var instead of silently defaulting", () => {
    process.env.CHATMUX_MCP_HOST = "   ";
    expect(() => loadMcpHost(TEST_DIR)).toThrow(/CHATMUX_MCP_HOST/);
  });

  it("throws on a non-string host in adapters.json", () => {
    writeConfig({ adapters: [], mcp: { host: 12345 } });
    expect(() => loadMcpHost(TEST_DIR)).toThrow(/mcp\.host/);
  });

  it("throws on an empty host in adapters.json instead of silently defaulting", () => {
    writeConfig({ adapters: [], mcp: { host: "  " } });
    expect(() => loadMcpHost(TEST_DIR)).toThrow(/mcp\.host/);
  });

  it("ignores mcp.host absence in an otherwise valid config", () => {
    writeConfig({ adapters: [], mcp: { port: 9123 } });
    expect(loadMcpHost(TEST_DIR)).toBe(DEFAULT_MCP_HOST);
  });
});

// The startup warning keys off this. A false positive on a genuinely safe
// address (localhost, 127.0.0.2, ::ffff:127.0.0.1) teaches the user to ignore
// the warning, which destroys its signal value for the one case that matters.
describe("isLoopback", () => {
  const loopback = [
    "127.0.0.1",
    "127.0.0.2",
    "127.255.255.254",
    "::1",
    "::ffff:127.0.0.1",
    "localhost",
    "LOCALHOST",
    " 127.0.0.1 ",
  ];
  for (const host of loopback) {
    it(`treats ${JSON.stringify(host)} as loopback`, () => {
      expect(isLoopback(host)).toBe(true);
    });
  }

  const exposed = ["0.0.0.0", "::", "100.64.0.1", "192.168.1.10", "example.com", ""];
  for (const host of exposed) {
    it(`treats ${JSON.stringify(host)} as non-loopback`, () => {
      expect(isLoopback(host)).toBe(false);
    });
  }
});
