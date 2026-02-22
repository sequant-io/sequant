/**
 * Worktree discovery for state bootstrapping
 *
 * @module worktree-discovery
 * @example
 * ```typescript
 * import { discoverUntrackedWorktrees } from './worktree-discovery';
 *
 * // Discover worktrees not yet tracked in state
 * const result = await discoverUntrackedWorktrees({ verbose: true });
 * for (const worktree of result.discovered) {
 *   console.log(`Found: #${worktree.issueNumber} - ${worktree.title}`);
 * }
 * ```
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { StateManager } from "./state-manager.js";
import { type Phase } from "./state-schema.js";
import { RunLogSchema, LOG_PATHS } from "./run-log-schema.js";

export interface DiscoverOptions {
  /** State file path (default: .sequant/state.json) */
  statePath?: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

export interface DiscoveredWorktree {
  /** Issue number extracted from branch name */
  issueNumber: number;
  /** Issue title (fetched from GitHub or placeholder) */
  title: string;
  /** Full path to the worktree */
  worktreePath: string;
  /** Branch name */
  branch: string;
  /** Inferred current phase from logs (if available) */
  inferredPhase?: Phase;
}

export interface SkippedWorktree {
  /** Path to the worktree */
  path: string;
  /** Reason it was skipped */
  reason: string;
}

export interface DiscoverResult {
  /** Whether discovery was successful */
  success: boolean;
  /** Number of worktrees scanned */
  worktreesScanned: number;
  /** Number of worktrees already tracked */
  alreadyTracked: number;
  /** Discovered worktrees not yet in state */
  discovered: DiscoveredWorktree[];
  /** Worktrees that were skipped (not matching pattern, etc.) */
  skipped: SkippedWorktree[];
  /** Error message if failed */
  error?: string;
}

/**
 * Parse issue number from a branch name
 *
 * Supports patterns:
 * - feature/<number>-<slug>
 * - issue-<number>
 * - <number>-<slug>
 */
function parseIssueNumberFromBranch(branch: string): number | null {
  // Pattern: feature/123-description or feature/123
  const featureMatch = branch.match(/^feature\/(\d+)(?:-|$)/);
  if (featureMatch) {
    return parseInt(featureMatch[1], 10);
  }

  // Pattern: issue-123
  const issueMatch = branch.match(/^issue-(\d+)$/);
  if (issueMatch) {
    return parseInt(issueMatch[1], 10);
  }

  // Pattern: 123-description (bare number prefix)
  const bareMatch = branch.match(/^(\d+)-/);
  if (bareMatch) {
    return parseInt(bareMatch[1], 10);
  }

  return null;
}

/**
 * Fetch issue title from GitHub using gh CLI
 *
 * Returns placeholder if gh is not available or fetch fails.
 */
function fetchIssueTitle(issueNumber: number): string {
  try {
    const result = spawnSync(
      "gh",
      ["issue", "view", String(issueNumber), "--json", "title", "-q", ".title"],
      { stdio: "pipe", timeout: 10000 },
    );

    if (result.status === 0 && result.stdout) {
      const title = result.stdout.toString().trim();
      if (title) {
        return title;
      }
    }
  } catch {
    // gh not available or error - use placeholder
  }

  return `(title unavailable for #${issueNumber})`;
}

/**
 * Get detailed worktree information including branch names
 */
interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
}

function getWorktreeDetails(): WorktreeInfo[] {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    stdio: "pipe",
  });

  if (result.status !== 0) {
    return [];
  }

  const output = result.stdout.toString();
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      // Start of new worktree entry
      if (current.path) {
        worktrees.push(current as WorktreeInfo);
      }
      current = { path: line.substring(9) };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.substring(5);
    } else if (line.startsWith("branch refs/heads/")) {
      current.branch = line.substring(18);
    } else if (line === "" && current.path) {
      // End of entry
      worktrees.push(current as WorktreeInfo);
      current = {};
    }
  }

  // Don't forget the last entry
  if (current.path && current.branch) {
    worktrees.push(current as WorktreeInfo);
  }

  return worktrees;
}

/**
 * Infer the current phase for an issue by checking logs
 */
function inferPhaseFromLogs(issueNumber: number): Phase | undefined {
  const logPath = LOG_PATHS.project;

  if (!fs.existsSync(logPath)) {
    return undefined;
  }

  try {
    const files = fs.readdirSync(logPath).filter((f) => f.endsWith(".json"));

    // Sort by timestamp (newest first)
    files.sort().reverse();

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(logPath, file), "utf-8");
        const logData = JSON.parse(content);
        const log = RunLogSchema.safeParse(logData);

        if (!log.success) continue;

        // Find this issue in the log
        const issueLog = log.data.issues.find(
          (i) => i.issueNumber === issueNumber,
        );
        if (issueLog && issueLog.phases.length > 0) {
          // Return the last executed phase
          const lastPhase = issueLog.phases[issueLog.phases.length - 1];
          return lastPhase.phase as Phase;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

/**
 * Discover worktrees that are not yet tracked in state
 *
 * Scans all git worktrees, identifies those with issue-related branch names,
 * and returns information about worktrees not yet in the state file.
 */
export async function discoverUntrackedWorktrees(
  options: DiscoverOptions = {},
): Promise<DiscoverResult> {
  try {
    const worktrees = getWorktreeDetails();
    const discovered: DiscoveredWorktree[] = [];
    const skipped: SkippedWorktree[] = [];
    let alreadyTracked = 0;

    // Get existing state
    const manager = new StateManager({
      statePath: options.statePath,
      verbose: options.verbose,
    });
    const state = await manager.getState();
    const trackedIssues = new Set(
      Object.keys(state.issues).map((n) => parseInt(n, 10)),
    );

    for (const worktree of worktrees) {
      // Skip if no branch (detached HEAD)
      if (!worktree.branch) {
        skipped.push({
          path: worktree.path,
          reason: "detached HEAD (no branch)",
        });
        continue;
      }

      // Skip main/master branches
      if (worktree.branch === "main" || worktree.branch === "master") {
        skipped.push({
          path: worktree.path,
          reason: "main/master branch (not a feature worktree)",
        });
        continue;
      }

      // Try to parse issue number from branch
      const issueNumber = parseIssueNumberFromBranch(worktree.branch);
      if (issueNumber === null) {
        skipped.push({
          path: worktree.path,
          reason: `branch name doesn't match issue pattern: ${worktree.branch}`,
        });
        continue;
      }

      // Check if already tracked
      if (trackedIssues.has(issueNumber)) {
        alreadyTracked++;
        if (options.verbose) {
          console.log(
            `  Already tracked: #${issueNumber} (${worktree.branch})`,
          );
        }
        continue;
      }

      // Fetch title from GitHub
      if (options.verbose) {
        console.log(`  Fetching title for #${issueNumber}...`);
      }
      const title = fetchIssueTitle(issueNumber);

      // Try to infer phase from logs
      const inferredPhase = inferPhaseFromLogs(issueNumber);

      discovered.push({
        issueNumber,
        title,
        worktreePath: worktree.path,
        branch: worktree.branch,
        inferredPhase,
      });

      if (options.verbose) {
        console.log(
          `  Discovered: #${issueNumber} - ${title}${inferredPhase ? ` (phase: ${inferredPhase})` : ""}`,
        );
      }
    }

    return {
      success: true,
      worktreesScanned: worktrees.length,
      alreadyTracked,
      discovered,
      skipped,
    };
  } catch (error) {
    return {
      success: false,
      worktreesScanned: 0,
      alreadyTracked: 0,
      discovered: [],
      skipped: [],
      error: String(error),
    };
  }
}
