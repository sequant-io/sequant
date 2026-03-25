/**
 * Bulk run log analysis script
 *
 * Loads all run logs and computes:
 * - Baselines (success rate, avg duration, cost per run)
 * - Temporal trends (weekly buckets)
 * - QA verdict distribution and first-pass QA rate
 * - Failure categorization by mode
 * - Per-label segmentation
 *
 * Usage:
 *   npx tsx scripts/analytics/analyze-runs.ts [--json] [--path <log-dir>]
 *
 * @see https://github.com/sequant-io/sequant/issues/437
 */

import * as fs from "fs";
import * as path from "path";
import {
  RunLogSchema,
  type RunLog,
  type PhaseLog,
} from "../../src/lib/workflow/run-log-schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Baselines {
  totalRuns: number;
  totalIssues: number;
  overallSuccessRate: number;
  avgDurationSeconds: number;
  avgPhaseDurations: Record<string, { avg: number; count: number }>;
  chainSuccessRate: number;
  singleIssueSuccessRate: number;
  dateRange: { first: string; last: string };
}

interface WeeklyBucket {
  week: string; // ISO week start (YYYY-MM-DD)
  runs: number;
  issues: number;
  successRate: number;
  avgDuration: number;
  failures: number;
}

interface QaAnalysis {
  totalQaPhases: number;
  verdictDistribution: Record<string, number>;
  firstPassQaRate: number;
  firstPassDetails: {
    issueNumber: number;
    firstVerdict: string;
    totalAttempts: number;
  }[];
}

type FailureCategory =
  | "tooling_failure"
  | "qa_verdict_not_met"
  | "qa_verdict_not_a_plus"
  | "rate_limit"
  | "timeout"
  | "unknown";

interface FailureForensics {
  totalFailedPhases: number;
  categories: Record<FailureCategory, number>;
  byPhase: Record<string, number>;
  details: {
    issueNumber: number;
    phase: string;
    category: FailureCategory;
    error: string;
  }[];
}

interface LabelSegment {
  label: string;
  issues: number;
  successRate: number;
  avgDuration: number;
  avgPhases: number;
}

interface AnalysisReport {
  generatedAt: string;
  baselines: Baselines;
  temporalTrends: WeeklyBucket[];
  qaAnalysis: QaAnalysis;
  failureForensics: FailureForensics;
  segmentation: {
    byLabel: LabelSegment[];
    byIssueCount: {
      single: { runs: number; successRate: number };
      multi: { runs: number; successRate: number };
    };
  };
}

// ---------------------------------------------------------------------------
// Log Loading
// ---------------------------------------------------------------------------

function loadAllLogs(logDir: string): RunLog[] {
  if (!fs.existsSync(logDir)) {
    console.error(`Log directory not found: ${logDir}`);
    return [];
  }

  const files = fs
    .readdirSync(logDir)
    .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
    .sort();

  const logs: RunLog[] = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(logDir, file), "utf-8");
      const data = JSON.parse(content);
      const log = RunLogSchema.parse(data);
      logs.push(log);
    } catch {
      // Skip malformed logs
    }
  }

  return logs;
}

// ---------------------------------------------------------------------------
// Baselines (AC-1, AC-2)
// ---------------------------------------------------------------------------

function computeBaselines(logs: RunLog[]): Baselines {
  const allIssues = logs.flatMap((l) => l.issues);
  const successCount = allIssues.filter((i) => i.status === "success").length;
  const totalDuration = logs.reduce(
    (sum, l) => sum + l.summary.totalDurationSeconds,
    0,
  );

  // Phase durations
  const phaseAcc: Record<string, { total: number; count: number }> = {};
  for (const issue of allIssues) {
    for (const phase of issue.phases) {
      if (!phaseAcc[phase.phase]) {
        phaseAcc[phase.phase] = { total: 0, count: 0 };
      }
      phaseAcc[phase.phase].total += phase.durationSeconds;
      phaseAcc[phase.phase].count++;
    }
  }

  const avgPhaseDurations: Record<string, { avg: number; count: number }> = {};
  for (const [phase, data] of Object.entries(phaseAcc)) {
    avgPhaseDurations[phase] = {
      avg: data.count > 0 ? data.total / data.count : 0,
      count: data.count,
    };
  }

  // Chain vs single
  const chainRuns = logs.filter((l) => l.config.chain === true);
  const singleIssueRuns = logs.filter((l) => l.issues.length === 1);

  const chainSuccess =
    chainRuns.length > 0
      ? (chainRuns.filter(
          (l) =>
            l.issues.length > 0 &&
            l.issues.every((i) => i.status === "success"),
        ).length /
          chainRuns.length) *
        100
      : 0;

  const singleSuccess =
    singleIssueRuns.length > 0
      ? (singleIssueRuns.filter((l) => l.issues[0]?.status === "success")
          .length /
          singleIssueRuns.length) *
        100
      : 0;

  // Date range
  const dates = logs.map((l) => l.startTime).sort();

  return {
    totalRuns: logs.length,
    totalIssues: allIssues.length,
    overallSuccessRate:
      allIssues.length > 0 ? (successCount / allIssues.length) * 100 : 0,
    avgDurationSeconds: logs.length > 0 ? totalDuration / logs.length : 0,
    avgPhaseDurations,
    chainSuccessRate: chainSuccess,
    singleIssueSuccessRate: singleSuccess,
    dateRange: {
      first: dates[0]?.slice(0, 10) ?? "N/A",
      last: dates[dates.length - 1]?.slice(0, 10) ?? "N/A",
    },
  };
}

