/**
 * Enforces NEVER #11: nothing under examples/ may import from src/.
 *
 * An in-repo example can reach into core internals with one relative import, and the
 * moment it does it stops exercising the MCP boundary — which is the only reason the
 * example earns its place in the repo. A reviewer will not catch this reliably, so a
 * test does.
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const EXAMPLES_DIR = join(REPO_ROOT, "examples");
const SRC_DIR = join(REPO_ROOT, "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

/** static imports, `export ... from`, and dynamic `import(...)` */
const SPECIFIER_PATTERNS = [
  /(?:^|\s)(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function specifiersIn(source: string): string[] {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) found.push(match[1]);
    }
  }
  return found;
}

describe("examples/ ↔ src/ boundary (NEVER #11)", () => {
  test("examples/ exists and contains source files", () => {
    // Guards against the suite passing vacuously if examples/ is renamed or emptied.
    expect(existsSync(EXAMPLES_DIR)).toBe(true);
    expect(walk(EXAMPLES_DIR).length).toBeGreaterThan(0);
  });

  test("no file under examples/ imports from src/", () => {
    const violations: string[] = [];

    for (const file of walk(EXAMPLES_DIR)) {
      const source = readFileSync(file, "utf-8");

      for (const spec of specifiersIn(source)) {
        const isRelative = spec.startsWith(".");
        const resolved = isRelative
          ? resolve(dirname(file), spec)
          : resolve(REPO_ROOT, spec);

        const reachesSrc =
          resolved === SRC_DIR || resolved.startsWith(SRC_DIR + "/");

        if (reachesSrc) {
          violations.push(`${relative(REPO_ROOT, file)} → "${spec}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("the detector actually fires on a violating specifier", () => {
    // A boundary test that cannot fail is worthless; prove the matcher works.
    const sample = `import { getEventsSince } from "../../src/core/storage/query.js";`;
    const specs = specifiersIn(sample);

    expect(specs).toContain("../../src/core/storage/query.js");

    const resolved = resolve(join(EXAMPLES_DIR, "notifier"), specs[0]!);
    expect(resolved.startsWith(SRC_DIR + "/")).toBe(true);
  });
});
