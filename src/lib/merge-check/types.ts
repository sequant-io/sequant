/**
 * Types for merge-check module
 *
 * Shared type definitions for batch-level integration QA checks.
 */

/**
 * Information about a feature branch in a batch
 */
export interface BranchInfo {
  /** GitHub issue number */
  issueNumber: number;
  /** Issue title */
  title: string;
  /** Git branch name */
  branch: string;
  /** Worktree path (if available) */
  worktreePath?: string;
  /** PR number (if created) */
  prNumber?: number;
  /** Files modified compared to base branch */
  filesModified: string[];
}

/**
 * Per-issue verdict from a check
 */
export type CheckVerdict = "PASS" | "WARN" | "FAIL";

/**
 * Batch-level verdict
 */
export type BatchVerdict = "READY" | "NEEDS_ATTENTION" | "BLOCKED";

/**
 * A single finding from a check
 */
export interface CheckFinding {
  /** Which check produced this finding */
  check: string;
  /** Severity level */
  severity: "error" | "warning" | "info";
  /** Human-readable description */
  message: string;
  /** Affected file path (if applicable) */
  file?: string;
  /** Line number (if applicable) */
  line?: number;
  /** Related issue number */
  issueNumber?: number;
}

/**
 * Result from a single check for a single branch
 */
export interface BranchCheckResult {
  /** Issue number */
  issueNumber: number;
  /** Verdict for this branch */
  verdict: CheckVerdict;
  /** Findings for this branch */
  findings: CheckFinding[];
}

/**
 * Result from running a check across all branches
 */
export interface CheckResult {
  /** Check name (e.g., "combined-branch-test", "mirroring") */
  name: string;
  /** Whether the check passed overall */
  passed: boolean;
  /** Per-branch results */
  branchResults: BranchCheckResult[];
  /** Batch-level findings (cross-branch) */
  batchFindings: CheckFinding[];
  /** Duration of the check in milliseconds */
  durationMs: number;
}

/**
 * A pattern extracted from a diff for residual scanning
 */
export interface ExtractedPattern {
  /** The literal string pattern */
  pattern: string;
  /** File where it was removed */
  sourceFile: string;
  /** Issue that was supposed to fix it */
  issueNumber: number;
}

/**
 * A residual match found in the codebase
 */
export interface ResidualMatch {
  /** Pattern that matched */
  pattern: string;
  /** File where the match was found */
  file: string;
  /** Line number */
  line: number;
  /** The matching line content */
  content: string;
  /** Issue that was supposed to fix this pattern */
  issueNumber: number;
}

/**
 * File overlap between branches
 */
export interface FileOverlap {
  /** File path */
  file: string;
  /** Issues that modified this file */
  issues: number[];
  /** Whether the overlap is additive or conflicting */
  type: "additive" | "conflicting";
}

/**
 * Unmirrored change between paired directories
 */
export interface UnmirroredChange {
  /** Source file that was modified */
  sourceFile: string;
  /** Expected mirror target file */
  targetFile: string;
  /** Direction of the mismatch */
  direction: "source-only" | "target-only";
  /** Issue that made the change */
  issueNumber: number;
}

/**
 * Complete merge readiness report
 */
export interface MergeReport {
  /** Run ID from the run log (if available) */
  runId?: string;
  /** Timestamp of report generation */
  timestamp: string;
  /** Branches in the batch */
  branches: BranchInfo[];
  /** Results from each check */
  checks: CheckResult[];
  /** Per-issue verdicts */
  issueVerdicts: Map<number, CheckVerdict>;
  /** Overall batch verdict */
  batchVerdict: BatchVerdict;
  /** Summary of all findings */
  findings: CheckFinding[];
}

/**
 * Options for the merge command
 */
export interface MergeCommandOptions {
  /** Run Phase 1 deterministic checks */
  check?: boolean;
  /** Run Phase 1 + Phase 2 residual pattern detection */
  scan?: boolean;
  /** Run Phase 1 + 2 + 3 AI briefing (stub for now) */
  review?: boolean;
  /** Run all phases */
  all?: boolean;
  /** Post report to GitHub as PR comments */
  post?: boolean;
  /** Output as JSON */
  json?: boolean;
  /** Enable verbose output */
  verbose?: boolean;
}

/**
 * Configuration for paired directories (template mirroring)
 */
export interface MirrorPair {
  /** Source directory */
  source: string;
  /** Target directory */
  target: string;
}

/**
 * Default mirror pairs for this project
 */
export const DEFAULT_MIRROR_PAIRS: MirrorPair[] = [
  { source: ".claude/skills", target: "templates/skills" },
  { source: "hooks", target: "templates/hooks" },
];

/**
 * Get the git ref to use for diff/merge operations on a branch.
 *
 * Worktree-only branches (not pushed to remote) exist as local refs,
 * so we use the branch name directly. Branches that have been pushed
 * use the remote ref for consistency.
 */
export function getBranchRef(branch: BranchInfo): string {
  return branch.worktreePath ? branch.branch : `origin/${branch.branch}`;
}
