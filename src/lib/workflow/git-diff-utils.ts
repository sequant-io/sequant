/**
 * Git diff utilities for pipeline observability (AC-1, AC-3, AC-4)
 *
 * Provides efficient git diff statistics for phase logging.
 * Uses single git commands where possible to avoid redundant operations.
 */

import { spawnSync } from "child_process";
import type { FileDiffStat } from "./run-log-schema.js";

/**
 * Result from getGitDiffStats (AC-4)
 */
export interface GitDiffStatsResult {
  /** List of modified file paths (AC-1) */
  filesModified: string[];
  /** Per-file diff statistics (AC-3) */
  fileDiffStats: FileDiffStat[];
  /** Total lines added across all files */
  totalAdditions: number;
  /** Total lines deleted across all files */
  totalDeletions: number;
}

/**
 * Parse git diff --numstat output into additions/deletions per file
 *
 * Format: <additions>\t<deletions>\t<filepath>
 * Binary files show: -\t-\t<filepath>
 */
function parseNumstat(
  output: string,
): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>();

  if (!output.trim()) {
    return result;
  }

  const lines = output.trim().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;

    const parts = line.split("\t");
    if (parts.length < 3) continue;

    const [addStr, delStr, ...pathParts] = parts;
    const filePath = pathParts.join("\t"); // Handle filenames with tabs

    // Binary files show "-" for additions/deletions
    const additions = addStr === "-" ? 0 : parseInt(addStr, 10);
    const deletions = delStr === "-" ? 0 : parseInt(delStr, 10);

    if (!isNaN(additions) && !isNaN(deletions)) {
      result.set(filePath, { additions, deletions });
    }
  }

  return result;
}

/**
 * Parse git diff --name-status output into file statuses
 *
 * Format: <status>\t<filepath> (or <status>\t<oldpath>\t<newpath> for renames)
 * Status codes: A=added, M=modified, D=deleted, R=renamed, C=copied, T=type-changed
 */
function parseNameStatus(output: string): Map<string, FileDiffStat["status"]> {
  const result = new Map<string, FileDiffStat["status"]>();

  if (!output.trim()) {
    return result;
  }

  const lines = output.trim().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;

    const parts = line.split("\t");
    if (parts.length < 2) continue;

    const statusCode = parts[0];
    // For renames (R100), use the new filename (last part)
    const filePath = parts[parts.length - 1];

    let status: FileDiffStat["status"];
    if (statusCode.startsWith("A")) {
      status = "added";
    } else if (statusCode.startsWith("D")) {
      status = "deleted";
    } else if (statusCode.startsWith("R")) {
      status = "renamed";
    } else {
      // M, C, T, or anything else -> modified
      status = "modified";
    }

    result.set(filePath, status);
  }

  return result;
}

/**
 * Get git commit SHA for a worktree (AC-2)
 *
 * @param worktreePath - Path to the git worktree
 * @returns The current HEAD commit SHA, or undefined on error
 */
export function getCommitHash(worktreePath: string): string | undefined {
  const result = spawnSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
    stdio: "pipe",
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    return undefined;
  }

  return result.stdout.trim();
}

/**
 * Get git diff statistics for a worktree (AC-1, AC-3, AC-4)
 *
 * Efficiently captures both filesModified and fileDiffStats using
 * minimal git commands. Uses main...HEAD comparison by default.
 *
 * @param worktreePath - Path to the git worktree
 * @param baseBranch - Branch to compare against (default: "main")
 * @returns GitDiffStatsResult with files, stats, and totals
 */
export function getGitDiffStats(
  worktreePath: string,
  baseBranch: string = "main",
): GitDiffStatsResult {
  const diffRef = `${baseBranch}...HEAD`;

  // Get numstat for additions/deletions
  const numstatResult = spawnSync(
    "git",
    ["-C", worktreePath, "diff", "--numstat", diffRef],
    { stdio: "pipe", encoding: "utf-8" },
  );

  // Get name-status for file status (added/modified/deleted/renamed)
  const nameStatusResult = spawnSync(
    "git",
    ["-C", worktreePath, "diff", "--name-status", diffRef],
    { stdio: "pipe", encoding: "utf-8" },
  );

  // Handle git command failures gracefully
  if (numstatResult.status !== 0 || nameStatusResult.status !== 0) {
    return {
      filesModified: [],
      fileDiffStats: [],
      totalAdditions: 0,
      totalDeletions: 0,
    };
  }

  const numstatMap = parseNumstat(numstatResult.stdout);
  const statusMap = parseNameStatus(nameStatusResult.stdout);

  // Combine into fileDiffStats array
  const fileDiffStats: FileDiffStat[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const [path, stats] of numstatMap) {
    const status = statusMap.get(path) ?? "modified";
    fileDiffStats.push({
      path,
      additions: stats.additions,
      deletions: stats.deletions,
      status,
    });
    totalAdditions += stats.additions;
    totalDeletions += stats.deletions;
  }

  // filesModified is just the paths
  const filesModified = fileDiffStats.map((f) => f.path);

  return {
    filesModified,
    fileDiffStats,
    totalAdditions,
    totalDeletions,
  };
}

// Re-export types for test file
export type { FileDiffStat };
