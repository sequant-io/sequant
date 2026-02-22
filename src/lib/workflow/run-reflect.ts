/**
 * Run reflection analysis — analyzes completed run data and suggests improvements.
 *
 * Used by the `--reflect` flag on `sequant run` to provide post-run insights.
 */

import type { IssueResult } from "./types.js";
import type { RunLog } from "./run-log-schema.js";

export interface ReflectionInput {
  results: IssueResult[];
  issueInfoMap: Map<number, { title: string; labels: string[] }>;
  runLog: Omit<RunLog, "endTime"> | null;
  config: { phases: string[]; qualityLoop: boolean };
}

export interface ReflectionOutput {
  observations: string[];
  suggestions: string[];
}

const MAX_OUTPUT_LINES = 10;

/**
 * Analyze a completed run and return observations + suggestions.
 */
export function analyzeRun(input: ReflectionInput): ReflectionOutput {
  const observations: string[] = [];
  const suggestions: string[] = [];

  analyzeTimingPatterns(input, observations, suggestions);
  detectPhaseMismatches(input, observations, suggestions);
  suggestImprovements(input, observations, suggestions);

  return { observations, suggestions };
}

/**
 * Compare phase durations across issues to find timing anomalies.
 */
function analyzeTimingPatterns(
  input: ReflectionInput,
  observations: string[],
  suggestions: string[],
): void {
  const { results } = input;

  // Compare spec phase durations (needs 2+ issues)
  const specTimings = results
    .map((r) => ({
      issue: r.issueNumber,
      duration: r.phaseResults.find((p) => p.phase === "spec")?.durationSeconds,
    }))
    .filter(
      (t): t is { issue: number; duration: number } => t.duration != null,
    );

  if (specTimings.length >= 2) {
    const min = Math.min(...specTimings.map((t) => t.duration));
    const max = Math.max(...specTimings.map((t) => t.duration));

    // If spec times are similar (within 30%) despite different issues, flag it
    if (max > 0 && min / max > 0.7 && max - min < 120) {
      observations.push(
        `Spec times similar across issues (${formatSec(min)}–${formatSec(max)}) despite varying complexity`,
      );
      suggestions.push(
        "Consider `--phases exec,qa` for simple fixes to skip spec",
      );
    }
  }

  // Flag individual phases that took unusually long
  for (const result of results) {
    for (const phase of result.phaseResults) {
      if (
        phase.phase === "qa" &&
        phase.durationSeconds &&
        phase.durationSeconds > 300
      ) {
        observations.push(
          `#${result.issueNumber} QA took ${formatSec(phase.durationSeconds)}`,
        );
        suggestions.push("Long QA may indicate sub-agent spawning issues");
        break;
      }
    }
  }
}

/**
 * Detect mismatches between file changes and executed phases.
 */
function detectPhaseMismatches(
  input: ReflectionInput,
  observations: string[],
  suggestions: string[],
): void {
  const { runLog, results } = input;

  // Check fileDiffStats from runLog for .tsx/.jsx changes without test phase
  if (runLog?.issues) {
    for (const issueLog of runLog.issues) {
      const phases = issueLog.phases.map((p) => p.phase);
      const hasTestPhase = phases.includes("test");

      if (hasTestPhase) continue;

      // Collect all modified files across phases
      const modifiedFiles: string[] = [];
      for (const phase of issueLog.phases) {
        if (phase.fileDiffStats) {
          modifiedFiles.push(...phase.fileDiffStats.map((f) => f.path));
        }
        if (phase.filesModified) {
          modifiedFiles.push(...phase.filesModified);
        }
      }

      const hasTsxFiles = modifiedFiles.some(
        (f) => f.endsWith(".tsx") || f.endsWith(".jsx"),
      );

      if (hasTsxFiles) {
        observations.push(
          `#${issueLog.issueNumber} modified .tsx files but no browser test ran`,
        );
        suggestions.push(
          `Add \`ui\` label to #${issueLog.issueNumber} for browser testing`,
        );
      }
    }
  }

  // Fallback: check labels if no runLog
  if (!runLog) {
    for (const result of results) {
      const info = input.issueInfoMap.get(result.issueNumber);
      const labels = info?.labels ?? [];
      const hasUiLabel = labels.some((l) =>
        ["ui", "frontend", "admin"].includes(l.toLowerCase()),
      );
      const hasTestPhase = result.phaseResults.some((p) => p.phase === "test");
      if (hasUiLabel && !hasTestPhase) {
        observations.push(
          `#${result.issueNumber} has UI label but no test phase ran`,
        );
        suggestions.push("Include test phase for UI-labeled issues");
      }
    }
  }
}

