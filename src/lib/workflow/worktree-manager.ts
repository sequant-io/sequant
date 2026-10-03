/**
 * Worktree lifecycle management for sequant run
 *
 * Handles creation, discovery, freshness checks, rebasing, and PR creation
 * for git worktrees used during issue execution.
 */

import chalk from "chalk";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import {
  CI_INSTALL_SKIP,
  hasManifestForPackageManager,
  resolvePackageManager,
  resolvePackageManagerConfig,
} from "../stacks.js";
import { resolveDiffBase } from "./git-diff-utils.js";
import { getResumablePhasesForIssue } from "./phase-detection.js";
import {
  readRecordedBaseRef,
  recordWorktreeBaseRef,
  resolveBaseRef,
} from "./phase-executor.js";
import { GitHubProvider } from "./platforms/github.js";
import type { Phase } from "./types.js";
import type { CacheMetrics, GapFinding } from "./run-log-schema.js";
import type { AbortContext, ShutdownManager } from "../shutdown.js";

/**
 * Worktree information for an issue
 */
export interface WorktreeInfo {
  issue: number;
  path: string;
  branch: string;
  existed: boolean;
  /** True if an existing branch was rebased onto the chain base */
  rebased: boolean;
}

/**
 * Result of worktree freshness check
 */
export interface WorktreeFreshnessResult {
  /** True if worktree is stale (significantly behind main) */
  isStale: boolean;
  /** Number of commits behind the base branch */
  commitsBehind: number;
  /** True if worktree has uncommitted changes */
  hasUncommittedChanges: boolean;
  /** True if worktree has unpushed commits */
  hasUnpushedCommits: boolean;
}

/**
 * Result of a pre-PR rebase operation
 */
export interface RebaseResult {
  /** Whether the rebase was performed */
  performed: boolean;
  /** Whether the rebase succeeded */
  success: boolean;
  /** Whether dependencies were reinstalled */
  reinstalled: boolean;
  /** Error message if rebase failed */
  error?: string;
  /** How the base branch was brought in: merge (pushed branch) or rebase (#1069) */
  strategy?: "merge" | "rebase";
}

/**
 * Result of rebasing a worktree onto a local branch (chain successor → predecessor).
 */
export interface LocalRebaseResult {
  /** Whether the rebase was attempted */
  performed: boolean;
  /** Whether the rebase succeeded (branch now contains `ontoBranch`'s commits) */
  success: boolean;
  /** Whether a merge conflict caused the rebase to be aborted */
  conflict: boolean;
  /** Error message if the rebase failed */
  error?: string;
}

/**
 * Result of PR creation
 */
export interface PRCreationResult {
  /** Whether PR creation was attempted */
  attempted: boolean;
  /** Whether PR was created successfully (or already existed) */
  success: boolean;
  /** PR number */
  prNumber?: number;
  /** PR URL */
  prUrl?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Lockfile names for different package managers
 */
const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "bun.lock",
  "yarn.lock",
];

/**
 * Slugify a title for branch naming.
 *
 * @internal Exported so the in-place checkout gate (#1136) can assert that
 * `/exec`'s shell slug matches this rule; a mismatch makes `sequant run` miss
 * a branch a cloud session pushed and create a second one.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 50);
}

/**
 * Get the git repository root directory
 */
function getGitRoot(): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    stdio: "pipe",
  });
  if (result.status === 0) {
    return result.stdout.toString().trim();
  }
  return null;
}

/**
 * Check if a worktree exists for a given branch
 */
function findExistingWorktree(branch: string): string | null {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    stdio: "pipe",
  });
  if (result.status !== 0) return null;

  const output = result.stdout.toString();
  const lines = output.split("\n");
  let currentPath = "";

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      currentPath = line.substring(9);
    } else if (line.startsWith("branch refs/heads/") && line.includes(branch)) {
      return currentPath;
    }
  }
  return null;
}

/**
 * Detect the remote's default branch without a network call when possible.
 *
 * Resolution order:
 * 1. `git symbolic-ref refs/remotes/origin/HEAD` (local, no network)
 * 2. `git remote set-head origin --auto` then retry (network call)
 * 3. Fallback to "main"
 *
 * @param verbose - Log which branch was detected
 * @returns The detected default branch name (e.g., "main", "master")
 * @internal Exported for testing
 */
export function detectDefaultBranch(verbose: boolean = false): string {
  // Try reading the symbolic ref (no network call)
  const result = spawnSync(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    { stdio: "pipe" },
  );
  if (result.status === 0) {
    const branch = result.stdout
      .toString()
      .trim()
      .replace("refs/remotes/origin/", "");
    if (verbose) {
      console.log(
        chalk.gray(`  Detected default branch: ${branch} (from origin/HEAD)`),
      );
    }
    return branch;
  }

  // If not set, try refreshing it (requires network)
  const autoResult = spawnSync(
    "git",
    ["remote", "set-head", "origin", "--auto"],
    { stdio: "pipe" },
  );
  if (autoResult.status === 0) {
    const retry = spawnSync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      { stdio: "pipe" },
    );
    if (retry.status === 0) {
      const branch = retry.stdout
        .toString()
        .trim()
        .replace("refs/remotes/origin/", "");
      if (verbose) {
        console.log(
          chalk.gray(
            `  Detected default branch: ${branch} (via remote set-head)`,
          ),
        );
      }
      return branch;
    }
  }

  // Final fallback
  if (verbose) {
    console.log(chalk.gray(`  Detected default branch: main (fallback)`));
  }
  return "main";
}

/**
 * Count the commits `origin/<baseBranch>` has that `cwd`'s HEAD lacks:
 * `merge-base(HEAD, origin/<base>)..origin/<base>`. Does NOT fetch — callers
 * that need a fresh count fetch first (#1193: the run orchestrator reuses the
 * fetch worktree provisioning already did).
 *
 * @returns the count, or `null` when it cannot be determined (no such ref,
 *   no merge base, not a git repository)
 */
export function countCommitsBehind(
  cwd: string,
  baseBranch: string = "main",
): number | null {
  const baseRef = `origin/${baseBranch.replace(/^origin\//, "")}`;
  const mergeBaseResult = spawnSync(
    "git",
    ["-C", cwd, "merge-base", "HEAD", baseRef],
    { stdio: "pipe" },
  );
  if (mergeBaseResult.status !== 0) return null;
  const mergeBase = mergeBaseResult.stdout.toString().trim();

  const baseHeadResult = spawnSync("git", ["-C", cwd, "rev-parse", baseRef], {
    stdio: "pipe",
  });
  if (baseHeadResult.status !== 0) return null;
  const baseHead = baseHeadResult.stdout.toString().trim();

  if (mergeBase === baseHead) return 0;
  const countResult = spawnSync(
    "git",
    ["-C", cwd, "rev-list", "--count", `${mergeBase}..${baseHead}`],
    { stdio: "pipe" },
  );
  if (countResult.status !== 0) return null;
  const count = parseInt(countResult.stdout.toString().trim(), 10);
  return Number.isNaN(count) ? null : count;
}

/**
 * Check if a worktree is stale (behind the base branch) and should be recreated
 *
 * @param worktreePath - Path to the worktree
 * @param verbose - Enable verbose output
 * @param baseBranch - Base branch to compare against (default: "main")
 * @returns Freshness check result
 */
export function checkWorktreeFreshness(
  worktreePath: string,
  verbose: boolean,
  baseBranch: string = "main",
): WorktreeFreshnessResult {
  const result: WorktreeFreshnessResult = {
    isStale: false,
    commitsBehind: 0,
    hasUncommittedChanges: false,
    hasUnpushedCommits: false,
  };

  // Fetch latest base branch to ensure accurate comparison
  spawnSync("git", ["-C", worktreePath, "fetch", "origin", baseBranch], {
    stdio: "pipe",
    timeout: 30000,
  });

  // Check for uncommitted changes
  const statusResult = spawnSync(
    "git",
    ["-C", worktreePath, "status", "--porcelain"],
    { stdio: "pipe" },
  );
  if (statusResult.status === 0) {
    result.hasUncommittedChanges =
      statusResult.stdout.toString().trim().length > 0;
  }

  // Count commits behind base branch (the fetch above refreshed the ref)
  const commitsBehind = countCommitsBehind(worktreePath, baseBranch);
  if (commitsBehind === null) {
    // Can't determine merge base - not stale
    return result;
  }
  result.commitsBehind = commitsBehind;
  // Consider stale if more than 5 commits behind. NOT configurable — the
  // threshold is the literal below, and a stale-but-clean worktree is
  // force-removed and rebuilt on the strength of it (see the recreate
  // branch in `ensureWorktree`). Surfaced in #810; left as a literal here
  // because making it configurable is a behavior change, not a comment fix.
  result.isStale = result.commitsBehind > 5;

  // Check for unpushed commits (work in progress)
  const unpushedResult = spawnSync(
    "git",
    ["-C", worktreePath, "log", "--oneline", "@{u}..HEAD"],
    { stdio: "pipe" },
  );
  if (unpushedResult.status === 0) {
    result.hasUnpushedCommits =
      unpushedResult.stdout.toString().trim().length > 0;
  }

  if (verbose && result.isStale) {
    console.log(
      chalk.gray(
        `    Worktree is ${result.commitsBehind} commits behind origin/${baseBranch}`,
      ),
    );
  }

  return result;
}

/**
 * Remove and recreate a stale worktree
 *
 * @param existingPath - Path to existing worktree
 * @param branch - Branch name
 * @param verbose - Enable verbose output
 * @returns true if worktree was removed
 */
