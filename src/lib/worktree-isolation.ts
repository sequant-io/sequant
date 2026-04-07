/**
 * Worktree isolation for parallel /exec agent groups.
 *
 * Provides sub-worktree creation, merge-back, and cleanup for
 * parallel agent execution, eliminating file conflicts structurally.
 *
 * @see https://github.com/sequant-io/sequant/issues/485
 */

import { execSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  rmdirSync,
} from "fs";
import { join, basename, dirname } from "path";

/** Result of creating a sub-worktree */
export interface SubWorktreeInfo {
  /** Absolute path to the sub-worktree */
  path: string;
  /** Branch name used for the sub-worktree */
  branch: string;
  /** Agent index within the parallel group */
  agentIndex: number;
}

/** Result of merging a single sub-worktree back */
export interface MergeResult {
  /** Whether the merge succeeded */
  success: boolean;
  /** Branch that was merged */
  branch: string;
  /** Agent index */
  agentIndex: number;
  /** Files that conflicted (empty if success) */
  conflictFiles: string[];
  /** Error message if merge failed */
  error?: string;
}

/** Aggregate result of merging all sub-worktrees */
export interface MergeBackResult {
  /** Number of agents that merged successfully */
  merged: number;
  /** Number of agents with conflicts */
  conflicts: number;
  /** Per-agent merge results */
  results: MergeResult[];
}

/**
 * Directory name for sub-worktrees inside the issue worktree.
 * This directory is nested inside the issue worktree for locality.
 */
export const SUB_WORKTREE_DIR = ".exec-agents";

/**
 * Default files to copy into sub-worktrees when no .worktreeinclude exists.
 * Matches the pattern in scripts/dev/new-feature.sh.
 */
const DEFAULT_INCLUDE_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".claude/settings.local.json",
];

/** Name of the worktree include file */
export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

/**
 * Read the list of files to copy into sub-worktrees.
 *
 * Reads from .worktreeinclude if it exists (one path per line, # comments),
 * otherwise returns the hardcoded default list.
 */