/**
 * Suggest workflow improvements based on run patterns.
 */
function suggestImprovements(
  input: ReflectionInput,
  observations: string[],
  suggestions: string[],
): void {
  const { results, config } = input;

  // Check if all issues ran the same phases
  if (results.length >= 2) {
    const phaseSets = results.map((r) =>
      r.phaseResults.map((p) => p.phase).join(","),
    );
    const allSame = phaseSets.every((s) => s === phaseSets[0]);
    if (allSame) {
      observations.push(
        "All issues ran identical phases despite different requirements",
      );
      suggestions.push(
        "Use `/solve` first to get per-issue phase recommendations",
      );
    }
  }

  // Check if quality loop was triggered
  const loopIssues = results.filter((r) => r.loopTriggered);
  if (loopIssues.length > 0) {
    const issueNums = loopIssues.map((r) => `#${r.issueNumber}`).join(", ");
    observations.push(`Quality loop triggered for ${issueNums}`);
    suggestions.push(
      "Consider adding `complex` label upfront for similar issues",
    );
  }

  // Check for failed issues
  const failedIssues = results.filter((r) => !r.success);
  if (failedIssues.length > 0 && results.length > 1) {
    const failRate = ((failedIssues.length / results.length) * 100).toFixed(0);
    observations.push(
      `${failRate}% failure rate (${failedIssues.length}/${results.length})`,
    );
  }

  // Suggest quality loop if not enabled and failures occurred
  if (!config.qualityLoop && failedIssues.length > 0) {
    suggestions.push("Enable `--quality-loop` to auto-retry failed phases");
  }
}

/**
 * Format reflection output as a box with observations and suggestions.
 * Enforces max 10 content lines.
 */
export function formatReflection(output: ReflectionOutput): string {
  const { observations, suggestions } = output;

  if (observations.length === 0 && suggestions.length === 0) {
    return "";
  }

  const lines: string[] = [];

  // Collect all content lines
  const contentLines: string[] = [];
  for (const obs of observations) {
    contentLines.push(`  \u2022 ${obs}`);
  }
  for (const sug of suggestions) {
    contentLines.push(`  \u2022 ${sug}`);
  }

  // Truncate if needed
  const truncated = contentLines.length > MAX_OUTPUT_LINES;
  const displayLines = truncated
    ? contentLines.slice(0, MAX_OUTPUT_LINES - 1)
    : contentLines;

  // Calculate box width
  const maxLineLen = Math.max(
    ...displayLines.map((l) => l.length),
    truncated ? 30 : 0,
    20,
  );
  const boxWidth = Math.min(Math.max(maxLineLen + 4, 40), 66);

  // Build box
  lines.push(
    `  \u250C\u2500 Run Analysis ${"─".repeat(Math.max(boxWidth - 16, 0))}\u2510`,
  );
  lines.push(`  \u2502${" ".repeat(boxWidth - 2)}\u2502`);

  if (observations.length > 0) {
    lines.push(
      `  \u2502  Observations:${" ".repeat(Math.max(boxWidth - 17, 0))}\u2502`,
    );
    for (const line of displayLines.slice(0, observations.length)) {
      lines.push(`  \u2502${padRight(line, boxWidth - 2)}\u2502`);
    }
    lines.push(`  \u2502${" ".repeat(boxWidth - 2)}\u2502`);
  }

  const sugLines = displayLines.slice(observations.length);
  if (sugLines.length > 0) {
    lines.push(
      `  \u2502  Suggestions:${" ".repeat(Math.max(boxWidth - 16, 0))}\u2502`,
    );
    for (const line of sugLines) {
      lines.push(`  \u2502${padRight(line, boxWidth - 2)}\u2502`);
    }
    lines.push(`  \u2502${" ".repeat(boxWidth - 2)}\u2502`);
  }

  if (truncated) {
    const remaining = contentLines.length - (MAX_OUTPUT_LINES - 1);
    const moreText = `  ... and ${remaining} more`;
    lines.push(`  \u2502${padRight(moreText, boxWidth - 2)}\u2502`);
    lines.push(`  \u2502${" ".repeat(boxWidth - 2)}\u2502`);
  }

  lines.push(`  \u2514${"─".repeat(boxWidth - 2)}\u2518`);

  return lines.join("\n");
}

function padRight(str: string, len: number): string {
  return str.length >= len
    ? str.slice(0, len)
    : str + " ".repeat(len - str.length);
}

function formatSec(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}