// ---------------------------------------------------------------------------
// Temporal Trends (AC-3)
// ---------------------------------------------------------------------------

function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1); // Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
  return monday.toISOString().slice(0, 10);
}

function computeTemporalTrends(logs: RunLog[]): WeeklyBucket[] {
  const buckets = new Map<
    string,
    {
      runs: number;
      issues: number;
      successes: number;
      duration: number;
      failures: number;
    }
  >();

  for (const log of logs) {
    const week = getWeekStart(log.startTime);
    const existing = buckets.get(week) ?? {
      runs: 0,
      issues: 0,
      successes: 0,
      duration: 0,
      failures: 0,
    };

    existing.runs++;
    existing.issues += log.issues.length;
    existing.successes += log.issues.filter(
      (i) => i.status === "success",
    ).length;
    existing.failures += log.issues.filter(
      (i) => i.status === "failure",
    ).length;
    existing.duration += log.summary.totalDurationSeconds;

    buckets.set(week, existing);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, data]) => ({
      week,
      runs: data.runs,
      issues: data.issues,
      successRate: data.issues > 0 ? (data.successes / data.issues) * 100 : 0,
      avgDuration: data.runs > 0 ? data.duration / data.runs : 0,
      failures: data.failures,
    }));
}

// ---------------------------------------------------------------------------
// QA Analysis (AC-4)
// ---------------------------------------------------------------------------

function computeQaAnalysis(logs: RunLog[]): QaAnalysis {
  const allIssues = logs.flatMap((l) => l.issues);
  const qaPhases: PhaseLog[] = [];

  for (const issue of allIssues) {
    for (const phase of issue.phases) {
      if (phase.phase === "qa") {
        qaPhases.push(phase);
      }
    }
  }

  // Verdict distribution
  const verdictDist: Record<string, number> = {};
  for (const qa of qaPhases) {
    const verdict = qa.verdict ?? "no_verdict";
    verdictDist[verdict] = (verdictDist[verdict] ?? 0) + 1;
  }

  // First-pass QA rate: group QA phases by issue, check if first attempt was READY_FOR_MERGE
  const qaByIssue = new Map<number, PhaseLog[]>();
  for (const issue of allIssues) {
    const issueQa = issue.phases.filter((p) => p.phase === "qa");
    if (issueQa.length > 0) {
      const existing = qaByIssue.get(issue.issueNumber) ?? [];
      existing.push(...issueQa);
      qaByIssue.set(issue.issueNumber, existing);
    }
  }

  let firstPassSuccess = 0;
  let totalIssuesWithQa = 0;
  const firstPassDetails: QaAnalysis["firstPassDetails"] = [];

  for (const [issueNumber, phases] of qaByIssue) {
    totalIssuesWithQa++;
    // Sort by startTime to get chronological order
    const sorted = phases.sort((a, b) =>
      a.startTime.localeCompare(b.startTime),
    );
    const firstVerdict = sorted[0]?.verdict ?? "no_verdict";

    if (firstVerdict === "READY_FOR_MERGE") {
      firstPassSuccess++;
    }

    firstPassDetails.push({
      issueNumber,
      firstVerdict,
      totalAttempts: sorted.length,
    });
  }

  return {
    totalQaPhases: qaPhases.length,
    verdictDistribution: verdictDist,
    firstPassQaRate:
      totalIssuesWithQa > 0 ? (firstPassSuccess / totalIssuesWithQa) * 100 : 0,
    firstPassDetails,
  };
}

// ---------------------------------------------------------------------------
// Failure Forensics (AC-5)
// ---------------------------------------------------------------------------

function categorizeFailure(phase: PhaseLog): FailureCategory {
  const error = phase.error ?? "";

  if (error.includes("limit") || error.includes("resets")) {
    return "rate_limit";
  }
  if (phase.status === "timeout") {
    return "timeout";
  }
  if (phase.phase === "qa" && error.includes("AC_NOT_MET")) {
    return "qa_verdict_not_met";
  }
  if (phase.phase === "qa" && error.includes("AC_MET_BUT_NOT_A_PLUS")) {
    return "qa_verdict_not_a_plus";
  }
  if (
    error.includes("exited with code") ||
    error.includes("process exited") ||
    error.includes("Claude Code process")
  ) {
    return "tooling_failure";
  }

  return "unknown";
}

