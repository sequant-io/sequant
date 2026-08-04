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
 * Resolve the ref diff stats should compare against (#878).
 *
 * Worktrees are created from `origin/<base>` (worktree-manager), but callers
 * historically passed the bare branch name and the diff ran against the
 * *local* ref. When local `<base>` lags the remote — routine, since nothing
 * in the run path updates it — `<base>...HEAD` attributes commits the run
 * never made (phantom filesModified).
 *
 * Candidates are the origin-qualified and bare forms of `baseBranch`
 * (already-remote-qualified input keeps a single candidate). Among the
 * candidates that resolve to a commit, pick the one nearest to HEAD
 * (smallest `rev-list --count <cand>..HEAD`), preferring the
 * origin-qualified form on a tie. Nearest-wins matches the worktree's
 * actual creation point in both staleness directions: a stale local
 * default branch (this issue) and a chain-mode worktree branched from a
 * local base that is ahead of its pushed counterpart. Falls back to
 * `baseBranch` verbatim when no candidate resolves (e.g. remote-less repo
 * with a missing branch) — the diff then fails gracefully to empty, the
 * pre-#878 behavior.
 */
export function resolveDiffBase(
  worktreePath: string,
  baseBranch: string,
): string {
  const candidates = baseBranch.startsWith("origin/")
    ? [baseBranch]
    : [`origin/${baseBranch}`, baseBranch];

  let best: string | undefined;
  let bestCount = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const verify = spawnSync(
      "git",
      [
        "-C",
        worktreePath,
        "rev-parse",
        "--verify",
        "--quiet",
        `${candidate}^{commit}`,
      ],
      { stdio: "pipe", encoding: "utf-8" },
    );
    if (verify.status !== 0) continue;

    const count = spawnSync(
      "git",
      ["-C", worktreePath, "rev-list", "--count", `${candidate}..HEAD`],
      { stdio: "pipe", encoding: "utf-8" },
    );
    if (count.status !== 0) continue;

    const n = Number.parseInt(count.stdout.trim(), 10);
    if (Number.isNaN(n)) continue;

    // Strict < keeps the earlier (origin-qualified) candidate on a tie.
    if (n < bestCount) {
      best = candidate;
      bestCount = n;
    }
  }

  return best ?? baseBranch;
}

/**
 * Get git commit SHA for a worktree (AC-2)
 *
 * When `baseRef` is provided, returns undefined if HEAD has no commits
 * unique to it (#878) — a branch that never moved off its base would
 * otherwise log the base tip as if it were the phase's commit. Callers
 * recording plain "where is HEAD" markers (run start/end) omit `baseRef`.
 *
 * @param worktreePath - Path to the git worktree
 * @param baseRef - Optional resolved base ref (see resolveDiffBase); when
 *   given, a HEAD with zero commits past it yields undefined
 * @returns The current HEAD commit SHA, or undefined on error / no unique
 *   commits
 */
export function getCommitHash(
  worktreePath: string,
  baseRef?: string,
): string | undefined {
  const result = spawnSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
    stdio: "pipe",
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    return undefined;
  }

  if (baseRef !== undefined) {
    const count = spawnSync(
      "git",
      ["-C", worktreePath, "rev-list", "--count", `${baseRef}..HEAD`],
      { stdio: "pipe", encoding: "utf-8" },
    );
    // Fail open on git errors: a transient failure should not erase a real
    // commit hash from the log — only a confirmed zero suppresses it.
    if (count.status === 0) {
      const n = Number.parseInt(count.stdout.trim(), 10);
      if (n === 0) {
        return undefined;
      }
    }
  }

  return result.stdout.trim();
}

/**
 * Get git diff statistics for a worktree (AC-1, AC-3, AC-4)
 *
 * Efficiently captures both filesModified and fileDiffStats using
 * minimal git commands. The base is resolved via resolveDiffBase (#878) so
 * the comparison targets the ref the worktree was actually created from
 * (origin/<base> in the common case) rather than a possibly-stale local ref.
 *
 * @param worktreePath - Path to the git worktree
 * @param baseBranch - Branch to compare against (default: "main")
 * @returns GitDiffStatsResult with files, stats, and totals
 */
export function getGitDiffStats(
  worktreePath: string,
  baseBranch: string = "main",
): GitDiffStatsResult {
  const diffRef = `${resolveDiffBase(worktreePath, baseBranch)}...HEAD`;

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