export function removeStaleWorktree(
  existingPath: string,
  branch: string,
  verbose: boolean,
): boolean {
  if (verbose) {
    console.log(chalk.gray(`    🗑️  Removing stale worktree...`));
  }

  // Remove the worktree
  const removeResult = spawnSync(
    "git",
    ["worktree", "remove", "--force", existingPath],
    { stdio: "pipe" },
  );

  if (removeResult.status !== 0) {
    const error = removeResult.stderr.toString();
    console.log(chalk.yellow(`    !  Could not remove worktree: ${error}`));
    return false;
  }

  // Delete the branch so it can be recreated fresh
  const deleteResult = spawnSync("git", ["branch", "-D", branch], {
    stdio: "pipe",
  });

  if (deleteResult.status !== 0 && verbose) {
    console.log(
      chalk.gray(
        `    ℹ️  Branch ${branch} not deleted (may not exist locally)`,
      ),
    );
  }

  return true;
}

/**
 * Whether a worktree has uncommitted changes (tracked edits or untracked
 * files) — the state a #879 exec-failure message may promise is "preserved"
 * there. A `git status` failure is treated as dirty: fail toward keeping the
 * worktree rather than deleting an unknown state (#935).
 */
export function isWorktreeDirty(worktreePath: string): boolean {
  const result = spawnSync(
    "git",
    ["-C", worktreePath, "status", "--porcelain"],
    { stdio: "pipe" },
  );
  if (result.status !== 0) return true;
  return result.stdout.toString().trim().length > 0;
}

/**
 * Whether a worktree's branch has commits not reachable from its base
 * (#1222 AC-2) — real work a clean-but-mid-flight worktree could otherwise
 * lose, e.g. #1198's 3 committed WIP commits on an exec-in-progress branch.
 * Base resolution follows the `resolveBaseRef` pattern (#537): a git error
 * (unresolvable base, detached HEAD, etc.) fails toward preserving — an
 * unknown state is treated the same as #935 treats a `git status` failure.
 */
export function hasCommitsAheadOfBase(
  worktreePath: string,
  baseRef?: string,
): boolean {
  const base = baseRef ?? resolveBaseRef(worktreePath);
  const result = spawnSync(
    "git",
    ["-C", worktreePath, "rev-list", "--count", `${base}..HEAD`],
    { stdio: "pipe" },
  );
  if (result.status !== 0) return true;
  const count = parseInt(result.stdout.toString().trim(), 10);
  return !Number.isFinite(count) || count > 0;
}

/**
 * Whether a signal-driven shutdown cleanup should leave a worktree in place
 * rather than force-removing it (#935 D13, #1222 AC-2).
 *
 * `abort` is non-null only for a signal-triggered shutdown (SIGINT/SIGTERM);
 * a `null` abort means a programmatic teardown, which always removes. A
 * worktree is preserved when any of these hold:
 * - it is dirty: uncommitted work exists only on disk, and removal destroys
 *   it even though the branch survives (#935);
 * - its issue has a phase actively running (`phaseInProgress`): the phase's
 *   work may not be committed yet, so a clean snapshot right now proves
 *   nothing about a moment later;
 * - it has commits ahead of its base: real, committed work that a force
 *   removal would strand with no worktree to recover it from (#1198).
 *
 * A worktree with none of these is still removed, so a killed run doesn't
 * leak worktrees.
 */
export function shouldPreserveWorktree(
  abort: AbortContext | null,
  worktreePath: string,
  options?: { phaseInProgress?: boolean; baseRef?: string },
): boolean {
  return worktreePreserveReason(abort, worktreePath, options) !== null;
}

/**
 * Why {@link shouldPreserveWorktree} keeps a worktree, or `null` when it
 * removes it. The first matching rule wins, so the reason in the shutdown log
 * names the check that actually applied.
 */
export function worktreePreserveReason(
  abort: AbortContext | null,
  worktreePath: string,
  options?: { phaseInProgress?: boolean; baseRef?: string },
): string | null {
  if (abort === null) return null;
  if (isWorktreeDirty(worktreePath)) return "uncommitted changes";
  if (options?.phaseInProgress) return "phase in progress";
  if (hasCommitsAheadOfBase(worktreePath, options?.baseRef)) {
    return "commits ahead of base";
  }
  return null;
}

/**
 * The cleanup task a run registers for each worktree it creates: preserve a
 * dirty worktree on signal-driven shutdown, otherwise force-remove it. Named
 * so `formatUncommittedExecError` (#879)'s "preserved in <path>" claim
 * stays true after an externally-terminated run — the exact bug in #935.
 *
 * @param log - Optional sink for a one-line outcome message: names the path
 *   when preserved (it still exists), the branch when removed (only the
 *   branch survives).
 * @param phaseInProgress - Optional predicate, called lazily at shutdown
 *   time (#1222 AC-2), reporting whether this issue's phase is still
 *   running. Not a boolean snapshot: phase state changes over the run, and
 *   this is only read once, when the signal arrives.
 */
export async function cleanupWorktreeOnShutdown(
  issueNum: number,
  worktree: WorktreeInfo,
  abort: AbortContext | null,
  log?: (message: string) => void,
  phaseInProgress?: () => boolean,
): Promise<void> {
  const reason = worktreePreserveReason(abort, worktree.path, {
    phaseInProgress: phaseInProgress?.() ?? false,
  });
  if (reason !== null) {
    log?.(`Worktree for #${issueNum} preserved (${reason}): ${worktree.path}`);
    return;
  }
  spawnSync("git", ["worktree", "remove", "--force", worktree.path], {
    stdio: "pipe",
  });
  log?.(
    `Worktree for #${issueNum} removed (clean); recoverable from branch ${worktree.branch}`,
  );
}

/**
 * Register the {@link cleanupWorktreeOnShutdown} task with a run's
 * `ShutdownManager` for a worktree it created this run.
 */
export function registerWorktreeRemovalCleanup(
  shutdown: ShutdownManager,
  issueNum: number,
  worktree: WorktreeInfo,
  log?: (message: string) => void,
  phaseInProgress?: () => boolean,
): void {
  shutdown.registerCleanup(`Cleanup worktree for #${issueNum}`, (abort) =>
    cleanupWorktreeOnShutdown(issueNum, worktree, abort, log, phaseInProgress),
  );
}

/**
 * List all active worktrees with their branches
 *
 * `git worktree list` only ever reports worktrees belonging to the repository
 * containing `cwd`, which is what makes this a repo-scoped lookup: a sibling
 * project's worktree can never appear here, even though `../worktrees/` is a
 * single directory shared by every repo under the same parent (#899).
 *
 * @param cwd - Directory to run git in. Defaults to the current process cwd.
 */
export function listWorktrees(cwd?: string): Array<{
  path: string;
  branch: string;
  issue: number | null;
}> {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    stdio: "pipe",
    ...(cwd ? { cwd } : {}),
  });
  if (result.status !== 0) return [];

  const output = result.stdout.toString();
  const lines = output.split("\n");
  const worktrees: Array<{
    path: string;
    branch: string;
    issue: number | null;
  }> = [];

  let currentPath = "";
  let currentBranch: string;

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      currentPath = line.substring(9);
    } else if (line.startsWith("branch refs/heads/")) {
      currentBranch = line.substring(18);
      // Extract issue number from branch name (e.g., feature/123-some-title)
      const issueMatch = currentBranch.match(/feature\/(\d+)-/);
      const issue = issueMatch ? parseInt(issueMatch[1], 10) : null;
      worktrees.push({ path: currentPath, branch: currentBranch, issue });
      currentPath = "";
    }
  }

  return worktrees;
}

/**
 * Get changed files in a worktree compared to main
 */
export function getWorktreeChangedFiles(worktreePath: string): string[] {
  const diffBase = resolveDiffBase(worktreePath, "main");
  const result = spawnSync(
    "git",
    ["-C", worktreePath, "diff", "--name-only", `${diffBase}...HEAD`],
    { stdio: "pipe" },
  );
  if (result.status !== 0) return [];
  return result.stdout
    .toString()
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);
}

/**
 * Get diff stats for a worktree (files changed, lines added)
 * Returns aggregate metrics only - no file paths to preserve privacy
 */
export function getWorktreeDiffStats(worktreePath: string): {
  filesChanged: number;
  linesAdded: number;
} {
  const diffBase = resolveDiffBase(worktreePath, "main");
  const result = spawnSync(
    "git",
    ["-C", worktreePath, "diff", "--stat", `${diffBase}...HEAD`],
    { stdio: "pipe" },
  );

  if (result.status !== 0) {
    return { filesChanged: 0, linesAdded: 0 };
  }

  const output = result.stdout.toString();
  const lines = output.trim().split("\n");

  // Summary line is last and looks like: " 5 files changed, 100 insertions(+), 20 deletions(-)"
  const summaryLine = lines[lines.length - 1];
  if (!summaryLine) {
    return { filesChanged: 0, linesAdded: 0 };
  }

  const filesMatch = summaryLine.match(/(\d+)\s+files?\s+changed/);
  const insertionsMatch = summaryLine.match(/(\d+)\s+insertions?\(\+\)/);

  return {
    filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    linesAdded: insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0,
  };
}

/**
 * Read cache metrics from QA phase (AC-7)
 *
 * @param worktreePath - Path to the worktree
 * @returns CacheMetrics or undefined if not available
 */
export function readCacheMetrics(
  worktreePath?: string,
): CacheMetrics | undefined {
  const cacheMetricsPath = worktreePath
    ? path.join(worktreePath, ".sequant/.cache/qa/cache-metrics.json")
    : ".sequant/.cache/qa/cache-metrics.json";

  if (!existsSync(cacheMetricsPath)) {
    return undefined;
  }

  try {
    const content = readFileSync(cacheMetricsPath, "utf-8");
    const data = JSON.parse(content);

    if (
      typeof data.hits === "number" &&
      typeof data.misses === "number" &&
      typeof data.skipped === "number"
    ) {
      return {
        hits: data.hits,
        misses: data.misses,
        skipped: data.skipped,
      };
    }
  } catch {
    // Ignore parse errors
  }

  return undefined;
}