function computeFailureForensics(logs: RunLog[]): FailureForensics {
  const allIssues = logs.flatMap((l) => l.issues);
  const failedPhases: { phase: PhaseLog; issueNumber: number }[] = [];

  for (const issue of allIssues) {
    for (const phase of issue.phases) {
      if (phase.status === "failure") {
        failedPhases.push({ phase, issueNumber: issue.issueNumber });
      }
    }
  }

  const categories: Record<FailureCategory, number> = {
    tooling_failure: 0,
    qa_verdict_not_met: 0,
    qa_verdict_not_a_plus: 0,
    rate_limit: 0,
    timeout: 0,
    unknown: 0,
  };

  const byPhase: Record<string, number> = {};
  const details: FailureForensics["details"] = [];

  for (const { phase, issueNumber } of failedPhases) {
    const category = categorizeFailure(phase);
    categories[category]++;
    byPhase[phase.phase] = (byPhase[phase.phase] ?? 0) + 1;

    details.push({
      issueNumber,
      phase: phase.phase,
      category,
      error: (phase.error ?? "no error message").slice(0, 120),
    });
  }

  return {
    totalFailedPhases: failedPhases.length,
    categories,
    byPhase,
    details,
  };
}

// ---------------------------------------------------------------------------
// Segmentation (AC-3)
// ---------------------------------------------------------------------------

