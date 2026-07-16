/**
 * Display helpers for `sequant run` — pre-run config block + post-run summary.
 *
 * Kept separate from run.ts so the adapter stays thin (see AC-2 of #503).
 *
 * As of #618, the post-run summary delegates to the unified RunRenderer when
 * one is provided. The renderless path (used by --experimental-tui and tests)
 * falls back to `renderRunSummary` so output stays consistent across modes.
 */

import chalk from "chalk";
import { ui, colors } from "../lib/cli-ui.js";
import { renderRunSummary } from "../lib/cli-ui/run-renderer.js";
import type {
  IssueSummary,
  RunRenderer,
} from "../lib/cli-ui/run-renderer-types.js";
import type {
  ResolvedRun,
  RunResult,
} from "../lib/workflow/run-orchestrator.js";
import { analyzeRun, formatReflection } from "../lib/workflow/run-reflect.js";
import { LOOP_PHASE } from "../lib/workflow/status-derivation.js";
import type { IssueResult } from "../lib/workflow/types.js";

/**
 * Print pre-run config block.
 *
 * Columnar alignment via 15-char label padding. Conditional rows only
 * appear when non-default, matching the pre-#503 format.
 */
export function displayConfig(r: ResolvedRun): void {
  const pad = (label: string) => label.padEnd(15);
  const row = (label: string, value: string) =>
    console.log(chalk.gray(`  ${pad(label)}${value}`));

  row("Stack", r.stack);

  if (r.autoDetectPhases) {
    row("Phases", "auto-detect from labels");
  } else {
    row("Phases", r.config.phases.join(" → "));
  }

  row(
    "Mode",
    r.config.sequential
      ? "sequential (stop-on-failure)"
      : `parallel (concurrency: ${r.config.concurrency})`,
  );

  if (r.config.qualityLoop) {
    row("Quality loop", `enabled (max ${r.config.maxIterations} iterations)`);
  }
  if (r.mergedOptions.testgen) row("Testgen", "enabled");
  if (r.config.noSmartTests) row("Smart tests", "disabled");
  if (r.config.dryRun) {
    console.log(chalk.yellow(`  !  DRY RUN - no actual execution`));
  }
  if (r.logEnabled) row("Logging", "JSON");
  if (r.stateEnabled) row("State", "enabled");
  if (r.mergedOptions.force) {
    console.log(chalk.yellow(`  ${pad("Force")}enabled (bypass state guard)`));
  }
  if (r.issueNumbers.length > 0) {
    row("Issues", r.issueNumbers.map((n) => `#${n}`).join(", "));
  }
  if (r.worktreeIsolationEnabled) {
    console.log(chalk.gray(`  Worktree isolation: enabled`));
  }
  if (r.baseBranch) {
    console.log(chalk.gray(`  Base branch: ${r.baseBranch}`));
  }
  if (r.mergedOptions.chain) {
    console.log(
      chalk.gray(`  Chain mode: enabled (each issue branches from previous)`),
    );
  }
  if (r.mergedOptions.qaGate) {
    console.log(chalk.gray(`  QA gate: enabled (chain waits for QA pass)`));
  }
}

/**
 * Convert workflow `IssueResult` to renderer `IssueSummary`.
 */