/**
 * Filter phases based on resume status.
 *
 * When `resume` is true, calls `getResumablePhasesForIssue` to determine
 * which phases have already completed (via GitHub issue comment markers)
 * and removes them from the execution list.
 *
 * @param issueNumber - GitHub issue number
 * @param phases - The phases to potentially filter
 * @param resume - Whether the --resume flag is set
 * @returns Object with filtered phases and any skipped phases
 */
export function filterResumedPhases(
  issueNumber: number,
  phases: Phase[],
  resume: boolean,
): { phases: Phase[]; skipped: Phase[] } {
  if (!resume) {
    return { phases: [...phases], skipped: [] };
  }

  const resumable = getResumablePhasesForIssue(issueNumber, phases) as Phase[];
  const skipped = phases.filter((p) => !resumable.includes(p));
  return { phases: resumable, skipped };
}

/**
 * Run the frozen dependency install for a freshly provisioned worktree and
 * surface (rather than swallow) a failed install.
 *
 * Mirrors the status check in `reinstallIfLockfileChanged` (#846): a plain
 * `npm install` self-heals a stale/absent lockfile, but the frozen `npm ci`
 * hard-fails (exit 1, no node_modules). Without this check a failing install
 * left a silently dependency-less worktree whose breakage only surfaced later
 * as a confusing phase error. The warning names the resolved command so the
 * user can rerun it by hand.
 *
 * @returns true if the install succeeded, false if it failed (warn-and-continue)
 * @internal Exported for testing
 */
export function installWorktreeDeps(
  worktreePath: string,
  packageManager: string | undefined,
  verbose: boolean,
): boolean {
  // Two independent questions, resolved in order against the worktree itself.
  //
  // WHICH manager: the manifest's packageManager is a snapshot and may be
  // absent, so fall back to the worktree's own lockfile — that keeps this in
  // agreement with what new-feature.sh would run for the same project (#870).
  //
  // WHICH commands for it: yarn's frozen install differs between classic
  // (`--frozen-lockfile`) and berry (`--immutable`), and both majors use
  // `yarn.lock`, so the manager's identity alone cannot say which (#871).
  //
  // The worktree is checked out by now, so its package.json / .yarnrc.yml /
  // yarn.lock are all readable here.
  const pm = resolvePackageManager(packageManager, worktreePath);

  // A non-Node repo has no `node_modules` either, so the caller's
  // `!existsSync(node_modules)` guard is always true there — without this
  // check `pm` falls back to `"npm"` (JS-only detection) and always attempts
  // `npm ci` against a tree with no package.json to install from (#1196).
  if (!hasManifestForPackageManager(pm, worktreePath)) {
    console.log(
      chalk.gray(
        `    Skipping dependency install — no manifest found for ${pm}`,
      ),
    );
    return true;
  }

  if (verbose) {
    console.log(chalk.gray(`    Installing dependencies...`));
  }
  const pmConfig = resolvePackageManagerConfig(pm, worktreePath);

  // pip's ciInstall resolves to CI_INSTALL_SKIP when no requirements file
  // exists (#1196 AC-2), and uv's does when there is neither a uv.lock nor a
  // requirements file (#1217) — a bare `pip install -q` / `uv pip install -q`
  // names no package and would fail as a no-op.
  if (pmConfig.ciInstall === CI_INSTALL_SKIP) {
    console.log(
      chalk.gray(
        `    Skipping dependency install — no requirements file found for ${pm}`,
      ),
    );
    return true;
  }
  // ciInstall, not installSilent: a plain `npm install` normalizes and
  // rewrites package-lock.json (observed: npm 10 strips the `libc` fields a
  // newer npm committed), so every provisioned worktree started dirty. That
  // one unstaged file cascaded: rebaseBeforePR refused to run, stale
  // worktrees read as having "uncommitted changes" and were never recreated,
  // and chain checkpoints skipped on an out-of-scope dirty file. A frozen
  // install never touches the lockfile. Same substitution #803 made for
  // merge-check's combined-branch test. The `!existsSync(node_modules)`
  // guard at the call site means `npm ci`'s wipe-and-reinstall has nothing
  // to wipe.
  const [cmd, ...args] = pmConfig.ciInstall.split(" ");
  const command = [cmd, ...args].join(" ");

  const installResult = spawnSync(cmd, args, {
    cwd: worktreePath,
    stdio: "pipe",
  });

  if (installResult.status !== 0) {
    // stderr may be empty on some failures — the resolved command alone is
    // enough to act on, so always name it (AC-2).
    const error = installResult.stderr?.toString().trim() ?? "";
    const detail = error ? `: ${error}` : "";
    console.log(
      chalk.yellow(`    !  Dependency install failed (${command})${detail}`),
    );
    return false;
  }

  return true;
}

/**
 * Resolve the directory issue worktrees are created under (#1199).
 *
 * Precedence: `SEQUANT_WORKTREE_ROOT` env var → `run.worktreeRoot` setting →
 * `<parent of repo>/worktrees`. A relative value resolves against the main
 * repo root, not the cwd. An empty or whitespace-only value counts as unset.
 * `scripts/new-feature.sh` applies the same precedence on its own.
 */
export function resolveWorktreeRoot(
  gitRoot: string,
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env.SEQUANT_WORKTREE_ROOT?.trim();
  const value = fromEnv || configured?.trim();
  if (!value) {
    return path.join(path.dirname(gitRoot), "worktrees");
  }
  return path.resolve(gitRoot, value);
}

/**
 * The ref a new worktree branch is cut from (#1234 extracted it so the
 * creation and reuse paths record the same value): a local branch (chain
 * mode, or a local `--base`) as-is, `origin/<x>` for a remote-style base,
 * else `origin/<default>`.
 *
 * @internal Exported for testing only.
 */
export function computeWorktreeBaseRef(
  baseBranch: string | undefined,
  detectedDefault: string,
): string {
  if (!baseBranch) return `origin/${detectedDefault}`;
  if (baseBranch.startsWith("origin/")) return baseBranch;
  if (baseBranch === detectedDefault) return `origin/${baseBranch}`;
  return baseBranch;
}

/**
 * Create or reuse a worktree for an issue
 * @param baseBranch - Optional branch to use as base instead of origin/main (for chain mode)
 * @param chainMode - If true and branch exists, rebase onto baseBranch instead of using as-is
 * @param worktreeRoot - `run.worktreeRoot` setting; see resolveWorktreeRoot
 */
