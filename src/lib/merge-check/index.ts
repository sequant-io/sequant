/**
 * Merge check orchestrator
 *
 * Coordinates all merge-check modules and resolves branches
 * from run logs and git state.
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { GitHubProvider } from "../workflow/platforms/github.js";
import {
  RunLogSchema,
  type RunLog,
} from "../workflow/run-log-schema.js";
import { resolveLogDir } from "../run-logs.js";
import { detectDefaultBranch } from "../workflow/worktree-manager.js";
import type {
  BranchInfo,
  BranchCheckResult,
  CheckResult,
  MergeCommandOptions,
  MergeReport,
} from "./types.js";
import { DEFAULT_MIRROR_PAIRS } from "./types.js";
import { runCombinedBranchTest } from "./combined-branch-test.js";
import { runMirroringCheck } from "./mirroring-check.js";
import {
  runExternalPrOverlap,
  runOverlapDetection,
} from "./overlap-detection.js";
import { runResidualPatternScan } from "./residual-pattern-scan.js";
import {
  buildReport,
  formatReportMarkdown,
  formatBranchReportMarkdown,
  postReportToGitHub,
} from "./report.js";

/**
 * Find the most recent run log file
 */
export function findMostRecentLog(logDir: string): RunLog | null {
  if (!fs.existsSync(logDir)) {
    return null;
  }

  const files = fs
    .readdirSync(logDir)
    .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
    .sort()
    .reverse();

  if (files.length === 0) {
    return null;
  }

  const content = fs.readFileSync(path.join(logDir, files[0]), "utf-8");
  const parsed = RunLogSchema.safeParse(JSON.parse(content));
  if (!parsed.success) {
    return null;
  }

  return parsed.data;
}

/**
 * The base every merge-check diff and the combined branch are taken against:
 * the repo's default branch on origin (`origin/<default>`).
 * Resolved at the repo root, not per branch, because a batch check has one base.
 */
export function resolveMergeBaseRef(repoRoot: string): string {
  return `origin/${detectDefaultBranch(false, repoRoot)}`;
}

/**
 * Resolve branches from issue numbers.
 *
 * Uses git worktree list and remote branch patterns to find
 * the feature branches for each issue.
 */
export function resolveBranches(
  issueNumbers: number[],
  repoRoot: string,
  baseRef: string,
  runLog?: RunLog | null,
): BranchInfo[] {
  const branches: BranchInfo[] = [];

  // Get remote branches matching feature pattern
  const branchResult = spawnSync(
    "git",
    ["-C", repoRoot, "branch", "-r", "--list", "origin/feature/*"],
    { stdio: "pipe", encoding: "utf-8" },
  );

  const remoteBranches = branchResult.stdout
    ? branchResult.stdout
        .split("\n")
        .map((b) => b.trim().replace("origin/", ""))
        .filter(Boolean)
    : [];

  // Also check worktrees for local-only branches
  const worktreeResult = spawnSync(
    "git",
    ["-C", repoRoot, "worktree", "list", "--porcelain"],
    { stdio: "pipe", encoding: "utf-8" },
  );

  const worktreePaths = new Map<string, string>();
  let currentPath = "";
  for (const line of (worktreeResult.stdout ?? "").split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice(9);
    } else if (line.startsWith("branch refs/heads/")) {
      const branch = line.slice(18);
      worktreePaths.set(branch, currentPath);
    }
  }

  // Get run log issue info for titles
  const issueInfo = new Map<number, { title: string; prNumber?: number }>();
  if (runLog) {
    for (const issue of runLog.issues) {
      issueInfo.set(issue.issueNumber, {
        title: issue.title,
        prNumber: issue.prNumber,
      });
    }
  }

  for (const issueNumber of issueNumbers) {
    // Find the branch for this issue
    const branchPattern = new RegExp(`^feature/${issueNumber}-`);
    const branch =
      remoteBranches.find((b) => branchPattern.test(b)) ??
      Array.from(worktreePaths.keys()).find((b) => branchPattern.test(b));

    if (!branch) {
      console.error(`No branch found for issue #${issueNumber}`);
      continue;
    }

    // Get modified files from the branch
    const worktreePath = worktreePaths.get(branch);
    let filesModified: string[] = [];
    let filesModifiedError: string | undefined;

    // The worktree's HEAD when one holds the branch, else the remote branch.
    const diffArgs = worktreePath
      ? ["-C", worktreePath, "diff", "--name-only", `${baseRef}...HEAD`]
      : [
          "-C",
          repoRoot,
          "diff",
          "--name-only",
          `${baseRef}...origin/${branch}`,
        ];
    const diffResult = spawnSync("git", diffArgs, {
      stdio: "pipe",
      encoding: "utf-8",
    });
    if (diffResult.status === 0) {
      filesModified = diffResult.stdout.split("\n").filter(Boolean);
    } else {
      // An empty list here would read as "no changes" to every overlap check.
      filesModifiedError = `git ${diffArgs.join(" ")}`;
    }

    const info = issueInfo.get(issueNumber);
    const title =
      info?.title ??
      ghProvider.fetchIssueTitleSync(String(issueNumber)) ??
      `Issue #${issueNumber}`;

    branches.push({
      issueNumber,
      title,
      branch,
      worktreePath,
      prNumber: info?.prNumber,
      filesModified,
      ...(filesModifiedError ? { filesModifiedError } : {}),
    });
  }

  return branches;
}

