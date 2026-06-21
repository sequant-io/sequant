import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const cliSource = readFileSync(resolve(here, "cli.ts"), "utf-8");
const preflightSource = readFileSync(resolve(here, "preflight.ts"), "utf-8");

// Ordered list of module specifiers as they appear in `import ... from "x"`
// and side-effecting `import "x"` statements.
function importSpecifiersInOrder(src: string): string[] {
  const specifiers: string[] = [];
  const re = /^\s*import\s+(?:[^;]*?\sfrom\s+)?["']([^"']+)["'];?/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    specifiers.push(m[1]);
  }
  return specifiers;
}

describe("preflight import ordering (#734)", () => {
  // The guard only closes the import-time crash window if it is evaluated
  // before the heavier third-party / command-module imports. ESM evaluates a
  // module's imports depth-first in source order, so `./preflight.js` MUST be
  // the first import in cli.ts. A reorder would silently reopen the window
  // (the build still passes, the unit tests of the pure fn still pass), which
  // is exactly the regression this test guards.
  it("imports ./preflight.js as the very first import in cli.ts", () => {
    const specifiers = importSpecifiersInOrder(cliSource);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers[0]).toBe("./preflight.js");
  });

  it("loads the preflight guard before commander and the agent SDK", () => {
    const specifiers = importSpecifiersInOrder(cliSource);
    const preflightIdx = specifiers.indexOf("./preflight.js");
    const commanderIdx = specifiers.indexOf("commander");
    expect(preflightIdx).toBe(0);
    expect(commanderIdx).toBeGreaterThan(preflightIdx);
  });

  it("derives the floor from package.json engines.node and reuses assertNodeVersion", () => {
    // Single source of truth (AC-3): the floor comes from engines.node, not a
    // hardcoded literal. The pure logic stays in version-check.ts (AC-6).
    expect(preflightSource).toMatch(/engines\?\.node/);
    expect(preflightSource).toMatch(
      /import\s+\{\s*assertNodeVersion\s*\}\s+from\s+["']\.\.\/src\/lib\/version-check\.js["']/,
    );
    expect(preflightSource).toMatch(/assertNodeVersion\(/);
    // Must not hardcode a separate version literal that could drift.
    expect(preflightSource).not.toMatch(/22\.12\.0/);
  });

  it("uses only built-in-safe imports so it runs on the old Node it rejects", () => {
    const specifiers = importSpecifiersInOrder(preflightSource);
    const allowed = new Set([
      "fs",
      "url",
      "path",
      "../src/lib/version-check.js",
    ]);
    for (const spec of specifiers) {
      expect(allowed.has(spec)).toBe(true);
    }
  });
});
