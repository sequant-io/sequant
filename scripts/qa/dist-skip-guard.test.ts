/**
 * Convention guard (#842 AC-6): no test may silently skip when `dist/` is
 * absent.
 *
 * `vitest.global-setup.ts` builds once so integration tests can spawn
 * `dist/bin/cli.js`. When that build is missing (vitest invoked without the
 * global setup, a partial checkout, a broken build script), the correct
 * behavior is a LOUD failure naming the missing path — a throwing `beforeAll`,
 * as in `locks-cli.integration.test.ts` and
 * `phase-registry.integration.test.ts`. The `skipIf(!distExists)` pattern
 * instead reports green with the gate silently vanished; before #842 it had
 * even produced a test that could never fail under any condition
 * (`describe.skipIf(!distExists)` wrapping `expect(distExists).toBe(true)` —
 * skipped in exactly the case it would have failed).
 *
 * This walks every test file under src/ and scripts/ and fails on any
 * dist-conditioned skipIf, naming the offender and the replacement pattern.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

// Built dynamically so this file cannot match itself even if the walker's
// self-exclusion were removed.
const FORBIDDEN = new RegExp(String.raw`\.skipIf\s*\(\s*!?\s*dist`, "i");
const SELF = path.resolve(__dirname, "dist-skip-guard.test.ts");

/**
 * Comments don't skip tests — only code does. The files fixed by #842 carry
 * explanatory comments that quote the forbidden pattern verbatim ("rather than
 * `describe.skipIf(!distExists)` ..."), and those must not re-trip the guard.
 * A commented-out `skipIf` is likewise inert. Block comments are stripped
 * whole; line comments from `//` to end of line.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function collectTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (/\.test\.tsx?$/.test(entry.name) && full !== SELF) {
      out.push(full);
    }
  }
  return out;
}

describe("dist-skip guard (#842 AC-6)", () => {
  it("no test file conditions a skipIf on dist/ existence", () => {
    const roots = ["src", "scripts"].map((d) => path.join(REPO_ROOT, d));
    const offenders: string[] = [];

    for (const root of roots) {
      for (const file of collectTestFiles(root)) {
        const code = stripComments(fs.readFileSync(file, "utf-8"));
        if (FORBIDDEN.test(code)) {
          // Line numbers shift after stripping, so report against the
          // comment-stripped text — close enough to locate the call.
          const line = code.slice(0, code.search(FORBIDDEN)).split("\n").length;
          offenders.push(`${path.relative(REPO_ROOT, file)}:~${line}`);
        }
      }
    }

    expect(
      offenders,
      `skipIf(!distExists)-style guards silently vanish when dist/ is absent. ` +
        `Replace with a throwing beforeAll (see phase-registry.integration.test.ts):\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("the guard itself detects the forbidden pattern (self-test)", () => {
    expect(FORBIDDEN.test("describe.skipIf(!distExists)(")).toBe(true);
    expect(FORBIDDEN.test("it.skipIf(!distExists)(")).toBe(true);
    expect(FORBIDDEN.test("it.skipIf( ! distMissing )")).toBe(true);
    // Prose in comments quoting the pattern must not trip the guard.
    expect(
      FORBIDDEN.test(
        stripComments("// rather than `describe.skipIf(!distExists)` —\nit("),
      ),
    ).toBe(false);
    expect(
      FORBIDDEN.test(
        stripComments("/* it.skipIf(!distExists) was the old shape */\nit("),
      ),
    ).toBe(false);
    // Non-dist skips are a separate judgment call and stay allowed.
    expect(
      FORBIDDEN.test('describe.skipIf(process.platform === "win32")'),
    ).toBe(false);
    expect(FORBIDDEN.test("describe.skipIf(!mcpSdkAvailable)")).toBe(false);
  });
});
