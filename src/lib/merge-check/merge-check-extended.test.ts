/**
 * Extended tests for merge-check modules
 *
 * Covers: getExitCode, getChecksToRun, buildResult, extractPatternsFromDiff,
 * rangesOverlap, findMostRecentLog, formatBranchReportMarkdown
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getExitCode } from "../../commands/merge.js";
import { getChecksToRun, findMostRecentLog } from "./index.js";
import { buildResult } from "./combined-branch-test.js";
import { rangesOverlap } from "./overlap-detection.js";
import { formatBranchReportMarkdown, buildReport } from "./report.js";
import { getBranchRef } from "./types.js";
import type { BranchInfo, CheckResult, MergeCommandOptions } from "./types.js";

// Mock child_process for extractPatternsFromDiff tests
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

import { spawnSync } from "child_process";
import { extractPatternsFromDiff } from "./residual-pattern-scan.js";

const mockSpawnSync = vi.mocked(spawnSync);

// ============================================================================
// getBranchRef Tests
// ============================================================================

describe("getBranchRef", () => {
  it("should return origin/ prefix for remote-only branches", () => {
    const branch: BranchInfo = {
      issueNumber: 100,
      title: "Test",
      branch: "feature/100-test",
      filesModified: [],
    };
    expect(getBranchRef(branch)).toBe("origin/feature/100-test");
  });

  it("should return bare branch name for worktree branches", () => {
    const branch: BranchInfo = {
      issueNumber: 200,
      title: "Test",
      branch: "feature/200-test",
      filesModified: [],
      worktreePath: "/some/worktree/path",
    };
    expect(getBranchRef(branch)).toBe("feature/200-test");
  });
});

// ============================================================================
// getExitCode Tests
// ============================================================================

describe("getExitCode", () => {
  it("should return 0 for READY", () => {
    expect(getExitCode("READY")).toBe(0);
  });

  it("should return 1 for NEEDS_ATTENTION", () => {
    expect(getExitCode("NEEDS_ATTENTION")).toBe(1);
  });

  it("should return 2 for BLOCKED", () => {
    expect(getExitCode("BLOCKED")).toBe(2);
  });

  it("should return 1 for unknown verdict", () => {
    expect(getExitCode("SOMETHING_ELSE")).toBe(1);
  });
});

// ============================================================================
// getChecksToRun Tests
// ============================================================================

describe("getChecksToRun", () => {
  it("should return phase 1 checks for --check", () => {
    const options: MergeCommandOptions = { check: true };
    const checks = getChecksToRun(options);
    expect(checks).toHaveLength(3);
    expect(checks).toContain("combined-branch-test");
    expect(checks).toContain("mirroring");
    expect(checks).toContain("overlap-detection");
    expect(checks).not.toContain("residual-pattern-scan");
  });

  it("should return phase 1+2 checks for --scan", () => {
    const options: MergeCommandOptions = { scan: true };
    const checks = getChecksToRun(options);
    expect(checks).toHaveLength(4);
    expect(checks).toContain("residual-pattern-scan");
  });

  it("should return phase 1+2 checks for --review", () => {
    const options: MergeCommandOptions = { review: true };
    const checks = getChecksToRun(options);
    expect(checks).toHaveLength(4);
    expect(checks).toContain("residual-pattern-scan");
  });

  it("should return phase 1+2 checks for --all", () => {
    const options: MergeCommandOptions = { all: true };
    const checks = getChecksToRun(options);
    expect(checks).toHaveLength(4);
    expect(checks).toContain("residual-pattern-scan");
  });

  it("should return phase 1 only when no flags set", () => {
    const options: MergeCommandOptions = {};
    const checks = getChecksToRun(options);
    expect(checks).toHaveLength(3);
  });
});

// ============================================================================
// buildResult Tests
// ============================================================================

describe("buildResult", () => {
  it("should set passed=true when no errors in findings", () => {
    const result = buildResult(
      [],
      [{ check: "test", severity: "info", message: "ok" }],
      Date.now() - 100,
    );
    expect(result.passed).toBe(true);
    expect(result.name).toBe("combined-branch-test");
  });

  it("should set passed=false when error findings exist", () => {
    const result = buildResult(
      [],
      [{ check: "test", severity: "error", message: "fail" }],
      Date.now() - 200,
    );
    expect(result.passed).toBe(false);
  });

  it("should compute positive durationMs", () => {
    const start = Date.now() - 500;
    const result = buildResult([], [], start);
    expect(result.durationMs).toBeGreaterThanOrEqual(400);
  });

  it("should pass through branchResults", () => {
    const br = [{ issueNumber: 1, verdict: "PASS" as const, findings: [] }];
    const result = buildResult(br, [], Date.now());
    expect(result.branchResults).toEqual(br);
  });
});

// ============================================================================
// extractPatternsFromDiff Tests
// ============================================================================

describe("extractPatternsFromDiff", () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  const makeBranch = (
    num: number,
    branch: string,
    worktreePath?: string,
  ): BranchInfo => ({
    issueNumber: num,
    title: `Test issue #${num}`,
    branch,
    filesModified: [],
    worktreePath,
  });

  it("should extract removed lines from diff output", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -10,3 +10,3 @@
-const oldFunction = () => {};
-const anotherOldThing = "value";
+const newFunction = () => {};`,
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    });

    const branch = makeBranch(1, "feature/1-test");
    const patterns = extractPatternsFromDiff(branch, "/tmp");
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    const patternTexts = patterns.map((p) => p.pattern);
    expect(patternTexts.some((p) => p.includes("oldFunction"))).toBe(true);
    // Verify issueNumber is propagated correctly
    expect(patterns.every((p) => p.issueNumber === 1)).toBe(true);
  });

  it("should skip short lines and imports", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,4 +1,1 @@
-import { foo } from "bar";
-x
-// a comment line
-const reallyLongFunctionNameThatShouldBeExtracted = true;`,
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    });

    const branch = makeBranch(2, "feature/2-test");
    const patterns = extractPatternsFromDiff(branch, "/tmp");
    const patternTexts = patterns.map((p) => p.pattern);
    expect(patternTexts.some((p) => p.includes("import"))).toBe(false);
    expect(patternTexts.some((p) => p === "x")).toBe(false);
    // Verify issueNumber propagation
    expect(patterns.every((p) => p.issueNumber === 2)).toBe(true);
  });

  it("should return empty array on git failure", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "fatal: bad revision",
      pid: 1,
      output: [],
      signal: null,
    });

    const branch = makeBranch(3, "feature/3-test");
    const patterns = extractPatternsFromDiff(branch, "/tmp");
    expect(patterns).toEqual([]);
  });

  it("should deduplicate patterns", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,1 @@
-const duplicatedLongPatternName = true;
-const duplicatedLongPatternName = true;`,
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    });

    const branch = makeBranch(4, "feature/4-test");
    const patterns = extractPatternsFromDiff(branch, "/tmp");
    const unique = new Set(patterns.map((p) => p.pattern));
    expect(unique.size).toBe(patterns.length);
    // Verify issueNumber propagation
    expect(patterns.every((p) => p.issueNumber === 4)).toBe(true);
  });
});

// ============================================================================
// rangesOverlap Tests
// ============================================================================

describe("rangesOverlap", () => {
  it("should return false for non-overlapping ranges", () => {
    expect(rangesOverlap([[1, 5]], [[6, 10]])).toBe(false);
  });

  it("should return true for overlapping ranges", () => {
    expect(rangesOverlap([[1, 5]], [[3, 8]])).toBe(true);
  });

  it("should return true for adjacent ranges (touching)", () => {
    expect(rangesOverlap([[1, 5]], [[5, 10]])).toBe(true);
  });

  it("should return false for empty range sets", () => {
    expect(rangesOverlap([], [[1, 5]])).toBe(false);
    expect(rangesOverlap([[1, 5]], [])).toBe(false);
    expect(rangesOverlap([], [])).toBe(false);
  });

  it("should handle multi-range overlap detection", () => {
    expect(
      rangesOverlap(
        [
          [1, 3],
          [10, 15],
        ],
        [
          [4, 9],
          [14, 20],
        ],
      ),
    ).toBe(true); // 10-15 overlaps with 14-20
  });

  it("should return false when multi-ranges don't overlap", () => {
    expect(
      rangesOverlap(
        [
          [1, 3],
          [10, 12],
        ],
        [
          [4, 9],
          [13, 20],
        ],
      ),
    ).toBe(false);
  });

  it("should detect contained range", () => {
    expect(rangesOverlap([[1, 100]], [[50, 60]])).toBe(true);
  });
});

// ============================================================================
// findMostRecentLog Tests
// ============================================================================

describe("findMostRecentLog", () => {
  it("should return null for nonexistent directory", () => {
    const result = findMostRecentLog("/nonexistent/path/that/does/not/exist");
    expect(result).toBeNull();
  });

  it("should return null for empty directory", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-check-test-"));
    try {
      const result = findMostRecentLog(tmpDir);
      expect(result).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ============================================================================
// formatBranchReportMarkdown Tests
// ============================================================================

describe("formatBranchReportMarkdown", () => {
  const branches: BranchInfo[] = [
    {
      issueNumber: 265,
      title: "Audit skill files",
      branch: "feature/265-audit",
      filesModified: [".claude/skills/qa/SKILL.md"],
      prNumber: 309,
    },
    {
      issueNumber: 298,
      title: "Add test tautology",
      branch: "feature/298-test",
      filesModified: ["src/lib/tautology.ts"],
      prNumber: 310,
    },
  ];

  const warningCheck: CheckResult = {
    name: "mirroring",
    passed: false,
    branchResults: [
      {
        issueNumber: 265,
        verdict: "WARN",
        findings: [
          {
            check: "mirroring",
            severity: "warning",
            message:
              "Modified .claude/skills/qa/SKILL.md but not templates/skills/qa/SKILL.md",
            issueNumber: 265,
          },
        ],
      },
      { issueNumber: 298, verdict: "PASS", findings: [] },
    ],
    batchFindings: [],
    durationMs: 50,
  };

  it("should filter findings to specified issue", () => {
    const report = buildReport(branches, [warningCheck]);
    const markdown = formatBranchReportMarkdown(report, 265);

    expect(markdown).toContain("#265");
    expect(markdown).toContain("Audit skill files");
    expect(markdown).toContain("templates/skills/qa/SKILL.md");
  });

  it("should not include other issue findings", () => {
    const report = buildReport(branches, [warningCheck]);
    const markdown = formatBranchReportMarkdown(report, 298);

    expect(markdown).toContain("#298");
    // Issue 298 has no findings, so should show all passed
    expect(markdown).toContain("All checks passed");
  });

  it("should include batch verdict header", () => {
    const report = buildReport(branches, [warningCheck]);
    const markdown = formatBranchReportMarkdown(report, 265);

    expect(markdown).toContain("Batch Verdict");
    expect(markdown).toContain("Issue Verdict");
  });

  it("should return message for unknown issue", () => {
    const report = buildReport(branches, [warningCheck]);
    const markdown = formatBranchReportMarkdown(report, 999);

    expect(markdown).toContain("No data for issue #999");
  });
});
