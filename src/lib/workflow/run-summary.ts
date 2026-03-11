/**
 * Run Summary Module
 *
 * Handles post-execution reporting for sequant run:
 * - Metrics recording (local analytics)
 * - Summary display with pass/fail counts
 *
 * @module run-summary
 */

import chalk from "chalk";
import { MetricsWriter } from "./metrics-writer.js";
import { type MetricPhase, determineOutcome } from "./metrics-schema.js";
import { ui, colors } from "../cli-ui.js";
import { getTokenUsageForRun } from "./token-utils.js";
import { getWorktreeDiffStats } from "./worktree-manager.js";
import { formatDuration } from "./phase-executor.js";
import type { ExecutionConfig, IssueResult } from "./types.js";
import type { WorktreeInfo } from "./worktree-manager.js";
import type { RunOptions } from "./batch-executor.js";

/**
 * Record run metrics to local analytics file
 *
 * @param params - Metrics recording parameters
 */
export async function recordRunMetrics(params: {
  results: IssueResult[];
  issueNumbers: number[];
  config: ExecutionConfig;
  worktreeMap: Map<number, WorktreeInfo>;
  mergedOptions: RunOptions;
}): Promise<void> {
  const { results, issueNumbers, config, worktreeMap, mergedOptions } = params;

  const metricsWriter = new MetricsWriter({ verbose: config.verbose });

  // Calculate total duration
  const totalDuration = results.reduce(
    (sum, r) => sum + (r.durationSeconds ?? 0),
    0,
  );

  // Get unique phases from all results
  const allPhases = new Set<MetricPhase>();
  for (const result of results) {
    for (const phaseResult of result.phaseResults) {
      const phase = phaseResult.phase as MetricPhase;
      if (
        [
          "spec",
          "security-review",
          "testgen",
          "exec",
          "test",
          "qa",
          "loop",
        ].includes(phase)
      ) {
        allPhases.add(phase);
      }
    }
  }

  // Calculate aggregate metrics from worktrees
  let totalFilesChanged = 0;
  let totalLinesAdded = 0;
  let totalQaIterations = 0;

  for (const result of results) {
    const worktreeInfo = worktreeMap.get(result.issueNumber);
    if (worktreeInfo?.path) {
      const stats = getWorktreeDiffStats(worktreeInfo.path);
      totalFilesChanged += stats.filesChanged;
      totalLinesAdded += stats.linesAdded;
    }
    if (result.loopTriggered) {
      totalQaIterations += result.phaseResults.filter(
        (p) => p.phase === "loop",
      ).length;
    }
  }

  // Build CLI flags for metrics
  const cliFlags: string[] = [];
  if (mergedOptions.sequential) cliFlags.push("--sequential");
  if (mergedOptions.chain) cliFlags.push("--chain");
  if (mergedOptions.qaGate) cliFlags.push("--qa-gate");
  if (mergedOptions.qualityLoop) cliFlags.push("--quality-loop");
  if (mergedOptions.testgen) cliFlags.push("--testgen");

  // Read token usage from SessionEnd hook files
  const tokenUsage = getTokenUsageForRun(undefined, true);
  const passed = results.filter((r) => r.success).length;

  await metricsWriter.recordRun({
    issues: issueNumbers,
    phases: Array.from(allPhases),
    outcome: determineOutcome(passed, results.length),
    duration: totalDuration,
    model: process.env.ANTHROPIC_MODEL ?? "opus",
    flags: cliFlags,
    metrics: {
      tokensUsed: tokenUsage.tokensUsed,
      filesChanged: totalFilesChanged,
      linesAdded: totalLinesAdded,
      acceptanceCriteria: 0,
      qaIterations: totalQaIterations,
      inputTokens: tokenUsage.inputTokens || undefined,
      outputTokens: tokenUsage.outputTokens || undefined,
      cacheTokens: tokenUsage.cacheTokens || undefined,
    },
  });

  if (config.verbose) {
    console.log(chalk.gray(`  📊 Metrics recorded to .sequant/metrics.json`));
  }
}

/**
 * Print the run summary to console
 *
 * @param params - Summary display parameters
 * @returns exit code (0 for success, 1 if any failed)
 */
export function printRunSummary(params: {
  results: IssueResult[];
  logPath: string | null;
  config: ExecutionConfig;
  mergedOptions: RunOptions;
}): number {
  const { results, logPath, config, mergedOptions } = params;

  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log("\n" + ui.divider());
  console.log(colors.info("  Summary"));
  console.log(ui.divider());

  console.log(
    colors.muted(
      `\n  Results: ${colors.success(`${passed} passed`)}, ${colors.error(`${failed} failed`)}`,
    ),
  );

  for (const result of results) {
    const status = result.success
      ? ui.statusIcon("success")
      : ui.statusIcon("error");
    const duration = result.durationSeconds
      ? colors.muted(` (${formatDuration(result.durationSeconds)})`)
      : "";
    const phases = result.phaseResults
      .map((p) => (p.success ? colors.success(p.phase) : colors.error(p.phase)))
      .join(" → ");
    const loopInfo = result.loopTriggered ? colors.warning(" [loop]") : "";
    const prInfo = result.prUrl
      ? colors.muted(` → PR #${result.prNumber}`)
      : "";
    console.log(
      `  ${status} #${result.issueNumber}: ${phases}${loopInfo}${prInfo}${duration}`,
    );
  }

  console.log("");

  if (logPath) {
    console.log(colors.muted(`  📝 Log: ${logPath}`));
    console.log("");
  }

  if (results.length > 1 && passed > 0 && !config.dryRun) {
    console.log(colors.muted("  💡 Verify batch integration before merging:"));
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

  return failed > 0 && !config.dryRun ? 1 : 0;
}