/** Shared GitHubProvider instance for issue title lookups. */
const ghProvider = new GitHubProvider();

/**
 * Determine which checks to run based on command options.
 *
 * --scan, --review, and --all currently return the same checks because
 * Phase 3 (AI briefing) is not yet implemented. When Phase 3 is added,
 * --review and --all will include additional AI-powered checks.
 * The distinction is preserved so callers can detect review mode
 * and show the Phase 3 stub message (see merge.ts).
 */
export function getChecksToRun(options: MergeCommandOptions): string[] {
  const phase1 = [
    "combined-branch-test",
    "mirroring",
    "overlap-detection",
    "external-pr-overlap",
  ];
  const phase2 = ["residual-pattern-scan"];
  // Phase 3 checks will be added here when AI briefing is implemented
  // const phase3 = ["ai-briefing"];

  if (options.all || options.review || options.scan) {
    return [...phase1, ...phase2];
  }
  // Default --check: Phase 1 only
  return phase1;
}

/**
 * Report branches whose `filesModified` diff failed (AC-3, #1484).
 * Returns null when every diff succeeded.
 */
function buildDiffFailureResult(branches: BranchInfo[]): CheckResult | null {
  const failed = branches.filter((b) => b.filesModifiedError);
  if (failed.length === 0) return null;
  const branchResults: BranchCheckResult[] = failed.map((b) => ({
    issueNumber: b.issueNumber,
    verdict: "FAIL",
    findings: [
      {
        check: "branch-diff",
        severity: "error",
        message: `Could not compute files modified for ${b.branch}: \`${b.filesModifiedError}\` failed (base ref does not resolve?)`,
        issueNumber: b.issueNumber,
      },
    ],
  }));
  return {
    name: "branch-diff",
    passed: false,
    branchResults,
    batchFindings: [],
    durationMs: 0,
  };
}

/**
 * Run all merge checks and produce a report.
 *
 * @param issueNumbers - Issue numbers to check (empty = auto-detect from most recent run)
 * @param options - Command options controlling which checks to run
 * @param repoRoot - Path to the git repository root
 * @returns MergeReport with all findings
 */
export async function runMergeChecks(
  issueNumbers: number[],
  options: MergeCommandOptions,
  repoRoot: string,
): Promise<MergeReport> {
  const logDir = resolveLogDir();
  let runLog: RunLog | null;

  // Auto-detect issues from most recent run log if none specified
  if (issueNumbers.length === 0) {
    runLog = findMostRecentLog(logDir);
    if (!runLog) {
      throw new Error(
        "No run logs found. Specify issue numbers or run `sequant run` first.",
      );
    }
    issueNumbers = runLog.issues.map((i) => i.issueNumber);
  } else {
    // Still try to load run log for metadata
    runLog = findMostRecentLog(logDir);
  }

  // One base for the whole run, shared by every check below.
  const baseRef = resolveMergeBaseRef(repoRoot);

  // Resolve branches for each issue
  const branches = resolveBranches(issueNumbers, repoRoot, baseRef, runLog);

  if (branches.length === 0) {
    throw new Error(
      "No feature branches found for the specified issues. " +
        "Ensure branches exist (pushed to remote or in local worktrees).",
    );
  }

  // Determine which checks to run
  const checksToRun = getChecksToRun(options);
  const checkResults: CheckResult[] = [];

  // A failed `filesModified` diff is an error, never a silent empty list.
  const diffFailures = buildDiffFailureResult(branches);
  if (diffFailures) {
    checkResults.push(diffFailures);
  }

  // Phase 1: Deterministic checks
  if (checksToRun.includes("combined-branch-test")) {
    checkResults.push(runCombinedBranchTest(branches, repoRoot, baseRef));
  }

  if (checksToRun.includes("mirroring")) {
    checkResults.push(runMirroringCheck(branches, DEFAULT_MIRROR_PAIRS));
  }

  if (checksToRun.includes("overlap-detection")) {
    checkResults.push(runOverlapDetection(branches, repoRoot, baseRef));
  }

  if (checksToRun.includes("external-pr-overlap")) {
    checkResults.push(runExternalPrOverlap(branches, ghProvider));
  }

  // Phase 2: Residual pattern detection
  if (checksToRun.includes("residual-pattern-scan")) {
    checkResults.push(runResidualPatternScan(branches, repoRoot, baseRef));
  }

  // Build report
  const report = buildReport(branches, checkResults, runLog?.runId);

  // Post to GitHub if requested
  if (options.post) {
    await postReportToGitHub(report, ghProvider);
  }

  return report;
}

// Re-export types and utilities for external use
export type { MergeReport, MergeCommandOptions, BranchInfo, CheckResult };
export { formatReportMarkdown, formatBranchReportMarkdown, postReportToGitHub };
