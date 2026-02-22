/**
 * Merge check orchestrator
 *
 * Coordinates all merge-check modules and resolves branches
 * from run logs and git state.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";
import {
  RunLogSchema,
  type RunLog,
  LOG_PATHS,
} from "../workflow/run-log-schema.js";
import { getGitDiffStats } from "../workflow/git-diff-utils.js";
import type {
  BranchInfo,
  CheckResult,
  MergeCommandOptions,
  MergeReport,
} from "./types.js";
import { DEFAULT_MIRROR_PAIRS } from "./types.js";
import { runCombinedBranchTest } from "./combined-branch-test.js";
import { runMirroringCheck } from "./mirroring-check.js";
import { runOverlapDetection } from "./overlap-detection.js";
import { runResidualPatternScan } from "./residual-pattern-scan.js";
import {
  buildReport,
  formatReportMarkdown,
  formatBranchReportMarkdown,
  postReportToGitHub,
} from "./report.js";

/**
 * Resolve log directory path
 */
function resolveLogDir(customPath?: string): string {
  if (customPath) {
    return customPath.replace("~", os.homedir());
  }
  const projectPath = LOG_PATHS.project;
  if (fs.existsSync(projectPath)) {
    return projectPath;
  }
  const userPath = LOG_PATHS.user.replace("~", os.homedir());
  if (fs.existsSync(userPath)) {
    return userPath;
  }
  return projectPath;
}

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
 * Resolve branches from issue numbers.
 *
 * Uses git worktree list and remote branch patterns to find
 * the feature branches for each issue.
 */
export function resolveBranches(
  issueNumbers: number[],
  repoRoot: string,
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

    if (worktreePath) {
      // Use worktree for diff
      const diffStats = getGitDiffStats(worktreePath);
      filesModified = diffStats.filesModified;
    } else {
      // Use remote branch diff
      const diffResult = spawnSync(
        "git",
        [
          "-C",
          repoRoot,
          "diff",
          "--name-only",
          `origin/main...origin/${branch}`,
        ],
        { stdio: "pipe", encoding: "utf-8" },
      );
      filesModified = diffResult.stdout
        ? diffResult.stdout.split("\n").filter(Boolean)
        : [];
    }

    const info = issueInfo.get(issueNumber);
    const title =
      info?.title ?? fetchIssueTitle(issueNumber) ?? `Issue #${issueNumber}`;

    branches.push({
      issueNumber,
      title,
      branch,
      worktreePath,
      prNumber: info?.prNumber,
      filesModified,
    });
  }

  return branches;
}

/**
 * Fetch issue title from GitHub via gh CLI.
 * Returns null if gh is not available or the issue doesn't exist.
 */
function fetchIssueTitle(issueNumber: number): string | null {
  const result = spawnSync(
    "gh",
    ["issue", "view", String(issueNumber), "--json", "title", "--jq", ".title"],
    { stdio: "pipe", encoding: "utf-8", timeout: 10_000 },
  );
  if (result.status !== 0 || !result.stdout?.trim()) {
    return null;
  }
  return result.stdout.trim();
}

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
  const phase1 = ["combined-branch-test", "mirroring", "overlap-detection"];
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
  let runLog: RunLog | null = null;

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

  // Resolve branches for each issue
  const branches = resolveBranches(issueNumbers, repoRoot, runLog);

  if (branches.length === 0) {
    throw new Error(
      "No feature branches found for the specified issues. " +
        "Ensure branches exist (pushed to remote or in local worktrees).",
    );
  }

  // Determine which checks to run
  const checksToRun = getChecksToRun(options);
  const checkResults: CheckResult[] = [];

  // Phase 1: Deterministic checks
  if (checksToRun.includes("combined-branch-test")) {
    checkResults.push(runCombinedBranchTest(branches, repoRoot));
  }

  if (checksToRun.includes("mirroring")) {
    checkResults.push(runMirroringCheck(branches, DEFAULT_MIRROR_PAIRS));
  }

  if (checksToRun.includes("overlap-detection")) {
    checkResults.push(runOverlapDetection(branches, repoRoot));
  }

  // Phase 2: Residual pattern detection
  if (checksToRun.includes("residual-pattern-scan")) {
    checkResults.push(runResidualPatternScan(branches, repoRoot));
  }

  // Build report
  const report = buildReport(branches, checkResults, runLog?.runId);

  // Post to GitHub if requested
  if (options.post) {
    postReportToGitHub(report);
  }

  return report;
}

// Re-export types and utilities for external use
export type { MergeReport, MergeCommandOptions, BranchInfo, CheckResult };
export { formatReportMarkdown, formatBranchReportMarkdown, postReportToGitHub };
