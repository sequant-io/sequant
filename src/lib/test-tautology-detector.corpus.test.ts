/**
 * Corpus tests for the tautology detector (#956).
 *
 * These run `analyzeTestFile` against *real repository files* rather than
 * inline snippets. That is the point: #885's and #966's fixes both passed
 * their inline unit tests while the live CI job kept flagging real
 * subprocess-driven suites, because the constructions that defeat the
 * detector (`path.resolve(__dirname, …)`, `join(REPO_ROOT, "hooks", "x.sh")`)
 * only appear at repo scale.
 *
 * Paths are resolved from this file's own location, never `process.cwd()`, so
 * the verdicts do not depend on where vitest was invoked.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { analyzeTestFile } from "./test-tautology-detector.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

function analyzeRepoFile(relativePath: string) {
  const absolute = join(REPO_ROOT, relativePath);
  return analyzeTestFile(readFileSync(absolute, "utf-8"), absolute);
}

describe("tautology detector corpus (#956)", () => {
  it("956 target: the CLI test whose spawn path is built from __dirname scores 0", () => {
    const result = analyzeRepoFile("scripts/qa/tautology-detector-cli.test.ts");

    // The live regression: every block here spawns `CLI_PATH`, declared as
    // `path.resolve(__dirname, "tautology-detector-cli.ts")`. Before #956 the
    // textual scan found no `scripts/` substring in that RHS and reported
    // 6/6 tautological on the advisory job's first successful CI run.
    expect(result.parseSuccess).toBe(true);
    expect(result.totalTests).toBeGreaterThan(0);
    expect(result.tautologicalCount).toBe(0);
  });

  it("956 negative: the same __dirname idiom is not a blanket file exemption", () => {
    const result = analyzeRepoFile(
      "src/lib/__fixtures__/tautology/dirname-spawn.fixture.ts",
    );

    expect(result.parseSuccess).toBe(true);
    expect(result.totalTests).toBe(2);

    const byDescription = new Map(
      result.testBlocks.map((block) => [block.description, block]),
    );
    // Reaches the resolved handle → recognized as production.
    expect(byDescription.get("spawns the resolved CLI")?.isTautological).toBe(
      false,
    );
    // Never reaches it → still flagged, despite living in the same file.
    expect(
      byDescription.get("asserts on local values only")?.isTautological,
    ).toBe(true);
  });

  it("956 segments: segment-built join() paths and call-site argument binding are recognized", () => {
    const result = analyzeRepoFile(
      "__tests__/pre-tool-hook.integration.test.ts",
    );

    // The #966 remainder: `join(REPO_ROOT, "hooks", "pre-tool.sh")` leaves no
    // contiguous `hooks/pre-tool.sh` substring, and `run(preHook, …)` binds
    // that value into a parameter named `hook`. Only the harness-sanity block
    // ("confirms jq is actually unavailable on the filtered PATH") is
    // legitimately flagged, so the ceiling is 1 rather than 0.
    expect(result.parseSuccess).toBe(true);
    expect(result.totalTests).toBeGreaterThan(0);
    expect(result.tautologicalCount).toBeLessThanOrEqual(1);
  });
});