function computeSegmentation(logs: RunLog[]): AnalysisReport["segmentation"] {
  const allIssues = logs.flatMap((l) => l.issues);

  // By label
  const labelAcc = new Map<
    string,
    { issues: number; successes: number; duration: number; phases: number }
  >();

  for (const issue of allIssues) {
    for (const label of issue.labels) {
      const existing = labelAcc.get(label) ?? {
        issues: 0,
        successes: 0,
        duration: 0,
        phases: 0,
      };
      existing.issues++;
      if (issue.status === "success") existing.successes++;
      existing.duration += issue.totalDurationSeconds;
      existing.phases += issue.phases.length;
      labelAcc.set(label, existing);
    }
  }

  const byLabel: LabelSegment[] = [...labelAcc.entries()]
    .map(([label, data]) => ({
      label,
      issues: data.issues,
      successRate: data.issues > 0 ? (data.successes / data.issues) * 100 : 0,
      avgDuration: data.issues > 0 ? data.duration / data.issues : 0,
      avgPhases: data.issues > 0 ? data.phases / data.issues : 0,
    }))
    .sort((a, b) => b.issues - a.issues);

  // By issue count
  const singleRuns = logs.filter((l) => l.issues.length === 1);
  const multiRuns = logs.filter((l) => l.issues.length > 1);

  const singleSuccess =
    singleRuns.length > 0
      ? (singleRuns.filter((l) => l.issues[0]?.status === "success").length /
          singleRuns.length) *
        100
      : 0;

  const multiIssues = multiRuns.flatMap((l) => l.issues);
  const multiSuccess =
    multiIssues.length > 0
      ? (multiIssues.filter((i) => i.status === "success").length /
          multiIssues.length) *
        100
      : 0;

  return {
    byLabel,
    byIssueCount: {
      single: { runs: singleRuns.length, successRate: singleSuccess },
      multi: { runs: multiRuns.length, successRate: multiSuccess },
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function runAnalysis(logDir: string): AnalysisReport {
  const logs = loadAllLogs(logDir);

  if (logs.length === 0) {
    console.error("No logs found. Nothing to analyze.");
    process.exit(1);
  }

  return {
    generatedAt: new Date().toISOString(),
    baselines: computeBaselines(logs),
    temporalTrends: computeTemporalTrends(logs),
    qaAnalysis: computeQaAnalysis(logs),
    failureForensics: computeFailureForensics(logs),
    segmentation: computeSegmentation(logs),
  };
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

function displayReport(report: AnalysisReport): void {
  const {
    baselines,
    temporalTrends,
    qaAnalysis,
    failureForensics,
    segmentation,
  } = report;

  console.log("=".repeat(70));
  console.log("  SEQUANT WORKFLOW ANALYSIS");
  console.log(
    `  ${baselines.dateRange.first} → ${baselines.dateRange.last}  |  ${baselines.totalRuns} runs  |  ${baselines.totalIssues} issues`,
  );
  console.log("=".repeat(70));

  // --- Baselines ---
  console.log("\n## Baselines\n");
  console.log(
    `  Success rate:       ${baselines.overallSuccessRate.toFixed(1)}%`,
  );
  console.log(
    `  Avg duration:       ${formatDuration(baselines.avgDurationSeconds)}`,
  );
  console.log(
    `  Single-issue rate:  ${baselines.singleIssueSuccessRate.toFixed(1)}%`,
  );
  console.log(
    `  Chain-mode rate:    ${baselines.chainSuccessRate.toFixed(1)}%`,
  );

  console.log("\n  Phase durations (avg):");
  for (const [phase, data] of Object.entries(baselines.avgPhaseDurations)) {
    console.log(
      `    ${phase.padEnd(12)} ${formatDuration(data.avg).padStart(8)}  (${data.count} runs)`,
    );
  }

  // --- Temporal Trends ---
  console.log("\n## Temporal Trends (weekly)\n");
  console.log("  Week         Runs  Issues  Success%  Avg Duration  Failures");
  console.log("  " + "-".repeat(64));
  for (const bucket of temporalTrends) {
    console.log(
      `  ${bucket.week}   ${String(bucket.runs).padStart(3)}   ${String(bucket.issues).padStart(5)}   ${bucket.successRate.toFixed(0).padStart(6)}%   ${formatDuration(bucket.avgDuration).padStart(11)}   ${String(bucket.failures).padStart(7)}`,
    );
  }

  // --- QA Analysis ---
  console.log("\n## QA Analysis\n");
  console.log(`  Total QA phases:    ${qaAnalysis.totalQaPhases}`);
  console.log(
    `  First-pass QA rate: ${qaAnalysis.firstPassQaRate.toFixed(1)}%`,
  );
  console.log("\n  Verdict distribution:");
  for (const [verdict, count] of Object.entries(
    qaAnalysis.verdictDistribution,
  ).sort((a, b) => b[1] - a[1])) {
    const pct =
      qaAnalysis.totalQaPhases > 0
        ? ((count / qaAnalysis.totalQaPhases) * 100).toFixed(1)
        : "0";
    console.log(
      `    ${verdict.padEnd(26)} ${String(count).padStart(4)}  (${pct}%)`,
    );
  }

  // Issues requiring multiple QA attempts
  const multiAttempt = qaAnalysis.firstPassDetails.filter(
    (d) => d.totalAttempts > 1,
  );
  if (multiAttempt.length > 0) {
    console.log("\n  Issues with multiple QA attempts:");
    for (const detail of multiAttempt.sort(
      (a, b) => b.totalAttempts - a.totalAttempts,
    )) {
      console.log(
        `    #${detail.issueNumber}: ${detail.totalAttempts} attempts (first: ${detail.firstVerdict})`,
      );
    }
  }

  // --- Failure Forensics ---
  console.log("\n## Failure Forensics\n");
  console.log(`  Total failed phases: ${failureForensics.totalFailedPhases}`);
  console.log("\n  By category:");
  for (const [category, count] of Object.entries(
    failureForensics.categories,
  ).sort((a, b) => b[1] - a[1])) {
    if (count > 0) {
      const pct =
        failureForensics.totalFailedPhases > 0
          ? ((count / failureForensics.totalFailedPhases) * 100).toFixed(1)
          : "0";
      console.log(
        `    ${category.padEnd(26)} ${String(count).padStart(4)}  (${pct}%)`,
      );
    }
  }

  console.log("\n  By phase:");
  for (const [phase, count] of Object.entries(failureForensics.byPhase).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`    ${phase.padEnd(12)} ${String(count).padStart(4)}`);
  }

  // --- Segmentation ---
  console.log("\n## Segmentation\n");
  console.log("  By label:");
  console.log("  Label                Issues  Success%  Avg Duration");
  console.log("  " + "-".repeat(56));
  for (const seg of segmentation.byLabel.slice(0, 15)) {
    console.log(
      `  ${seg.label.padEnd(21)} ${String(seg.issues).padStart(5)}   ${seg.successRate.toFixed(0).padStart(6)}%   ${formatDuration(seg.avgDuration).padStart(11)}`,
    );
  }

  console.log("\n  By issue count:");
  console.log(
    `    Single-issue runs: ${segmentation.byIssueCount.single.runs} (${segmentation.byIssueCount.single.successRate.toFixed(0)}% success)`,
  );
  console.log(
    `    Multi-issue runs:  ${segmentation.byIssueCount.multi.runs} (${segmentation.byIssueCount.multi.successRate.toFixed(0)}% success)`,
  );

  console.log("\n" + "=".repeat(70));
}

// --- CLI Entry Point ---

const args = process.argv.slice(2);
const jsonFlag = args.includes("--json");
const pathIdx = args.indexOf("--path");
const logDir =
  pathIdx >= 0 && args[pathIdx + 1] ? args[pathIdx + 1] : ".sequant/logs";

const report = runAnalysis(logDir);

if (jsonFlag) {
  console.log(JSON.stringify(report, null, 2));
} else {
  displayReport(report);
}