export async function ensureWorktree(
  issueNumber: number,
  title: string,
  verbose: boolean,
  packageManager?: string,
  baseBranch?: string,
  chainMode?: boolean,
  worktreeRoot?: string,
): Promise<WorktreeInfo | null> {
  const gitRoot = getGitRoot();
  if (!gitRoot) {
    console.log(chalk.red("    ❌ Not in a git repository"));
    return null;
  }

  const slug = slugify(title);
  const branch = `feature/${issueNumber}-${slug}`;
  const worktreesDir = resolveWorktreeRoot(gitRoot, worktreeRoot);
  const worktreePath = path.join(worktreesDir, branch);

  // Check if worktree already exists
  let existingPath = findExistingWorktree(branch);
  if (existingPath) {
    // AC-3: Check if worktree is stale and needs recreation
    const detectedBase = baseBranch || detectDefaultBranch(verbose);
    const freshness = checkWorktreeFreshness(
      existingPath,
      verbose,
      detectedBase,
    );

    if (freshness.isStale) {
      // AC-3: Handle stale worktrees - check for work in progress
      if (freshness.hasUncommittedChanges) {
        console.log(
          chalk.yellow(
            `    !  Worktree is ${freshness.commitsBehind} commits behind ${detectedBase} but has uncommitted changes`,
          ),
        );
        console.log(
          chalk.yellow(
            `    ℹ️  Keeping existing worktree. Commit or stash changes, then re-run.`,
          ),
        );
        // Continue with existing worktree
      } else if (freshness.hasUnpushedCommits) {
        console.log(
          chalk.yellow(
            `    !  Worktree is ${freshness.commitsBehind} commits behind ${detectedBase} but has unpushed commits`,
          ),
        );
        console.log(
          chalk.yellow(`    ℹ️  Keeping existing worktree with WIP commits.`),
        );
        // Continue with existing worktree
      } else {
        // Safe to recreate - no uncommitted/unpushed work
        console.log(
          chalk.yellow(
            `    !  Worktree is ${freshness.commitsBehind} commits behind ${detectedBase} — recreating fresh`,
          ),
        );

        if (removeStaleWorktree(existingPath, branch, verbose)) {
          existingPath = null; // Will fall through to create new worktree
        }
      }
    }
  }

  if (existingPath) {
    if (verbose) {
      console.log(chalk.gray(`    Reusing existing worktree: ${existingPath}`));
    }

    // #1234: a worktree created before the base was recorded gets it now;
    // one that already has it keeps the ref it was actually cut from.
    if (!readRecordedBaseRef(existingPath, branch)) {
      recordWorktreeBaseRef(
        existingPath,
        branch,
        computeWorktreeBaseRef(baseBranch, detectDefaultBranch(verbose)),
      );
    }

    // In chain mode, rebase existing worktree onto previous chain link
    if (chainMode && baseBranch) {
      if (verbose) {
        console.log(
          chalk.gray(
            `    Rebasing existing worktree onto chain base (${baseBranch})...`,
          ),
        );
      }

      const rebase = rebaseOntoLocalBranch(existingPath, baseBranch, verbose);

      if (!rebase.success) {
        if (rebase.conflict) {
          console.log(
            chalk.yellow(
              `    !  Rebase conflict detected. Aborting rebase and keeping original branch state.`,
            ),
          );
          console.log(
            chalk.yellow(
              `    ℹ️  Branch ${branch} is not properly chained. Manual rebase may be required.`,
            ),
          );
        } else {
          console.log(
            chalk.yellow(`    !  Rebase failed: ${rebase.error ?? ""}`),
          );
          console.log(
            chalk.yellow(
              `    ℹ️  Continuing with branch in its original state.`,
            ),
          );
        }

        return {
          issue: issueNumber,
          path: existingPath,
          branch,
          existed: true,
          rebased: false,
        };
      }

      return {
        issue: issueNumber,
        path: existingPath,
        branch,
        existed: true,
        rebased: true,
      };
    }

    return {
      issue: issueNumber,
      path: existingPath,
      branch,
      existed: true,
      rebased: false,
    };
  }

  // Check if branch exists (but no worktree)
  const branchCheck = spawnSync(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { stdio: "pipe" },
  );
  const branchExists = branchCheck.status === 0;

  if (verbose) {
    console.log(chalk.gray(`    🌿 Creating worktree for #${issueNumber}...`));
  }

  // Determine the base for the new branch
  // For custom base branches, use origin/<branch> if it's a remote-style reference
  // For local branches (chain mode), use as-is
  const detectedDefault = detectDefaultBranch(verbose);
  const effectiveBase = baseBranch || detectedDefault;
  const isLocalBranch =
    baseBranch &&
    !baseBranch.startsWith("origin/") &&
    baseBranch !== detectedDefault;
  const baseRef = computeWorktreeBaseRef(baseBranch, detectedDefault);

  // Fetch the base branch to ensure worktree starts from fresh baseline
  const branchToFetch = effectiveBase.replace(/^origin\//, "");
  if (!isLocalBranch) {
    if (verbose) {
      console.log(chalk.gray(`    Fetching latest ${branchToFetch}...`));
    }
    const fetchResult = spawnSync("git", ["fetch", "origin", branchToFetch], {
      stdio: "pipe",
    });
    if (fetchResult.status !== 0 && verbose) {
      console.log(
        chalk.yellow(
          `    !  Could not fetch origin/${branchToFetch}, using local state`,
        ),
      );
    }
  } else if (verbose) {
    console.log(chalk.gray(`    🔗 Chaining from branch: ${baseBranch}`));
  }

  // Ensure worktrees directory exists
  if (!existsSync(worktreesDir)) {
    spawnSync("mkdir", ["-p", worktreesDir], { stdio: "pipe" });
  }

  // Create the worktree
  let createResult;
  let needsRebase = false;

  if (branchExists) {
    // Use existing branch
    createResult = spawnSync("git", ["worktree", "add", worktreePath, branch], {
      stdio: "pipe",
    });

    // In chain mode with existing branch, mark for rebase onto previous chain link
    if (chainMode && baseBranch) {
      needsRebase = true;
    }
  } else {
    // Create new branch from base reference (origin/main or previous branch in chain)
    createResult = spawnSync(
      "git",
      ["worktree", "add", worktreePath, "-b", branch, baseRef],
      { stdio: "pipe" },
    );
  }

  if (createResult.status !== 0) {
    const error = createResult.stderr.toString();
    console.log(chalk.red(`    ❌ Failed to create worktree: ${error}`));
    return null;
  }

  // #1234: record the exact base so the exec guard and the pre-PR rebase
  // compare against what the worktree was actually cut from.
  recordWorktreeBaseRef(worktreePath, branch, baseRef);

  // Rebase existing branch onto chain base if needed
  let rebased = false;
  if (needsRebase) {
    if (verbose) {
      console.log(
        chalk.gray(
          `    Rebasing existing branch onto previous chain link (${baseRef})...`,
        ),
      );
    }

    const rebaseResult = spawnSync(
      "git",
      ["-C", worktreePath, "rebase", baseRef],
      {
        stdio: "pipe",
      },
    );

    if (rebaseResult.status !== 0) {
      const rebaseError = rebaseResult.stderr.toString();

      // Check if it's a conflict
      if (
        rebaseError.includes("CONFLICT") ||
        rebaseError.includes("could not apply")
      ) {
        console.log(
          chalk.yellow(
            `    !  Rebase conflict detected. Aborting rebase and keeping original branch state.`,
          ),
        );
        console.log(
          chalk.yellow(
            `    ℹ️  Branch ${branch} is not properly chained. Manual rebase may be required.`,
          ),
        );

        // Abort the rebase to restore branch state
        spawnSync("git", ["-C", worktreePath, "rebase", "--abort"], {
          stdio: "pipe",
        });
      } else {
        console.log(
          chalk.yellow(`    !  Rebase failed: ${rebaseError.trim()}`),
        );
        console.log(
          chalk.yellow(`    ℹ️  Continuing with branch in its original state.`),
        );
      }
    } else {
      rebased = true;
      if (verbose) {
        console.log(chalk.green(`    ✔ Branch rebased onto ${baseRef}`));
      }
    }
  }

  // Copy .env.local if it exists
  const envLocalSrc = path.join(gitRoot, ".env.local");
  const envLocalDst = path.join(worktreePath, ".env.local");
  if (existsSync(envLocalSrc) && !existsSync(envLocalDst)) {
    spawnSync("cp", [envLocalSrc, envLocalDst], { stdio: "pipe" });
  }

  // Copy .claude/settings.local.json if it exists
  const claudeSettingsSrc = path.join(
    gitRoot,
    ".claude",
    "settings.local.json",
  );
  const claudeSettingsDst = path.join(
    worktreePath,
    ".claude",
    "settings.local.json",
  );
  if (existsSync(claudeSettingsSrc) && !existsSync(claudeSettingsDst)) {
    spawnSync("mkdir", ["-p", path.join(worktreePath, ".claude")], {
      stdio: "pipe",
    });
    spawnSync("cp", [claudeSettingsSrc, claudeSettingsDst], { stdio: "pipe" });
  }

  // Install dependencies if needed
  const nodeModulesPath = path.join(worktreePath, "node_modules");
  if (!existsSync(nodeModulesPath)) {
    installWorktreeDeps(worktreePath, packageManager, verbose);
  }

  if (verbose) {
    console.log(chalk.green(`    ✔ Worktree ready: ${worktreePath}`));
  }

  return {
    issue: issueNumber,
    path: worktreePath,
    branch,
    existed: false,
    rebased,
  };
}

/**
 * Ensure worktrees exist for all issues before execution
 * @param baseBranch - Optional base branch for worktree creation (default: main)
 * @param worktreeRoot - `run.worktreeRoot` setting; see resolveWorktreeRoot
 */
export async function ensureWorktrees(
  issues: Array<{ number: number; title: string }>,
  verbose: boolean,
  packageManager?: string,
  baseBranch?: string,
  worktreeRoot?: string,
): Promise<Map<number, WorktreeInfo>> {
  const worktrees = new Map<number, WorktreeInfo>();

  const baseDisplay = baseBranch || detectDefaultBranch(verbose);
  console.log(chalk.blue(`\n  Preparing worktrees from ${baseDisplay}...`));

  for (const issue of issues) {
    const worktree = await ensureWorktree(
      issue.number,
      issue.title,
      verbose,
      packageManager,
      baseBranch,
      false, // Non-chain mode: don't rebase existing branches
      worktreeRoot,
    );
    if (worktree) {
      worktrees.set(issue.number, worktree);
    }
  }

  const created = Array.from(worktrees.values()).filter(
    (w) => !w.existed,
  ).length;
  const reused = Array.from(worktrees.values()).filter((w) => w.existed).length;

  if (created > 0 || reused > 0) {
    console.log(
      chalk.gray(`  Worktrees: ${created} created, ${reused} reused`),
    );
  }

  return worktrees;
}

/**
 * Ensure worktrees exist for all issues in chain mode
 * Each issue branches from the previous issue's branch
 * @param baseBranch - Optional starting base branch for the chain (default: main)
 * @param worktreeRoot - `run.worktreeRoot` setting; see resolveWorktreeRoot
 */
export async function ensureWorktreesChain(
  issues: Array<{ number: number; title: string }>,
  verbose: boolean,
  packageManager?: string,
  baseBranch?: string,
  worktreeRoot?: string,
): Promise<Map<number, WorktreeInfo>> {
  const worktrees = new Map<number, WorktreeInfo>();

  const baseDisplay = baseBranch || detectDefaultBranch(verbose);
  console.log(
    chalk.blue(`\n  Preparing chained worktrees from ${baseDisplay}...`),
  );

  // First issue starts from the specified base branch (or main)
  let previousBranch: string | undefined = baseBranch;

  for (const issue of issues) {
    const worktree = await ensureWorktree(
      issue.number,
      issue.title,
      verbose,
      packageManager,
      previousBranch, // Chain from previous branch (or base branch for first issue)
      true, // Chain mode: rebase existing branches onto previous chain link
      worktreeRoot,
    );
    if (worktree) {
      worktrees.set(issue.number, worktree);
      previousBranch = worktree.branch; // Next issue will branch from this
    } else {
      // If worktree creation fails, stop the chain
      console.log(
        chalk.red(
          `  ❌ Chain broken: could not create worktree for #${issue.number}`,
        ),
      );
      break;
    }
  }

  const created = Array.from(worktrees.values()).filter(
    (w) => !w.existed,
  ).length;
  const reused = Array.from(worktrees.values()).filter((w) => w.existed).length;
  const rebased = Array.from(worktrees.values()).filter(
    (w) => w.rebased,
  ).length;

  if (created > 0 || reused > 0) {
    let msg = `  Chained worktrees: ${created} created, ${reused} reused`;
    if (rebased > 0) {
      msg += `, ${rebased} rebased`;
    }
    console.log(chalk.gray(msg));
  }

  // Show chain structure
  if (worktrees.size > 0) {
    const chainOrder = issues
      .filter((i) => worktrees.has(i.number))
      .map((i) => `#${i.number}`)
      .join(" → ");
    console.log(chalk.gray(`  Chain: ${baseDisplay} → ${chainOrder}`));
  }

  return worktrees;
}

/**
 * Create a checkpoint commit in the worktree after QA passes.
 * Only stages files that were touched by the issue's commits (diff vs baseBranch).
 * If unrelated dirty files exist, emits a warning and skips the checkpoint.
 * @internal Exported for testing
 */
export function createCheckpointCommit(
  worktreePath: string,
  issueNumber: number,
  verbose: boolean,
  baseBranch?: string,
): boolean {
  // Check if there are uncommitted changes.
  // Use -z (NUL-terminated) so paths with unicode or special chars aren't quoted/escaped.
  const statusResult = spawnSync(
    "git",
    ["-C", worktreePath, "status", "--porcelain", "-z"],
    { stdio: "pipe" },
  );

  if (statusResult.status !== 0) {
    if (verbose) {
      console.log(
        chalk.yellow(`    !  Could not check git status for checkpoint`),
      );
    }
    return false;
  }

  const statusRaw = statusResult.stdout.toString();
  if (statusRaw.length === 0) {
    if (verbose) {
      console.log(
        chalk.gray(`    📌 No changes to checkpoint (already committed)`),
      );
    }
    return true;
  }

  // Parse NUL-separated porcelain entries. Each entry is "XY path".
  // For renames/copies, the next entry is the old path and must be consumed.
  const entries = statusRaw.split("\0").filter((e) => e.length > 0);
  const dirtyFiles: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path) dirtyFiles.push(path);
    // Rename (R) and copy (C) entries are followed by the original path — skip it
    if (xy[0] === "R" || xy[0] === "C") {
      i++;
    }
  }

  // Determine which files to stage.
  // When baseBranch is provided (chain mode), scope to feature paths only.
  // When baseBranch is absent (non-chain), treat all dirty files as in-scope.
  let inScope: string[];
  if (baseBranch) {
    const diffResult = spawnSync(
      "git",
      ["-C", worktreePath, "diff", "--name-only", "-z", `${baseBranch}...HEAD`],
      { stdio: "pipe" },
    );

    const featurePaths = new Set<string>();
    if (diffResult.status === 0) {
      diffResult.stdout
        .toString()
        .split("\0")
        .filter((p) => p.length > 0)
        .forEach((p) => featurePaths.add(p));
    }

    inScope = dirtyFiles.filter((f) => featurePaths.has(f));
    const outOfScope = dirtyFiles.filter((f) => !featurePaths.has(f));

    // AC-2: If unrelated dirty files exist, warn and skip checkpoint
    if (outOfScope.length > 0) {
      console.log(
        chalk.yellow(
          `    ⚠  Skipping checkpoint for #${issueNumber}: ${outOfScope.length} unrelated dirty file(s) in worktree:`,
        ),
      );
      for (const f of outOfScope) {
        console.log(chalk.yellow(`       - ${f}`));
      }
      return false;
    }
  } else {
    // Non-chain mode: all dirty files are in-scope
    inScope = dirtyFiles;
  }

  if (inScope.length === 0) {
    if (verbose) {
      console.log(chalk.gray(`    📌 No in-scope changes to checkpoint`));
    }
    return true;
  }

  // AC-1: Stage only in-scope feature paths
  const addResult = spawnSync(
    "git",
    ["-C", worktreePath, "add", "--", ...inScope],
    { stdio: "pipe" },
  );

  if (addResult.status !== 0) {
    if (verbose) {
      console.log(
        chalk.yellow(`    !  Could not stage changes for checkpoint`),
      );
    }
    return false;
  }

  // Create checkpoint commit
  const commitMessage = `checkpoint(#${issueNumber}): QA passed

This is an automatic checkpoint commit created after issue #${issueNumber}
passed QA in chain mode. It serves as a recovery point if later issues fail.`;

  const commitResult = spawnSync(
    "git",
    ["-C", worktreePath, "commit", "-m", commitMessage],
    { stdio: "pipe" },
  );

  if (commitResult.status !== 0) {
    const error = commitResult.stderr.toString();
    // #760: chain resume rebases the next link onto this checkpoint, so a
    // commit failure is surfaced regardless of --verbose (the call site adds
    // the resume-impact warning; here we show the underlying git error).
    console.log(
      chalk.yellow(
        `    !  Could not create checkpoint commit for #${issueNumber}: ${error.trim()}`,
      ),
    );
    return false;
  }

  console.log(
    chalk.green(`    📌 Checkpoint commit created for #${issueNumber}`),
  );
  return true;
}

