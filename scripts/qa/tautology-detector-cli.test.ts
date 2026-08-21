/**
 * Integration tests for Test Tautology Detector CLI
 */
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";

const CLI_PATH = path.resolve(__dirname, "tautology-detector-cli.ts");

function runCli(
  args: string[] = [],
  env: Record<string, string> = {},
): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`npx tsx ${CLI_PATH} ${args.join(" ")}`, {
      encoding: "utf-8",
      cwd: path.resolve(__dirname, "../.."),
      timeout: 30000,
      env: { ...process.env, ...env },
    });
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (error: unknown) {
    const execError = error as { stdout?: string; status?: number };
    return {
      stdout: (execError.stdout || "").trim(),
      exitCode: execError.status || 1,
    };
  }
}

// #842 AC-3: the 30 s child timeout above must be strictly below the vitest
// timeout, or whichever fires first is a coin flip. This file is in the
// `integration` project, whose floor is also 30 s — equal, not greater — so it
// states its own ceiling rather than relying on that floor.
describe("tautology-detector-cli", { timeout: 60_000 }, () => {
  it("runs with --json flag and produces valid JSON", () => {
    const { stdout, exitCode } = runCli(["--json"]);
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("status");
    expect(parsed).toHaveProperty("summary");
    expect(parsed.summary).toHaveProperty("totalFiles");
    expect(parsed.summary).toHaveProperty("totalTests");
    expect(parsed.summary).toHaveProperty("totalTautological");
  });

  it("runs with default (markdown) output", () => {
    const { stdout, exitCode } = runCli();
    expect(exitCode).toBe(0);
    // Should produce a markdown table, "No test files changed", or (#940) a
    // "Cannot diff against base ref" skip message — CI's own shallow
    // (fetch-depth: 1) checkout of this build job leaves origin/main...HEAD
    // with no discoverable merge-base, which selectChangedTestFiles now
    // reports explicitly instead of collapsing into "no test files".
    expect(
      stdout.includes("Test Quality Review") ||
        stdout.includes("No test files changed") ||
        stdout.includes("Cannot diff against base ref"),
    ).toBe(true);
  });

  it("exits with code 0 when not blocking", () => {
    const { exitCode } = runCli(["--json"]);
    expect(exitCode).toBe(0);
  });

  it("--json summary fields are numbers", () => {
    const { stdout } = runCli(["--json"]);
    const parsed = JSON.parse(stdout);

    if (parsed.status !== "skip") {
      expect(typeof parsed.summary.totalFiles).toBe("number");
      expect(typeof parsed.summary.totalTests).toBe("number");
      expect(typeof parsed.summary.totalTautological).toBe("number");
      expect(typeof parsed.summary.overallPercentage).toBe("number");
      expect(typeof parsed.summary.exceedsBlockingThreshold).toBe("boolean");
    }
  });

  it("--json files array contains expected fields", () => {
    const { stdout } = runCli(["--json"]);
    const parsed = JSON.parse(stdout);

    if (parsed.files && parsed.files.length > 0) {
      const file = parsed.files[0];
      expect(file).toHaveProperty("path");
      expect(file).toHaveProperty("totalTests");
      expect(file).toHaveProperty("tautologicalCount");
      expect(file).toHaveProperty("tautologicalTests");
      expect(Array.isArray(file.tautologicalTests)).toBe(true);
    }
  });

  // #940 gap follow-up: --github was previously only exercised on real CI
  // runs where a diff happened to have changed test files. `--base HEAD`
  // deterministically produces zero changed files regardless of environment
  // (diffing a commit against itself), covering the --github + zero-files
  // combination this test file never spawned before.
  it("--github with zero changed test files writes the skip summary and marker to $GITHUB_STEP_SUMMARY", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tautology-cli-summary-"));
    const summaryFile = path.join(dir, "summary.md");
    writeFileSync(summaryFile, "");

    try {
      const { exitCode } = runCli(
        ["--base", "HEAD", "--advisory", "--github"],
        {
          GITHUB_STEP_SUMMARY: summaryFile,
        },
      );
      expect(exitCode).toBe(0);

      const content = readFileSync(summaryFile, "utf-8");
      expect(content).toContain("No test files changed in diff");
      expect(content).toMatch(
        /<!-- TAUTOLOGY_SUMMARY \{"filesScanned":0,"totalTests":0,"findings":0,"skipped":0,"score":0,"reason":"no-test-files"\} -->/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
