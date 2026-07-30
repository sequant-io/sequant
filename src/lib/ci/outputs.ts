/**
 * Output formatting for GitHub Actions.
 *
 * Formats IssueResult into structured outputs that can be consumed
 * by downstream workflow steps via $GITHUB_OUTPUT.
 */

import type { IssueResult, PhaseResult } from "../workflow/types.js";
import type { ActionOutputs } from "./types.js";

/**
 * Format an IssueResult into GitHub Actions outputs.
 */
export function formatOutputs(result: IssueResult): ActionOutputs {
  return {
    issue: String(result.issueNumber),
    success: String(result.success),
    phases: JSON.stringify(formatPhaseResults(result.phaseResults)),
    "pr-url": result.prUrl ?? "",
    duration: String(result.durationSeconds ?? 0),
  };
}

/**
 * Format multiple issue results into combined outputs.
 *
 * @param wallClockDurationSeconds - The run's wall-clock duration, computed by
 * whoever brackets the run (the orchestrator surfaces it as
 * `RunResult.wallClockDurationSeconds`). It is a required argument rather than
 * something derived here because the per-issue durations this function receives
 * cannot express it: under `--parallel` they overlap, so summing them
 * double-counts and over-reports by roughly the concurrency factor (#867).
 */
export function formatMultiOutputs(
  results: IssueResult[],
  wallClockDurationSeconds: number,
): ActionOutputs {
  const allSuccess = results.every((r) => r.success);
  const totalDuration = wallClockDurationSeconds;
  const prUrls = results
    .map((r) => r.prUrl)
    .filter(Boolean)
    .join(",");
  const allPhases = results.flatMap((r) => formatPhaseResults(r.phaseResults));

  return {
    issue: results.map((r) => r.issueNumber).join(" "),
    success: String(allSuccess),
    phases: JSON.stringify(allPhases),
    "pr-url": prUrls,
    duration: String(totalDuration),
  };
}

/**
 * Format phase results for JSON output.
 */
function formatPhaseResults(
  phases: PhaseResult[],
): Array<{ phase: string; success: boolean; duration: number }> {
  return phases.map((p) => ({
    phase: p.phase,
    success: p.success,
    duration: p.durationSeconds ?? 0,
  }));
}

/**
 * Generate shell commands to set GitHub Actions outputs.
 * Each output is written to $GITHUB_OUTPUT file.
 */
export function outputCommands(outputs: ActionOutputs): string[] {
  return Object.entries(outputs).map(
    ([key, value]) => `echo "${key}=${value}" >> "$GITHUB_OUTPUT"`,
  );
}

/**
 * Generate a GitHub Actions step summary (Markdown).
 *
 * @param wallClockDurationSeconds - The run's wall-clock duration. Required for
 * the same reason as in {@link formatMultiOutputs}: the per-issue durations
 * below overlap under `--parallel`, so the "Total duration" line cannot be
 * derived by summing them (#867). Per-*phase* durations in the tables are
 * unaffected — phases within an issue run sequentially.
 */
export function formatSummary(
  results: IssueResult[],
  wallClockDurationSeconds: number,
): string {
  const lines: string[] = [];
  lines.push("## Sequant Workflow Results\n");

  for (const result of results) {
    const icon = result.success ? "✅" : "❌";
    lines.push(`### ${icon} Issue #${result.issueNumber}\n`);

    lines.push("| Phase | Status | Duration |");
    lines.push("|-------|--------|----------|");

    for (const phase of result.phaseResults) {
      const status = phase.success ? "✅ Passed" : "❌ Failed";
      const duration = phase.durationSeconds
        ? `${phase.durationSeconds}s`
        : "-";
      lines.push(`| ${phase.phase} | ${status} | ${duration} |`);
    }

    if (result.prUrl) {
      lines.push(`\n**PR:** ${result.prUrl}`);
    }

    if (result.abortReason) {
      lines.push(`\n**Abort reason:** ${result.abortReason}`);
    }

    lines.push("");
  }

  lines.push(`**Total duration:** ${wallClockDurationSeconds}s`);

  return lines.join("\n");
}