/**
 * Check if any lockfile changed during a rebase and re-run install if needed.
 * This prevents dependency drift when the lockfile was updated on main.
 * @param worktreePath Path to the worktree
 * @param packageManager Package manager to use for install
 * @param verbose Whether to show verbose output
 * @param preRebaseRef Git ref pointing to pre-rebase HEAD (defaults to ORIG_HEAD,
 *        which git sets automatically after rebase). Using ORIG_HEAD captures all
 *        lockfile changes across multi-commit rebases, unlike HEAD~1 which only
 *        checks the last commit.
 * @returns true if reinstall was performed, false otherwise
 * @internal Exported for testing
 */
export function reinstallIfLockfileChanged(
  worktreePath: string,
  packageManager: string | undefined,
  verbose: boolean,
  preRebaseRef: string = "ORIG_HEAD",
): boolean {
  // Compare pre-rebase state to current HEAD to detect all lockfile changes
  // introduced by the rebase (including changes from main that were pulled in)
  let lockfileChanged = false;

  for (const lockfile of LOCKFILES) {
    const result = spawnSync(
      "git",
      [
        "-C",
        worktreePath,
        "diff",
        "--name-only",
        `${preRebaseRef}..HEAD`,
        "--",
        lockfile,
      ],
      { stdio: "pipe" },
    );

    if (result.status === 0 && result.stdout.toString().trim().length > 0) {
      lockfileChanged = true;
      if (verbose) {
        console.log(chalk.gray(`    Lockfile changed: ${lockfile}`));
      }
      break;
    }
  }

  if (!lockfileChanged) {
    if (verbose) {
      console.log(chalk.gray(`    No lockfile changes detected`));
    }
    return false;
  }

  // Re-run install to sync node_modules with updated lockfile
  console.log(
    chalk.blue(`    Reinstalling dependencies (lockfile changed)...`),
  );

  // Same two-step resolution as installWorktreeDeps: manifest-or-lockfile for
  // the manager (#870), then classic-vs-berry for its commands (#871).
  const pmConfig = resolvePackageManagerConfig(
    resolvePackageManager(packageManager, worktreePath),
    worktreePath,
  );

  // Defensive, not reachable in practice today: LOCKFILES above is JS-only,
  // so `lockfileChanged` can only fire for a JS lockfile, never for a pip or
  // uv tree. Kept in step with installWorktreeDeps / combined-branch-test.ts
  // anyway, in case a declared `packageManager` of "pip" or "uv" ever reaches
  // here (#1196, #1217).
  if (pmConfig.ciInstall === CI_INSTALL_SKIP) {
    console.log(
      chalk.gray(
        `    Skipping dependency reinstall — no install command applies`,
      ),
    );
    return false;
  }
  // ciInstall for the same reason as provisioning (see ensureWorktree): this
  // reinstall exists because a rebase pulled in a NEW lockfile, so installing
  // exactly what that lockfile says — never rewriting it — is the semantic
  // the function's own name promises.
  const [cmd, ...args] = pmConfig.ciInstall.split(" ");

  const installResult = spawnSync(cmd, args, {
    cwd: worktreePath,
    stdio: "pipe",
  });

  if (installResult.status !== 0) {
    const error = installResult.stderr.toString();
    console.log(
      chalk.yellow(`    !  Dependency reinstall failed: ${error.trim()}`),
    );
    return false;
  }

  console.log(chalk.green(`    ✔ Dependencies reinstalled`));
  return true;
}

/**
 * Rebase a worktree's branch onto a *local* branch ref (e.g. a chain
 * predecessor's feature branch), NOT origin/main. Used to chain a successor
 * onto its predecessor's committed work at execution time (#748), and to
 * re-chain a pre-existing worktree onto its chain base.
 *
 * On conflict, aborts the rebase to restore the original branch state and
 * returns `{ success: false, conflict: true }` so callers can warn rather than
 * silently treat a broken link as healthy.
 */
export function rebaseOntoLocalBranch(
  worktreePath: string,
  ontoBranch: string,
  verbose: boolean = false,
): LocalRebaseResult {
  const rebaseResult = spawnSync(
    "git",
    ["-C", worktreePath, "rebase", ontoBranch],
    { stdio: "pipe" },
  );

  if (rebaseResult.status === 0) {
    if (verbose) {
      console.log(chalk.green(`    ✔ Rebased worktree onto ${ontoBranch}`));
    }
    return { performed: true, success: true, conflict: false };
  }

  const rebaseError = rebaseResult.stderr.toString();
  const isConflict =
    rebaseError.includes("CONFLICT") || rebaseError.includes("could not apply");

  if (isConflict) {
    // Abort to restore the original branch state.
    spawnSync("git", ["-C", worktreePath, "rebase", "--abort"], {
      stdio: "pipe",
    });
  }

  return {
    performed: true,
    success: false,
    conflict: isConflict,
    error: rebaseError.trim(),
  };
}

