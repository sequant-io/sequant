/**
 * sequant merge - Batch-level integration QA for completed runs
 *
 * Runs deterministic checks on feature branches from a `sequant run` batch
 * to catch integration issues before human review.
 *
 * Phases:
 * - --check (Phase 1): Combined branch test, mirroring, overlap detection
 * - --scan  (Phase 1+2): Adds residual pattern detection
 * - --review (Phase 1+2+3): Adds AI briefing (stub)
 * - --all: Runs all phases
 * - --post: Post report to GitHub PRs
 */

import { spawnSync } from "child_process";
import { ui, colors } from "../lib/cli-ui.js";
import {
  runMergeChecks,
  formatReportMarkdown,
  resolveBranches,
  findMostRecentLog,
  resolveLogDir,
} from "../lib/merge-check/index.js";
import type { MergeCommandOptions } from "../lib/merge-check/types.js";
import { LockManager, formatLockedMessage } from "../lib/locks/index.js";
import { waitForChecks, resolveWatchTiming } from "../lib/merge-check/watch.js";
import { GitHubProvider } from "../lib/workflow/platforms/github.js";

/** Exit code for a watch that timed out — distinct from the 0/1/2 verdicts. */
const EXIT_WATCH_TIMEOUT = 3;

/**
 * Determine exit code from batch verdict
 */
export function getExitCode(batchVerdict: string): number {
  switch (batchVerdict) {
    case "READY":
      return 0;
    case "NEEDS_ATTENTION":
      return 1;
    case "BLOCKED":
      return 2;
    default:
      return 1;
  }
}

/**
 * Get the git repository root
 */
function getRepoRoot(): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error("Not in a git repository");
  }
  return result.stdout.trim();
}

/**
 * Resolve the PR numbers to watch for a set of issues.
 *
 * Reuses `resolveBranches` (git remote + worktree scan) for the issue→branch
 * map, then prefers the run-log `prNumber` and falls back to
 * `viewPRByBranchSync`. Issues with no discoverable PR are returned in
 * `unresolved` so the caller can report them rather than silently skipping.
 */
function resolveWatchTargets(
  issueNumbers: number[],
  repoRoot: string,
  gh: GitHubProvider,
): {
  targets: { issue: number; pr: number }[];
  unresolved: number[];
} {
  const runLog = findMostRecentLog(resolveLogDir());
  const branches = resolveBranches(issueNumbers, repoRoot, runLog);

  const targets: { issue: number; pr: number }[] = [];
  const unresolved: number[] = [];
  for (const b of branches) {
    const pr = b.prNumber ?? gh.viewPRByBranchSync(b.branch)?.number ?? null;
    if (pr) {
      targets.push({ issue: b.issueNumber, pr });
    } else {
      unresolved.push(b.issueNumber);
    }
  }
  return { targets, unresolved };
}

/**
 * Watch gate (#818): before the normal merge-check report runs, poll each
 * resolved PR's CI rollup until every check is terminal.
 *
 * Contract: this **never merges**. It only decides *when* the existing report
 * runs. Returns `true` when it has handled the outcome and the caller must stop
 * (a dispatch block → BLOCKED/exit 2, a timeout → distinct message/exit 3, or no
 * PR could be resolved); returns `false` when every PR reached a terminal state
 * and the caller should fall through to `runMergeChecks` unchanged.
 *
 * Multiple PRs share a single wall-clock deadline so `--timeout` bounds the whole
 * gate, not each PR independently.
 */
