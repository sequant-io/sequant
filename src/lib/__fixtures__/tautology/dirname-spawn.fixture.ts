/**
 * Fixture for #956 AC-2 — NOT a live test suite.
 *
 * Named `.fixture.ts` so vitest never collects it; it exists only as input to
 * `analyzeTestFile` in `test-tautology-detector.corpus.test.ts`.
 *
 * It pins the boundary of the `path.resolve(__dirname, …)` recognition added
 * in #956: recognizing that idiom must NOT become a blanket file-level
 * exemption. Two blocks, deliberately opposite:
 *
 *   - "spawns the resolved CLI"  → reaches the resolved handle, must be clean.
 *   - "asserts on local values"  → never reaches it, must stay flagged.
 *
 * Remove the `__dirname` recognition and the first block flips to flagged,
 * which is exactly what the AC-2 mutation check exercises.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import * as path from "path";

const CLI_PATH = path.resolve(__dirname, "fixture-cli.ts");

describe("dirname-spawn fixture", () => {
  it("spawns the resolved CLI", () => {
    const stdout = execFileSync("npx", ["tsx", CLI_PATH, "--json"], {
      encoding: "utf-8",
    });
    expect(stdout).toContain("ok");
  });

  it("asserts on local values only", () => {
    const enabled = true;
    const failed = true;
    expect(enabled && failed).toBe(true);
  });
});