function toIssueSummary(r: IssueResult): IssueSummary {
  // #766: the reason to show is the LAST failing attempt, not the first.
  // `phaseResults` accumulates every attempt across every quality-loop
  // iteration, so `.find()` (first-wins) rendered a stale first-iteration
  // reason: #762's cell read `Timeout after 1800s` when its real last failure
  // was an API drop. `verdict`/`unmetCount` below hang off the same entry, so
  // they were stale for the same reason. `loop` is excluded on the same grounds
  // the card and log exclude it (see `status-derivation.ts`) — it is auxiliary
  // recovery, and a trailing loop failure would mask the phase that actually
  // failed. Reverse scan rather than `findLast`: tsconfig pins `lib: ES2022`
  // and `findLast` is ES2023.
  const failedPhase = [...r.phaseResults]
    .reverse()
    .find((p) => !p.success && p.phase !== LOOP_PHASE);
  const summary: IssueSummary = {
    issueNumber: r.issueNumber,
    success: r.success,
    durationSeconds: r.durationSeconds,
    phases: r.phaseResults.map((p) => ({ name: p.phase, success: p.success })),
    loopTriggered: r.loopTriggered,
    prNumber: r.prNumber,
    prUrl: r.prUrl,
  };
  if (!r.success) {
    summary.failureReason =
      failedPhase?.error ??
      r.abortReason ??
      `${failedPhase?.phase ?? "phase"} failed`;
    if (failedPhase?.verdict) {
      summary.qaVerdict = String(failedPhase.verdict);
    }
    if (failedPhase?.summary?.gaps?.length !== undefined) {
      summary.unmetCount = failedPhase.summary.gaps.length;
    }
  }
  return summary;
}

/**
 * Print post-run summary: per-issue grid, log path, reflection, tips.
 *
 * If a renderer is provided (default path), delegate to its `renderSummary`
 * so the live zone is torn down cleanly first. Otherwise, fall back to the
 * shared `renderRunSummary` helper (used by tests and TUI mode).
 */
export function displaySummary(
  result: RunResult,
  renderer?: RunRenderer | null,
): void {
  const { results, logPath, config, mergedOptions } = result;
  if (results.length === 0) return;

  const issueSummaries = results.map(toIssueSummary);
  const totalSeconds = results.reduce(
    (sum, r) => sum + (r.durationSeconds ?? 0),
    0,
  );

  if (renderer) {
    renderer.renderSummary({
      issues: issueSummaries,
      totalDurationSeconds: totalSeconds,
      logPath,
      dryRun: config.dryRun,
    });
  } else {
    renderRunSummary({
      issues: issueSummaries,
      totalDurationSeconds: totalSeconds,
      logPath,
      dryRun: config.dryRun,
    });
  }

  // #760: a chain link whose checkpoint commit failed keeps its own work but
  // loses the recovery point resume depends on, and the per-issue warning has
  // long scrolled past by now on a multi-hour chain. Restate it at the summary,
  // where the user is actually looking, so the next run's fail-fast is expected.
  const checkpointFailures = results.filter((r) => r.checkpointFailed);
  if (checkpointFailures.length > 0) {
    console.log(
      colors.warning(
        `  ⚠️  Checkpoint commit failed for ${checkpointFailures
          .map((r) => `#${r.issueNumber}`)
          .join(", ")} — uncommitted work is missing from the feature branch.`,
      ),
    );
    console.log(
      colors.muted(
        "     Resuming this chain will stop at that link until the work is committed (or use --force).",
      ),
    );
    console.log("");
  }

  if (mergedOptions.reflect && results.length > 0) {
    const reflection = analyzeRun({
      results,
      issueInfoMap: result.issueInfoMap,
      runLog: result.logWriter?.getRunLog() ?? null,
      config: { phases: config.phases, qualityLoop: config.qualityLoop },
    });
    const reflectionOutput = formatReflection(reflection);
    if (reflectionOutput) {
      console.log(reflectionOutput);
      console.log("");
    }
  }
  const passed = results.filter((r) => r.success).length;
  if (results.length > 1 && passed > 0 && !config.dryRun) {
    console.log(
      colors.muted("  Tip: Verify batch integration before merging:"),
    );
    console.log(colors.muted("     sequant merge --check"));
    console.log("");
  }
  if (config.dryRun) {
    console.log(
      colors.warning(
        "  ℹ️  This was a dry run. Use without --dry-run to execute.",
      ),
    );
    console.log("");
  }
  // Reference imported `ui` so existing tests that depend on side-effect-only
  // imports still pass; explicit retention to keep ui in scope for future
  // formatting reuse.
  void ui;
}