async function runWatchGate(
  issueNumbers: number[],
  options: MergeCommandOptions,
  repoRoot: string,
): Promise<boolean> {
  const gh = new GitHubProvider();

  // Auto-detect issues from the most recent run log when none were given,
  // mirroring runMergeChecks so `--watch` composes with auto-detection.
  let issues = issueNumbers;
  if (issues.length === 0) {
    const runLog = findMostRecentLog(resolveLogDir());
    if (runLog) {
      issues = runLog.issues.map((i) => i.issueNumber);
    }
  }

  const { targets, unresolved } = resolveWatchTargets(issues, repoRoot, gh);

  if (targets.length === 0) {
    const message =
      "Watch: no open PR found for " +
      (issues.length > 0
        ? `issue(s) ${issues.map((i) => `#${i}`).join(", ")}`
        : "the most recent run") +
      ". Push the branch and open a PR before running `merge --watch`.";
    if (options.json) {
      console.log(
        JSON.stringify({ watch: "blocked", error: message }, null, 2),
      );
    } else {
      console.error(ui.errorBox("Watch Blocked", message));
    }
    process.exitCode = 2;
    return true;
  }

  // Validated, never NaN — the shared deadline below depends on it (a NaN
  // deadline would make every per-PR `remaining` NaN and defeat --timeout).
  const { intervalMs, timeoutMs } = resolveWatchTiming(options);
  const deadline = Date.now() + timeoutMs;

  if (unresolved.length > 0 && !options.json) {
    console.log(
      colors.muted(
        `  !  No PR resolved for: ${unresolved.map((i) => `#${i}`).join(", ")} — skipping in watch.`,
      ),
    );
  }

  for (const { issue, pr } of targets) {
    if (!options.json) {
      console.log(colors.muted(`Watching PR #${pr} (issue #${issue})…`));
    }

    const remaining = deadline - Date.now();
    const result = await waitForChecks(
      pr,
      {
        intervalMs,
        // Share the deadline across PRs so the whole gate honors --timeout.
        timeoutMs: Math.max(0, remaining),
        onPoll: options.json
          ? undefined
          : (msg) => console.log(colors.muted(`  #${pr}: ${msg}`)),
      },
      gh,
    );

    if (result.status === "blocked") {
      const reason = result.reason ?? "CI dispatch is blocked.";
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              watch: "blocked",
              pr,
              issue,
              reason,
              checkName: result.checkName,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(
          ui.errorBox(
            "BLOCKED",
            `PR #${pr} (issue #${issue}) — ${reason}` +
              (result.checkName ? `\n\nCheck: ${result.checkName}` : ""),
          ),
        );
      }
      process.exitCode = 2;
      return true;
    }

    if (result.status === "timeout") {
      const reason = result.reason ?? "Watch timed out.";
      if (options.json) {
        console.log(
          JSON.stringify({ watch: "timeout", pr, issue, reason }, null, 2),
        );
      } else {
        console.error(ui.errorBox("Watch Timed Out", reason));
      }
      process.exitCode = EXIT_WATCH_TIMEOUT;
      return true;
    }

    // terminal → this PR is ready to be checked; continue to the next PR.
    if (!options.json) {
      console.log(
        colors.muted(
          `  #${pr}: all checks terminal after ${result.polls} poll(s).`,
        ),
      );
    }
  }

  return false;
}

/**
 * Main merge command handler
 */
export async function mergeCommand(
  issues: string[],
  options: MergeCommandOptions,
): Promise<void> {
  // Default to --check if no phase flag is specified
  if (!options.check && !options.scan && !options.review && !options.all) {
    options.check = true;
  }

  const repoRoot = getRepoRoot();
  const issueNumbers = issues
    .map((i) => parseInt(i, 10))
    .filter((n) => !isNaN(n));

  // Determine mode label
  let mode = "check";
  if (options.all) mode = "all";
  else if (options.review) mode = "review";
  else if (options.scan) mode = "scan";

  if (!options.json) {
    console.log(ui.headerBox("SEQUANT MERGE"));
    console.log("");
    console.log(
      colors.muted(
        issueNumbers.length > 0
          ? `Checking issues: ${issueNumbers.map((i) => `#${i}`).join(", ")} (mode: ${mode})`
          : `Auto-detecting issues from most recent run (mode: ${mode})`,
      ),
    );

    // #625: read-only lock awareness — warn but proceed.
    const lockManager = new LockManager();
    if (!lockManager.isNoop) {
      for (const issue of issueNumbers) {
        const holder = lockManager.check(issue);
        if (holder) {
          console.log(
            colors.muted(`  !  ${formatLockedMessage(issue, holder)}`),
          );
        }
      }
    }
    console.log("");
  }

  // Watch gate (#818): wait for CI to reach a terminal state before running the
  // report. Returns true when it has already handled the outcome (dispatch
  // block, timeout, or no PR to watch) and set the exit code — stop here.
  if (options.watch) {
    try {
      const handled = await runWatchGate(issueNumbers, options, repoRoot);
      if (handled) return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) {
        console.log(
          JSON.stringify({ watch: "error", error: message }, null, 2),
        );
      } else {
        console.error(ui.errorBox("Watch Failed", message));
      }
      process.exitCode = 2;
      return;
    }
  }

  try {
    const report = await runMergeChecks(issueNumbers, options, repoRoot);

    if (options.json) {
      // JSON output: serialize the report (convert Map to object)
      const jsonReport = {
        ...report,
        issueVerdicts: Object.fromEntries(report.issueVerdicts),
      };
      console.log(JSON.stringify(jsonReport, null, 2));
    } else {
      // Markdown output
      const markdown = formatReportMarkdown(report);
      console.log(markdown);

      // Phase 3 stub
      if (options.review || options.all) {
        console.log("");
        console.log(
          colors.muted(
            "Phase 3 (AI briefing) is not yet implemented. Use --check or --scan for deterministic checks.",
          ),
        );
      }
    }

    // Set exit code based on verdict
    const exitCode = getExitCode(report.batchVerdict);
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (options.json) {
      console.log(JSON.stringify({ error: message }, null, 2));
    } else {
      console.error(ui.errorBox("Merge Check Failed", message));
    }
    process.exitCode = 2;
  }
}
