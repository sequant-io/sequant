/**
 * Cross-issue file overlap detection (AC-4)
 *
 * Compares git diff --name-only across all feature branches to detect
 * when multiple PRs modify the same files. Classifies overlaps as
 * "additive" (different lines) or "conflicting" (same lines).
 */

import { spawnSync } from "child_process";
import type {
  BranchInfo,
  CheckResult,
  BranchCheckResult,
  CheckFinding,
  FileOverlap,
} from "./types.js";
import { getBranchRef } from "./types.js";

/**
 * Parse git diff hunk headers to extract changed line ranges.
 * Returns an array of [start, end] tuples.
 */
function getChangedLineRanges(
  branchRef: string,
  file: string,
  repoRoot: string,
): Array<[number, number]> {
  const result = spawnSync(
    "git",
    [
      "-C",
      repoRoot,
      "diff",
      "--unified=0",
      `origin/main...${branchRef}`,
      "--",
      file,
    ],
    { stdio: "pipe", encoding: "utf-8" },
  );
  if (result.status !== 0 || !result.stdout) {
    return [];
  }
  const ranges: Array<[number, number]> = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^@@\s+[^\s]+\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (match) {
      const start = parseInt(match[1], 10);
      const count = match[2] ? parseInt(match[2], 10) : 1;
      if (count > 0) {
        ranges.push([start, start + count - 1]);
      }
    }
  }
  return ranges;
}

/**
 * Check if any ranges from two sets overlap.
 */
export function rangesOverlap(
  a: Array<[number, number]>,
  b: Array<[number, number]>,
): boolean {
  for (const [aStart, aEnd] of a) {
    for (const [bStart, bEnd] of b) {
      if (aStart <= bEnd && bStart <= aEnd) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Classify overlap as "conflicting" (same lines) or "additive" (different lines).
 */
function classifyOverlap(
  file: string,
  issueBranches: BranchInfo[],
  repoRoot: string,
): "additive" | "conflicting" {
  const rangesByIssue = issueBranches.map((b) => ({
    issueNumber: b.issueNumber,
    ranges: getChangedLineRanges(getBranchRef(b), file, repoRoot),
  }));

  for (let i = 0; i < rangesByIssue.length; i++) {
    for (let j = i + 1; j < rangesByIssue.length; j++) {
      if (rangesOverlap(rangesByIssue[i].ranges, rangesByIssue[j].ranges)) {
        return "conflicting";
      }
    }
  }
  return "additive";
}

/**
 * Run overlap detection across all branches.
 *
 * Builds a map of file -> issues, then flags files with multiple modifiers.
 * Overlaps are classified as "additive" (different lines changed) or
 * "conflicting" (same lines changed) using git diff hunk analysis.
 */
export function runOverlapDetection(
  branches: BranchInfo[],
  repoRoot: string,
): CheckResult {
  const startTime = Date.now();
  const branchResults: BranchCheckResult[] = [];
  const batchFindings: CheckFinding[] = [];

  // Build file -> issues map
  const fileToIssues = new Map<string, number[]>();
  for (const branch of branches) {
    for (const file of branch.filesModified) {
      const existing = fileToIssues.get(file) ?? [];
      existing.push(branch.issueNumber);
      fileToIssues.set(file, existing);
    }
  }

  // Find overlapping files (modified by 2+ issues)
  const overlaps: FileOverlap[] = [];
  for (const [file, issues] of fileToIssues) {
    if (issues.length >= 2) {
      const issueBranches = issues
        .map((iss) => branches.find((b) => b.issueNumber === iss))
        .filter((b): b is BranchInfo => b !== undefined);
      overlaps.push({
        file,
        issues,
        type: classifyOverlap(file, issueBranches, repoRoot),
      });
    }
  }

  // Report overlaps as batch findings
  if (overlaps.length === 0) {
    batchFindings.push({
      check: "overlap-detection",
      severity: "info",
      message: "No file overlaps detected across branches",
    });
  } else {
    for (const overlap of overlaps) {
      batchFindings.push({
        check: "overlap-detection",
        severity: "warning",
        message: `${overlap.file} modified by issues ${overlap.issues.map((i) => `#${i}`).join(", ")} (${overlap.type})`,
        file: overlap.file,
      });
    }
  }

  // Per-branch: flag which branches participate in overlaps
  for (const branch of branches) {
    const branchOverlaps = overlaps.filter((o) =>
      o.issues.includes(branch.issueNumber),
    );
    const findings: CheckFinding[] = branchOverlaps.map((o) => ({
      check: "overlap-detection",
      severity: "warning" as const,
      message: `Overlaps with ${o.issues
        .filter((i) => i !== branch.issueNumber)
        .map((i) => `#${i}`)
        .join(", ")} on ${o.file}`,
      file: o.file,
      issueNumber: branch.issueNumber,
    }));

    branchResults.push({
      issueNumber: branch.issueNumber,
      verdict: branchOverlaps.length > 0 ? "WARN" : "PASS",
      findings,
    });
  }

  return {
    name: "overlap-detection",
    passed: overlaps.length === 0,
    branchResults,
    batchFindings,
    durationMs: Date.now() - startTime,
  };
}