/**
 * True iff the worktree's branch has been pushed: it has an upstream that is
 * not the base ref. A fresh `git worktree add -b <branch> origin/main` sets the
 * upstream to `origin/main` for a never-pushed branch, so a bare `@{u}` check
 * would merge on every first run (#1069).
 */
function branchIsPushed(worktreePath: string, baseRef: string): boolean {
  const upstream = spawnSync(
    "git",
    [
      "-C",
      worktreePath,
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ],
    { stdio: "pipe" },
  );
  if (upstream.status !== 0) return false;
  const name = upstream.stdout?.toString().trim();
  return !!name && name !== baseRef;
}

/** Whether `ref` resolves to a commit in `cwd`; false on any git error (#1234). */
function refResolves(cwd: string, ref: string): boolean {
  try {
    execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      {
        cwd,
        stdio: "pipe",
      },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Rebase the worktree branch onto the base branch before PR creation.
 * This ensures the branch is up-to-date and prevents lockfile drift.
 *
 * @param worktreePath Path to the worktree
 * @param issueNumber Issue number (for logging)
 * @param packageManager Package manager to use if reinstall needed
 * @param verbose Whether to show verbose output
 * @param baseBranch Base branch to rebase onto (default: "main")
 * @returns RebaseResult indicating success/failure and whether reinstall was performed
 * @internal Exported for testing
 */
export function rebaseBeforePR(
  worktreePath: string,
  issueNumber: number,
  packageManager: string | undefined,
  verbose: boolean,
  baseBranch: string = "main",
): RebaseResult {
  let baseRef = `origin/${baseBranch}`;

  // Fetch latest base branch to ensure we're rebasing onto fresh state
  const fetchResult = spawnSync(
    "git",
    ["-C", worktreePath, "fetch", "origin", baseBranch],
    {
      stdio: "pipe",
    },
  );

  if (fetchResult.status !== 0) {
    // #1234: a base that exists only locally (a local `--base`, never pushed)
    // has no `origin/<base>` to fetch or rebase onto. Use the local branch
    // quietly. Decided by the remote, not by the worktree's recorded base: a
    // pushed `--base` must still be fetched and rebased onto fresh, and a
    // chain's final link recorded its predecessor, not the run's base.
    if (
      !refResolves(worktreePath, `refs/remotes/origin/${baseBranch}`) &&
      refResolves(worktreePath, `refs/heads/${baseBranch}`)
    ) {
      baseRef = baseBranch;
      if (verbose) {
        console.log(
          chalk.gray(
            `    ${baseBranch} exists only locally — rebasing onto the local branch`,
          ),
        );
      }
    } else {
      const error = fetchResult.stderr.toString();
      console.log(
        chalk.yellow(`    !  Could not fetch ${baseRef}: ${error.trim()}`),
      );
      // Continue anyway - might work with local state
    }
  }

  if (verbose) {
    console.log(
      chalk.gray(`    Rebasing #${issueNumber} onto ${baseRef} before PR...`),
    );
  }

  // #1069: rebasing a branch that exists on the remote rewrites pushed SHAs and
  // can only be landed by force-push. Merge instead; rebase only unpushed work.
  const pushed = branchIsPushed(worktreePath, baseRef);
  const strategy = pushed ? "merge" : "rebase";
  const verb = pushed ? "Merge" : "Rebase";
  const preOpHead = spawnSync(
    "git",
    ["-C", worktreePath, "rev-parse", "HEAD"],
    {
      stdio: "pipe",
    },
  )
    .stdout?.toString()
    .trim();

  const opResult = spawnSync(
    "git",
    pushed
      ? ["-C", worktreePath, "merge", "--no-edit", baseRef]
      : ["-C", worktreePath, "rebase", baseRef],
    { stdio: "pipe" },
  );

  if (opResult.status !== 0) {
    const opError = `${opResult.stderr.toString()}${opResult.stdout?.toString() ?? ""}`;

    // Check if it's a conflict
    if (opError.includes("CONFLICT") || opError.includes("could not apply")) {
      console.log(
        chalk.yellow(
          `    !  ${verb} conflict detected. Aborting ${strategy} and keeping original branch state.`,
        ),
      );
      console.log(
        chalk.yellow(
          `    ℹ️  PR will be created without ${strategy}. Manual ${strategy} may be required before merge.`,
        ),
      );

      // Abort to restore branch state
      spawnSync("git", ["-C", worktreePath, strategy, "--abort"], {
        stdio: "pipe",
      });

      return {
        performed: true,
        success: false,
        reinstalled: false,
        strategy,
        error: `${verb} conflict - manual resolution required`,
      };
    } else {
      console.log(chalk.yellow(`    !  ${verb} failed: ${opError.trim()}`));
      // A merge that fails after staging (e.g. no git identity) leaves
      // MERGE_HEAD set; abort so createPR never runs against a mid-merge tree.
      if (pushed) {
        spawnSync("git", ["-C", worktreePath, "merge", "--abort"], {
          stdio: "pipe",
        });
      }
      console.log(
        chalk.yellow(`    ℹ️  Continuing with branch in its original state.`),
      );

      return {
        performed: true,
        success: false,
        reinstalled: false,
        strategy,
        error: opError.trim(),
      };
    }
  }

  console.log(
    chalk.green(
      pushed
        ? `    ✔ Branch merged ${baseRef}`
        : `    ✔ Branch rebased onto ${baseRef}`,
    ),
  );

  // Check if lockfile changed and reinstall if needed
  // A merge does not reliably set ORIG_HEAD, so diff from the captured HEAD.
  const reinstalled = reinstallIfLockfileChanged(
    worktreePath,
    packageManager,
    verbose,
    preOpHead || undefined,
  );

  return {
    performed: true,
    success: true,
    reinstalled,
    strategy,
  };
}

/**
 * Render a non-A+ QA verdict as a PR-body note, or `null` for an A+ / absent
 * verdict.
 *
 * Only stopping states that still break to a PR reach this path
 * (`AC_MET_BUT_NOT_A_PLUS`, `NEEDS_VERIFICATION`); `READY_FOR_MERGE` and an
 * absent verdict produce no note. (#749)
 */
function qaVerdictNote(verdict?: string): string | null {
  if (!verdict || verdict === "READY_FOR_MERGE") return null;
  switch (verdict) {
    case "AC_MET_BUT_NOT_A_PLUS":
      return `> **QA verdict: AC_MET_BUT_NOT_A_PLUS** — acceptance criteria met, but not A+. The run broke to this PR for review rather than entering the quality loop; see the QA review comment for improvement notes.`;
    case "NEEDS_VERIFICATION":
      return `> **QA verdict: NEEDS_VERIFICATION** — acceptance criteria met, pending external verification (e.g. CI or a manual test). See the QA review comment.`;
    default:
      return `> **QA verdict: ${verdict}** — see the QA review comment.`;
  }
}

/**
 * GitHub's closing keywords (case-insensitive), the verbs that auto-close a
 * linked issue on merge when immediately followed by `#N`. See
 * https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue
 */
const CLOSING_KEYWORDS = "close[sd]?|fix(?:e[sd])?|resolve[sd]?";

/**
 * Rewrite every closing-keyword reference to `issueNumber` in `body` to a
 * plain `Refs #N`, wherever it appears — including inside a markdown table
 * cell (#1197 AC-4). GitHub parses a closing keyword anywhere in the PR body,
 * not just on its own line, so a targeted single-line emit (the `Fixes #N`
 * line below) is not enough: an agent-written AC-mapping row that happens to
 * begin with a closing verb and the issue number closes the issue just as
 * surely.
 *
 * Scoped to `issueNumber` only — other issue numbers mentioned in the body
 * (e.g. a tracker reference) are left untouched. The repo-prefixed form
 * (`Fixes owner/repo#N`), which GitHub also documents as closing, is
 * rewritten with its prefix kept. Other spellings (`Fixes: #N`,
 * `**Fixes** #N`) are not rewritten; the merge-time guard in /merger and
 * /fullsolve catches those.
 */
function rewriteClosingKeywordsToRefs(
  body: string,
  issueNumber: number,
): string {
  const pattern = new RegExp(
    `\\b(?:${CLOSING_KEYWORDS})\\s+((?:[\\w.-]+\\/[\\w.-]+)?)#${issueNumber}(?!\\d)`,
    "gi",
  );
  return body.replace(pattern, `Refs $1#${issueNumber}`);
}

/**
 * Real conventional-commit types (#1223). Deliberately excludes anything not
 * on this list — a capitalized, non-standard prefix like `Docs: foo` must not
 * be mistaken for a `type(scope)!?:` prefix.
 */
const CONVENTIONAL_COMMIT_TYPES = [
  "feat",
  "fix",
  "docs",
  "chore",
  "refactor",
  "test",
  "perf",
  "build",
  "ci",
  "style",
  "revert",
];

/**
 * Title prefixes that aren't conventional-commit types but mean one. `bug` is
 * this repo's third most common issue-title prefix (32 of the last 400,
 * behind `fix` and `feat`), and it maps to `fix` just as a `bug` label does.
 */
const PREFIX_TYPE_ALIASES: Record<string, string> = { bug: "fix" };

const CONVENTIONAL_PREFIX_RE = new RegExp(
  `^(${[...CONVENTIONAL_COMMIT_TYPES, ...Object.keys(PREFIX_TYPE_ALIASES)].join("|")})(\\([^)]*\\))?(!)?:\\s*`,
);

/**
 * Build the PR title from the issue title and number (#1223).
 *
 * When the issue title already starts with a conventional-commit prefix
 * (`type(scope)!?:` or `type:`), its **type** is reused and `#N` replaces the
 * scope — `feat(adopt): x` becomes `feat(#1209): x` — instead of doubling the
 * prefix (`feat(#1209): feat(adopt): x`, the #1223 bug). Titles without a
 * recognized prefix keep today's label-derived `isBug ? "fix" : "feat"`.
 *
 * @internal Exported for testing
 */
export function buildPRTitle(
  issueTitle: string,
  issueNumber: number,
  labels?: string[],
): string {
  const match = issueTitle.match(CONVENTIONAL_PREFIX_RE);
  if (match) {
    const rest = issueTitle.slice(match[0].length);
    const type = PREFIX_TYPE_ALIASES[match[1]] ?? match[1];
    // Keep a breaking-change `!`: `feat(api)!: x` → `feat(#N)!: x`.
    const bang = match[3] ?? "";
    return `${type}(#${issueNumber})${bang}: ${rest}`;
  }
  const isBug = labels?.some((l) => /^bug/i.test(l));
  const prefix = isBug ? "fix" : "feat";
  return `${prefix}(#${issueNumber}): ${issueTitle}`;
}

/** Cap on the imported exec summary so a runaway section can't bloat the PR body. */
const EXEC_SUMMARY_MAX_LENGTH = 4000;

/**
 * Extract the last `## Summary` or `### Summary` section from exec's captured
 * phase output (#1223 AC-2), running up to the next heading of the same or a
 * higher level, or the end of the string. Returns `undefined` when no summary section is present so the
 * caller can fall back to the placeholder text.
 *
 * @internal Exported for testing
 */
export function extractExecSummary(
  execOutput: string | undefined,
): string | undefined {
  if (!execOutput) return undefined;
  // `##` or `###`: real exec output uses both. Of 20 exec sessions on
  // 2026-09-30, 3 ended with `## Summary`, 4 with `### Summary`, and 13 with
  // none, so an `##`-only match missed most of the summaries that exist.
  const headingRe = /^(#{2,3})\s+Summary\s*$/gim;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(execOutput)) !== null) {
    lastMatch = match;
  }
  if (!lastMatch) return undefined;
  const rest = execOutput.slice(lastMatch.index + lastMatch[0].length);
  // Ends at the next heading of the same or a higher level: a `### Summary`
  // stops at `###`, `##` or `#`; a `## Summary` keeps its `###` subsections.
  const level = lastMatch[1].length;
  const nextHeading = rest.match(new RegExp(`^#{1,${level}}\\s+`, "m"));
  const end = nextHeading?.index ?? rest.length;
  const summary = rest.slice(0, end).trim();
  if (!summary) return undefined;
  return summary.length > EXEC_SUMMARY_MAX_LENGTH
    ? summary.slice(0, EXEC_SUMMARY_MAX_LENGTH).trim()
    : summary;
}

/**
 * Rewrite any closing-verb + `#N` reference inside imported summary text to
 * `Refs #N` (#1223 AC-3). GitHub reads a closing keyword anywhere in the PR
 * body, so an agent-written summary containing e.g. "Close #279 with the AC
 * mapping comment" would auto-close an unrelated issue on merge. Unlike
 * {@link rewriteClosingKeywordsToRefs}, this is unconditional (not gated on
 * `linkMode`) and scoped to *any* issue number, not just the PR's own —
 * applied only to imported text, never to the body's own trailer.
 *
 * @internal Exported for testing
 */
export function sanitizeImportedClosingKeywords(text: string): string {
  // Any issue reference GitHub's closing keywords accept: `#N`,
  // `owner/repo#N`, or a full issue URL. A cross-repo reference closes the
  // other repo's issue too, when the merger has access to it.
  const ref = String.raw`(?:[\w.-]+/[\w.-]+)?#\d+|https?://github\.com/[\w.-]+/[\w.-]+/issues/\d+`;
  const pattern = new RegExp(
    String.raw`\b(?:${CLOSING_KEYWORDS})\s*:?\s+(${ref})`,
    "gi",
  );
  return text.replace(pattern, "Refs $1");
}

/**
 * Resolve which closing-keyword mode a PR's issue link should use (#1197).
 *
 * An issue carrying `noCloseLabel` always resolves to `"refs"`, regardless of
 * `prIssueLink` (AC-2) — the label is a per-issue override, not a fallback.
 *
 * @param labels Issue labels, if known
 * @param prIssueLink `settings.run.prIssueLink` (default `"closes"`)
 * @param noCloseLabel `settings.run.prNoCloseLabel` (default `"no-autoclose"`)
 * @internal Exported for testing
 */
export function resolvePrLinkMode(
  labels: string[] | undefined,
  prIssueLink: "closes" | "refs" | undefined,
  noCloseLabel: string | undefined,
): "closes" | "refs" {
  const label = noCloseLabel ?? "no-autoclose";
  if (labels?.includes(label)) return "refs";
  return prIssueLink ?? "closes";
}

/**
 * The resolution suffix `/qa` appends to a `document` finding's description
 * (#1249): ` — filed #N`, ` — fixed in this PR` or ` — dropped: <reason>`.
 * The suffix is the parse contract; `SEQUANT_QA_GAPS`'s schema is unchanged
 * (ADR 0007).
 */
const FOLLOWUP_RESOLUTION_RE =
  /\s+[—–-]+\s+(filed #\d+|fixed in this PR|dropped: \S.*)$/i;

/** The ledger template's own unresolved suffix, dropped before the renderer adds one. */
const FOLLOWUP_UNRESOLVED_RE = /\s+[—–-]+\s+(?:⚠️\s*)?unresolved$/iu;

/**
 * Render the `## Follow-ups` checklist from QA's `document` findings (#1249
 * AC-2). One line per finding: checked with its resolution when the
 * description ends in a resolution suffix, unchecked and marked `unresolved`
 * otherwise. Returns null when there are no `document` findings, so a clean
 * run renders no section.
 *
 * @internal Exported for testing
 */
export function renderFollowups(
  findings: GapFinding[] | undefined,
): string | null {
  const followups = (findings ?? []).filter(
    (f) => f.recommendedAction === "document",
  );
  if (followups.length === 0) return null;
  const lines = followups.map((f) => {
    const text = f.description.trim();
    const match = FOLLOWUP_RESOLUTION_RE.exec(text);
    const line = match
      ? `- [x] ${text.slice(0, match.index)} — ${match[1]}`
      : `- [ ] ${text.replace(FOLLOWUP_UNRESOLVED_RE, "")} — unresolved`;
    // Finding text is imported: "fixes #812" in it must not close #812.
    return sanitizeImportedClosingKeywords(line);
  });
  return [`## Follow-ups`, ``, ...lines].join("\n");
}

/** Trailer every {@link buildAutomatedPRBody} body ends with. */
const AUTOMATED_PR_TRAILER = "🤖 Generated by `sequant run`";

/**
 * Whether an existing PR body may be overwritten by `sequant run` (#1247 AC-2).
 *
 * True only for an empty body or one carrying the automated trailer. Any
 * other body was written by someone else (a human, or a pre-#1247 exec-made
 * PR) and is left alone. An unknown body (`undefined`) is not overwritten.
 *
 * @internal Exported for testing
 */
export function isAutomatedPRBody(body: string | undefined): boolean {
  if (body === undefined) return false;
  return body.trim() === "" || body.includes(AUTOMATED_PR_TRAILER);
}

/**
 * Build the automated PR body for `sequant run`.
 *
 * Pure and I/O-free, kept separate from {@link createPR} (which shells out to
 * `gh`) so the body — including the non-A+ QA note (#749) — is unit-testable
 * directly.
 *
 * @param issueNumber Issue the PR closes
 * @param opts.stackManifest Appended before the trailer under --stacked (#605)
 * @param opts.qaVerdict QA verdict for the run; a non-A+ stopping state
 *   (anything other than `READY_FOR_MERGE`) surfaces a note so a human reviewer
 *   sees why the run broke to PR without reaching A+ (#749).
 * @param opts.readyGateReport Rendered `sequant ready` gap report (#817). Set
 *   only when the run used `--ready-gate`; surfaces the gate outcome (threshold
 *   reached vs guard halt) in the PR body the same way `sequant ready` does.
 * @param opts.linkMode Resolved via {@link resolvePrLinkMode} (#1197). `"refs"`
 *   emits `Refs #N` instead of `Fixes #N`, and rewrites any other closing-verb
 *   reference to `issueNumber` in the assembled body to `Refs #N` (AC-4).
 *   Defaults to `"closes"` — today's behavior — when omitted.
 * @param opts.execOutput The exec phase's captured `PhaseResult.output`
 *   (#1223 AC-2). Its last `## Summary` section, sanitized of closing
 *   keywords (AC-3), replaces the placeholder line when present.
 * @param opts.execSummary An already-extracted exec summary (#1247 AC-3),
 *   recorded on the issue's state by an earlier run. Used only when
 *   `execOutput` yields no summary — a qa-only run has no exec output.
 * @param opts.followups The latest QA pass's findings (#1249 AC-2); its
 *   `document` findings render as a `## Follow-ups` checklist via
 *   {@link renderFollowups}.
 * @internal Exported for testing
 */
export function buildAutomatedPRBody(
  issueNumber: number,
  opts?: {
    stackManifest?: string;
    qaVerdict?: string;
    readyGateReport?: string;
    linkMode?: "closes" | "refs";
    execOutput?: string;
    execSummary?: string;
    followups?: GapFinding[];
  },
): string {
  const linkMode = opts?.linkMode ?? "closes";
  const closingLine =
    linkMode === "refs" ? `Refs #${issueNumber}` : `Fixes #${issueNumber}`;
  const execSummary =
    extractExecSummary(opts?.execOutput) ?? opts?.execSummary?.trim();
  const summaryLine = execSummary
    ? sanitizeImportedClosingKeywords(execSummary)
    : `Automated PR for issue #${issueNumber}.`;
  const bodyLines = [`## Summary`, ``, summaryLine, ``, closingLine, ``];
  // #749: surface a non-A+ QA verdict in the PR body (not just the run log) so
  // a reviewer sees why the run broke to PR rather than reaching A+.
  //
  // #817: when the ready gate ran, its report already carries the terminal
  // verdict and stop reason (a superset of the #749 note), so prefer it and
  // suppress the standalone note to avoid a contradictory double-headline.
  if (opts?.readyGateReport) {
    bodyLines.push(opts.readyGateReport, ``);
  } else {
    const note = qaVerdictNote(opts?.qaVerdict);
    if (note) {
      bodyLines.push(note, ``);
    }
  }
  // #1249 AC-2: every deferred QA finding reaches the PR with its resolution.
  const followups = renderFollowups(opts?.followups);
  if (followups) {
    bodyLines.push(followups, ``);
  }
  // #605 AC-4: emit stack manifest before the trailer so reviewers see the
  // chain at the top of the body. Manifest is only set under --stacked.
  if (opts?.stackManifest) {
    bodyLines.push(opts.stackManifest, ``);
  }
  bodyLines.push(`---`, AUTOMATED_PR_TRAILER);
  const rendered = bodyLines.join("\n");
  // #1197 AC-4: catch any other closing-verb + issueNumber combination that
  // slipped into the body via stackManifest/readyGateReport text, not just the
  // explicit closingLine above.
  return linkMode === "refs"
    ? rewriteClosingKeywordsToRefs(rendered, issueNumber)
    : rendered;
}

/**
 * Push branch and create a PR after successful QA.
 *
 * Under `sequant run` this is the only PR producer (#1247): the exec skill
 * opens none while `SEQUANT_ORCHESTRATOR` is set. A PR that already exists
 * for the branch is pushed to and updated in place — title and body only when
 * {@link isAutomatedPRBody} says the body is sequant's own, `base` under
 * `--stacked` regardless. A failed update warns but stays a success.
 *
 * Returns `{ success: false, error }` on failure. As of #879 the caller
 * (`runIssueWithLogging`) treats an attempted-but-failed PR as a run failure:
 * a passing run that produced no PR is not a success. This function itself
 * still only reports — it never throws — so relay teardown runs regardless.
 *
 * @param worktreePath Path to the worktree
 * @param issueNumber Issue number
 * @param issueTitle Issue title (for PR title)
 * @param branch Branch name
 * @param verbose Whether to show verbose output
 * @param labels Issue labels (used to pick `fix(...)` vs `feat(...)` prefix)
 * @param stackOptions When set under --stacked, `prBase` overrides the default
 *   PR target (otherwise gh defaults to the repo's default branch) and
 *   `stackManifest` is appended to the PR body. (#605)
 * @param qaVerdict QA verdict surfaced in the PR body when non-A+ (#749).
 * @param readyGateReport Rendered `sequant ready` gap report, set only when the
 *   run used `--ready-gate` (#817).
 * @param prIssueLink `settings.run.prIssueLink` (#1197): `"closes"` (default)
 *   emits `Fixes #N`, `"refs"` emits `Refs #N`. Overridden to `"refs"` for an
 *   issue carrying `prNoCloseLabel`, via {@link resolvePrLinkMode}.
 * @param prNoCloseLabel `settings.run.prNoCloseLabel` (#1197 AC-2), default
 *   `"no-autoclose"`.
 * @param opts.execOutput The exec phase's captured output (#1223 AC-2),
 *   threaded through to {@link buildAutomatedPRBody}. Added as a trailing
 *   options object rather than another positional parameter.
 * @param opts.execSummary Exec summary recorded on the issue's state by an
 *   earlier run (#1247 AC-3), the fallback when `execOutput` has none.
 * @param opts.followups The latest QA pass's findings (#1249 AC-2).
 * @returns PRCreationResult with PR info or error
 * @internal Exported for testing
 */
export function createPR(
  worktreePath: string,
  issueNumber: number,
  issueTitle: string,
  branch: string,
  verbose: boolean,
  labels?: string[],
  stackOptions?: { prBase?: string; stackManifest?: string },
  qaVerdict?: string,
  readyGateReport?: string,
  prIssueLink?: "closes" | "refs",
  prNoCloseLabel?: string,
  opts?: {
    execOutput?: string;
    execSummary?: string;
    followups?: GapFinding[];
  },
): PRCreationResult {
  const github = new GitHubProvider();

  // Title and body are built once, before Step 1, so the create path and the
  // update-existing path (#1247) publish the same content.
  const prTitle = buildPRTitle(issueTitle, issueNumber, labels);
  const linkMode = resolvePrLinkMode(labels, prIssueLink, prNoCloseLabel);
  const prBody = buildAutomatedPRBody(issueNumber, {
    stackManifest: stackOptions?.stackManifest,
    qaVerdict,
    readyGateReport,
    linkMode,
    execOutput: opts?.execOutput,
    execSummary: opts?.execSummary,
    followups: opts?.followups,
  });

  const pushBranch = (): PRCreationResult | null => {
    if (verbose) {
      console.log(chalk.gray(`    🚀 Pushing branch ${branch} to origin...`));
    }
    const pushResult = spawnSync(
      "git",
      ["-C", worktreePath, "push", "-u", "origin", branch],
      { stdio: "pipe", timeout: 60000 },
    );
    if (pushResult.status !== 0) {
      const pushError = pushResult.stderr?.toString().trim() ?? "Unknown error";
      console.log(chalk.yellow(`    !  git push failed: ${pushError}`));
      return {
        attempted: true,
        success: false,
        error: `git push failed: ${pushError}`,
      };
    }
    return null;
  };

  // #1247: a PR that already exists for the branch is updated, not returned
  // untouched — otherwise the QA note, ready-gate report and exec summary
  // built above never reach it.
  const updateExisting = (existing: {
    number: number;
    url: string;
    body?: string;
  }): PRCreationResult => {
    const fields: { title?: string; body?: string; base?: string } = {};
    if (isAutomatedPRBody(existing.body)) {
      fields.title = prTitle;
      fields.body = prBody;
    } else {
      console.log(
        chalk.yellow(
          `    !  PR #${existing.number} body was edited by hand; not overwritten`,
        ),
      );
    }
    if (stackOptions?.prBase) {
      fields.base = stackOptions.prBase;
    }
    const update = github.updatePRSync(existing.number, fields, worktreePath);
    if (!update.success) {
      // The PR exists, so the run still produced one (#879 is about a
      // missing PR); a stale body is a warning, not a failure.
      console.log(
        chalk.yellow(
          `    !  PR #${existing.number} update failed: ${update.error}`,
        ),
      );
    } else if (verbose) {
      console.log(chalk.gray(`    ℹ️  PR #${existing.number} updated`));
    }
    return {
      attempted: true,
      success: true,
      prNumber: existing.number,
      prUrl: existing.url,
    };
  };

  // Step 1: Check for existing PR on this branch
  const existingPRInfo = github.viewPRByBranchSync(branch, worktreePath);

  if (existingPRInfo) {
    if (verbose) {
      console.log(
        chalk.gray(
          `    ℹ️  PR #${existingPRInfo.number} already exists for branch ${branch}`,
        ),
      );
    }
    // Push first: commits made after the PR was opened (a qa-loop fix) would
    // otherwise stay local.
    const pushFailure = pushBranch();
    if (pushFailure) return pushFailure;
    return updateExisting(existingPRInfo);
  }

  // Step 2: Push branch to remote
  const pushFailure = pushBranch();
  if (pushFailure) return pushFailure;

  // Step 3: Create PR
  if (verbose) {
    console.log(chalk.gray(`    Creating PR for #${issueNumber}...`));
  }

  const prResult = github.createPRCliSync(
    prTitle,
    prBody,
    branch,
    worktreePath,
    stackOptions?.prBase,
  );

  if (prResult.exitCode !== 0) {
    const prError = prResult.stderr.trim() || "Unknown error";
    // Check if PR already exists (race condition or push-before-PR scenarios)
    if (prError.includes("already exists")) {
      const retryInfo = github.viewPRByBranchSync(branch, worktreePath);
      if (retryInfo) {
        return updateExisting(retryInfo);
      }
    }
    console.log(chalk.yellow(`    !  PR creation failed: ${prError}`));
    return {
      attempted: true,
      success: false,
      error: `gh pr create failed: ${prError}`,
    };
  }

  // Step 4: Extract PR URL from output and get PR details
  const prOutput = prResult.stdout.trim();
  const prUrlMatch = prOutput.match(
    /https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/,
  );

  if (prUrlMatch) {
    const prNumber = parseInt(prUrlMatch[1], 10);
    const prUrl = prUrlMatch[0];
    console.log(chalk.green(`    ✔ PR #${prNumber} created: ${prUrl}`));
    return {
      attempted: true,
      success: true,
      prNumber,
      prUrl,
    };
  }

  // Fallback: try gh pr view to get details
  const viewInfo = github.viewPRByBranchSync(branch, worktreePath);

  if (viewInfo) {
    console.log(
      chalk.green(`    ✔ PR #${viewInfo.number} created: ${viewInfo.url}`),
    );
    return {
      attempted: true,
      success: true,
      prNumber: viewInfo.number,
      prUrl: viewInfo.url,
    };
  }

  // PR was created but we couldn't parse the URL
  console.log(
    chalk.yellow(
      `    !  PR created but could not extract URL from output: ${prOutput}`,
    ),
  );
  return {
    attempted: true,
    success: true,
    error: "PR created but URL extraction failed",
  };
}