export function getIncludeFiles(worktreePath: string): string[] {
  const includeFile = join(worktreePath, WORKTREE_INCLUDE_FILE);
  if (!existsSync(includeFile)) {
    return DEFAULT_INCLUDE_FILES;
  }
  try {
    return readFileSync(includeFile, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return DEFAULT_INCLUDE_FILES;
  }
}

/**
 * Run a git command and return stdout, trimmed.
 * Throws on non-zero exit code.
 */
function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/**
 * Run a git command and return success/failure without throwing.
 */
function gitSafe(
  args: string,
  cwd: string,
): { success: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execSync(`git ${args}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { success: true, stdout, stderr: "" };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string };
    return {
      success: false,
      stdout: (error.stdout as string) ?? "",
      stderr: (error.stderr as string) ?? "",
    };
  }
}

/**
 * Generate a branch name for a sub-worktree agent.
 *
 * @param issueWorktreePath - Path to the issue worktree
 * @param agentIndex - Zero-based agent index
 * @returns Branch name like `exec-agent-485-0`
 */
export function agentBranchName(
  issueWorktreePath: string,
  agentIndex: number,
): string {
  // Extract issue number from worktree path
  const dirName = basename(issueWorktreePath);
  const issueMatch = dirName.match(/^(\d+)-/);
  const issueNum = issueMatch ? issueMatch[1] : dirName.slice(0, 10);
  return `exec-agent-${issueNum}-${agentIndex}`;
}

/**
 * Create a sub-worktree for a parallel agent.
 *
 * The sub-worktree is created inside the issue worktree at
 * `.exec-agents/agent-<N>/` and branches from the issue branch HEAD.
 *
 * node_modules is symlinked from the issue worktree for speed.
 * Environment files are copied per new-feature.sh convention.
 *
 * @param issueWorktreePath - Absolute path to the issue worktree
 * @param agentIndex - Zero-based agent index
 * @returns Sub-worktree info, or null if creation failed
 */
export function createSubWorktree(
  issueWorktreePath: string,
  agentIndex: number,
): SubWorktreeInfo | null {
  const branch = agentBranchName(issueWorktreePath, agentIndex);
  const subDir = join(issueWorktreePath, SUB_WORKTREE_DIR);
  const agentPath = join(subDir, `agent-${agentIndex}`);

  try {
    // Ensure .exec-agents directory exists
    if (!existsSync(subDir)) {
      mkdirSync(subDir, { recursive: true });
    }

    // Create worktree branching from current HEAD
    git(`worktree add "${agentPath}" -b ${branch}`, issueWorktreePath);

    // Symlink node_modules from issue worktree (fast: ~13ms)
    const issueNodeModules = join(issueWorktreePath, "node_modules");
    const agentNodeModules = join(agentPath, "node_modules");
    if (existsSync(issueNodeModules) && !existsSync(agentNodeModules)) {
      symlinkSync(issueNodeModules, agentNodeModules);
    }

    // Copy files listed in .worktreeinclude (AC-7)
    const includeFiles = getIncludeFiles(issueWorktreePath);
    for (const filePath of includeFiles) {
      const src = join(issueWorktreePath, filePath);
      if (existsSync(src)) {
        const dest = join(agentPath, filePath);
        const destDir = dirname(dest);
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true });
        }
        copyFileSync(src, dest);
      }
    }

    return { path: agentPath, branch, agentIndex };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `Failed to create sub-worktree for agent ${agentIndex}: ${message}`,
    );
    return null;
  }
}

/**
 * Merge a single sub-worktree's changes back into the issue worktree.
 *
 * Uses `git merge --no-ff` for built-in conflict detection.
 *
 * @param issueWorktreePath - Absolute path to the issue worktree
 * @param subWorktree - Sub-worktree info
 * @returns Merge result with conflict details if any
 */
export function mergeBackSubWorktree(
  issueWorktreePath: string,
  subWorktree: SubWorktreeInfo,
): MergeResult {
  const { branch, agentIndex } = subWorktree;

  // Check if the agent branch has any commits beyond the base
  const hasChanges = gitSafe(
    `log ${branch} --not HEAD --oneline`,
    issueWorktreePath,
  );
  if (hasChanges.success && hasChanges.stdout.length === 0) {
    return { success: true, branch, agentIndex, conflictFiles: [] };
  }

  // Attempt merge
  const mergeResult = gitSafe(
    `merge --no-ff ${branch} -m "Merge exec-agent-${agentIndex}"`,
    issueWorktreePath,
  );

  if (mergeResult.success) {
    return { success: true, branch, agentIndex, conflictFiles: [] };
  }

  // Merge failed — detect conflict files
  const conflictResult = gitSafe(
    "diff --name-only --diff-filter=U",
    issueWorktreePath,
  );
  const conflictFiles = conflictResult.stdout
    .split("\n")
    .filter((f) => f.length > 0);

  // Abort the failed merge to leave clean state
  gitSafe("merge --abort", issueWorktreePath);

  return {
    success: false,
    branch,
    agentIndex,
    conflictFiles,
    error: `Merge conflict in ${conflictFiles.length} file(s): ${conflictFiles.join(", ")}`,
  };
}

/**
 * Merge all sub-worktrees back into the issue worktree.
 *
 * Merges are attempted sequentially. If one conflicts, the merge is
 * aborted and subsequent agents are still attempted. Non-conflicting
 * changes are preserved in the issue worktree.
 *
 * @param issueWorktreePath - Absolute path to the issue worktree
 * @param subWorktrees - Array of sub-worktree info
 * @returns Aggregate merge result
 */
export function mergeAllSubWorktrees(
  issueWorktreePath: string,
  subWorktrees: SubWorktreeInfo[],
): MergeBackResult {
  const results: MergeResult[] = [];
  let merged = 0;
  let conflicts = 0;

  for (const sub of subWorktrees) {
    const result = mergeBackSubWorktree(issueWorktreePath, sub);
    results.push(result);
    if (result.success) {
      merged++;
    } else {
      conflicts++;
    }
  }

  return { merged, conflicts, results };
}

/**
 * Remove a single sub-worktree and its branch.
 *
 * @param issueWorktreePath - Absolute path to the issue worktree
 * @param subWorktree - Sub-worktree info to clean up
 */
export function cleanupSubWorktree(
  issueWorktreePath: string,
  subWorktree: SubWorktreeInfo,
): void {
  const { path: subPath, branch } = subWorktree;

  // Remove worktree
  if (existsSync(subPath)) {
    gitSafe(`worktree remove "${subPath}" --force`, issueWorktreePath);
  }

  // Delete branch
  gitSafe(`branch -D ${branch}`, issueWorktreePath);
}

/**
 * Clean up all sub-worktrees for an issue worktree.
 *
 * Handles both successful cleanup and orphaned worktrees from
 * interrupted sessions.
 *
 * @param issueWorktreePath - Absolute path to the issue worktree
 * @param subWorktrees - Known sub-worktrees to clean (if provided)
 */
export function cleanupAllSubWorktrees(
  issueWorktreePath: string,
  subWorktrees?: SubWorktreeInfo[],
): void {
  if (subWorktrees) {
    for (const sub of subWorktrees) {
      cleanupSubWorktree(issueWorktreePath, sub);
    }
  }

  // Also clean any orphaned sub-worktrees from interrupted sessions
  cleanupOrphanedSubWorktrees(issueWorktreePath);
}

/**
 * Detect and clean up orphaned sub-worktrees from interrupted sessions.
 *
 * Scans the `.exec-agents/` directory for any remaining worktrees and
 * removes them. Also prunes stale worktree entries from git.
 *
 * @param issueWorktreePath - Absolute path to the issue worktree
 */
export function cleanupOrphanedSubWorktrees(issueWorktreePath: string): void {
  const subDir = join(issueWorktreePath, SUB_WORKTREE_DIR);

  if (!existsSync(subDir)) {
    return;
  }

  // Prune stale worktree entries
  gitSafe("worktree prune", issueWorktreePath);

  // List worktrees to find any still pointing to .exec-agents/
  const listResult = gitSafe("worktree list --porcelain", issueWorktreePath);
  if (!listResult.success) return;

  const lines = listResult.stdout.split("\n");
  for (const line of lines) {
    if (line.startsWith("worktree ") && line.includes(SUB_WORKTREE_DIR)) {
      const worktreePath = line.replace("worktree ", "");
      gitSafe(`worktree remove "${worktreePath}" --force`, issueWorktreePath);
    }
  }

  // Clean up orphaned exec-agent branches
  const branchResult = gitSafe("branch --list exec-agent-*", issueWorktreePath);
  if (branchResult.success && branchResult.stdout.length > 0) {
    const branches = branchResult.stdout
      .split("\n")
      .map((b) => b.trim())
      .filter((b) => b.length > 0);
    for (const branch of branches) {
      gitSafe(`branch -D ${branch}`, issueWorktreePath);
    }
  }

  // Remove the .exec-agents directory if empty
  try {
    const entries = readdirSync(subDir);
    if (entries.length === 0) {
      rmdirSync(subDir);
    }
  } catch {
    // Ignore errors during directory cleanup
  }
}

/**
 * Format merge-back results for logging.
 *
 * @param result - Aggregate merge result
 * @returns Human-readable summary
 */
export function formatMergeResult(result: MergeBackResult): string {
  const lines: string[] = [];
  const total = result.merged + result.conflicts;

  lines.push(
    `Merge-back: ${result.merged}/${total} agents merged successfully`,
  );

  if (result.conflicts > 0) {
    lines.push(`Conflicts: ${result.conflicts} agent(s) had merge conflicts`);
    for (const r of result.results) {
      if (!r.success) {
        lines.push(`  Agent ${r.agentIndex}: ${r.error}`);
      }
    }
  }

  return lines.join("\n");
}
