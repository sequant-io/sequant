/**
 * Display helpers for `sequant run` — pre-run config block + post-run summary.
 *
 * Kept separate from run.ts so the adapter stays thin (see AC-2 of #503).
 */

import chalk from "chalk";
import { ui, colors } from "../lib/cli-ui.js";
import { formatDuration } from "../lib/workflow/phase-executor.js";
import type {
  ResolvedRun,
  RunResult,
} from "../lib/workflow/run-orchestrator.js";
import { analyzeRun, formatReflection } from "../lib/workflow/run-reflect.js";

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
    row("Phases", r.config.phases.join(" \u2192 "));
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
 * Print post-run summary: per-issue status, log path, reflection, tips.
 */
export function displaySummary(result: RunResult): void {
  const { results, logPath, config, mergedOptions } = result;
  if (results.length === 0) return;

  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log("\n" + ui.divider());
  console.log(colors.info("  Summary"));
  console.log(ui.divider());
  console.log(
    `\n  ${colors.success(`${passed} passed`)} ${colors.muted("·")} ${colors.error(`${failed} failed`)}`,
  );
  for (const r of results) {
    const status = r.success
      ? ui.statusIcon("success")
      : ui.statusIcon("error");
    const duration = r.durationSeconds
      ? colors.muted(` (${formatDuration(r.durationSeconds)})`)
      : "";
    const phases = r.phaseResults
      .map((p) => (p.success ? colors.success(p.phase) : colors.error(p.phase)))
      .join(" → ");
    const loopInfo = r.loopTriggered ? colors.warning(" [loop]") : "";
    const prInfo = r.prUrl ? colors.muted(` → PR #${r.prNumber}`) : "";
    console.log(
      `  ${status} #${r.issueNumber}: ${phases}${loopInfo}${prInfo}${duration}`,
    );
  }
  console.log("");
  if (logPath) {
    console.log(colors.muted(`  Log: ${logPath}`));
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
}
