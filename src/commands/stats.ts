/**
 * sequant stats - Local workflow analytics
 *
 * Provides success/failure rates, workflow insights, and aggregate statistics.
 * All data is local - no telemetry is ever sent remotely.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ui, colors } from "../lib/cli-ui.js";
import {
  RunLogSchema,
  type RunLog,
  type Phase,
  LOG_PATHS,
} from "../lib/workflow/run-log-schema.js";
import {
  MetricsSchema,
  type Metrics,
  type MetricRun,
  METRICS_FILE_PATH,
} from "../lib/workflow/metrics-schema.js";

interface StatsOptions {
  path?: string;
  csv?: boolean;
  json?: boolean;
  detailed?: boolean;
}

/**
 * Detailed analytics computed from run logs
 */
interface DetailedAnalytics {
  qaVerdictDistribution: Record<string, number>;
  firstPassQaRate: number;
  totalQaPhases: number;
  weeklyTrends: {
    week: string;
    runs: number;
    issues: number;
    successRate: number;
  }[];
  labelSegments: {
    label: string;
    issues: number;
    successRate: number;
  }[];
}

/**
 * Aggregate statistics
 */
interface AggregateStats {
  totalRuns: number;
  totalIssues: number;
  passed: number;
  failed: number;
  partial: number;
  successRate: number;
  failureRate: number;
  avgDurationSeconds: number;
  phaseDurations: Map<Phase, { total: number; count: number; avg: number }>;
  commonFailures: Map<string, number>;
}

/**
 * CSV row for export
 */
interface CsvRow {
  runId: string;
  startTime: string;
  duration: number;
  issues: number;
  passed: number;
  failed: number;
  phases: string;
}

/**
 * Resolve the log directory path
 */
function resolveLogPath(customPath?: string): string {
  if (customPath) {
    return customPath.replace("~", os.homedir());
  }

  // Check project-level logs first
  const projectPath = LOG_PATHS.project;
  if (fs.existsSync(projectPath)) {
    return projectPath;
  }

  // Fall back to user-level logs
  const userPath = LOG_PATHS.user.replace("~", os.homedir());
  if (fs.existsSync(userPath)) {
    return userPath;
  }

  return projectPath;
}

/**
 * List all log files in a directory
 */
function listLogFiles(logDir: string): string[] {
  if (!fs.existsSync(logDir)) {
    return [];
  }

  return fs
    .readdirSync(logDir)
    .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
    .sort()
    .reverse();
}

/**
 * Parse a log file
 */
function parseLogFile(filePath: string): RunLog | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(content);
    return RunLogSchema.parse(data);
  } catch {
    return null;
  }
}

/**
 * Calculate aggregate statistics from logs
 */
function calculateStats(logs: RunLog[]): AggregateStats {
  const phaseDurations = new Map<
    Phase,
    { total: number; count: number; avg: number }
  >();
  const commonFailures = new Map<string, number>();

  let totalIssues = 0;
  let passed = 0;
  let failed = 0;
  let partial = 0;
  let totalDuration = 0;

  for (const log of logs) {
    totalIssues += log.issues.length;
    totalDuration += log.summary.totalDurationSeconds;

    for (const issue of log.issues) {
      if (issue.status === "success") {
        passed++;
      } else if (issue.status === "failure") {
        failed++;
      } else {
        partial++;
      }

      // Track phase durations
      for (const phase of issue.phases) {
        const existing = phaseDurations.get(phase.phase) ?? {
          total: 0,
          count: 0,
          avg: 0,
        };
        existing.total += phase.durationSeconds;
        existing.count++;
        phaseDurations.set(phase.phase, existing);

        // Track failure patterns — prefer errorContext category (#447 AC-4)
        if (phase.status === "failure") {
          const errorKey = phase.errorContext?.category
            ? `${phase.phase}: [${phase.errorContext.category}]`
            : phase.error
              ? `${phase.phase}: ${phase.error.slice(0, 100)}`
              : `${phase.phase}: unknown`;
          commonFailures.set(errorKey, (commonFailures.get(errorKey) ?? 0) + 1);
        }
      }
    }
  }

  // Calculate averages for phases
  for (const [phase, data] of phaseDurations) {
    data.avg = data.count > 0 ? data.total / data.count : 0;
    phaseDurations.set(phase, data);
  }

  const successRate = totalIssues > 0 ? (passed / totalIssues) * 100 : 0;
  const failureRate = totalIssues > 0 ? (failed / totalIssues) * 100 : 0;
  const avgDurationSeconds = logs.length > 0 ? totalDuration / logs.length : 0;

  return {
    totalRuns: logs.length,
    totalIssues,
    passed,
    failed,
    partial,
    successRate,
    failureRate,
    avgDurationSeconds,
    phaseDurations,
    commonFailures,
  };
}

/**
 * Format duration in human-readable format
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs.toFixed(0)}s`;
}

/**
 * Generate CSV output
 */
function generateCsv(logs: RunLog[]): string {
  const rows: CsvRow[] = logs.map((log) => ({
    runId: log.runId,
    startTime: log.startTime,
    duration: log.summary.totalDurationSeconds,
    issues: log.summary.totalIssues,
    passed: log.summary.passed,
    failed: log.summary.failed,
    phases: log.config.phases.join(";"),
  }));

  // CSV header
  const header = "runId,startTime,duration,issues,passed,failed,phases";

  // CSV rows - escape fields that might contain special characters
  const csvRows = rows.map((row) =>
    [
      row.runId,
      row.startTime,
      row.duration.toFixed(2),
      row.issues,
      row.passed,
      row.failed,
      `"${row.phases}"`,
    ].join(","),
  );

  return [header, ...csvRows].join("\n");
}

/**
 * Display human-readable statistics with dashboard-style boxes
 */
function displayStats(stats: AggregateStats, logDir: string): void {
  console.log(ui.headerBox("SEQUANT ANALYTICS"));
  console.log(colors.muted(`\n  Log directory: ${logDir}`));
  console.log(colors.muted("  Local data only - no telemetry\n"));

  // Overview table
  const overviewData: Record<string, string | number> = {
    "Total Runs": stats.totalRuns,
    "Issues Processed": stats.totalIssues,
    "Avg Duration": formatDuration(stats.avgDurationSeconds),
  };
  console.log(ui.keyValueTable(overviewData));

  // Success rates with progress bar
  console.log(ui.sectionHeader("Success Rates"));

  const passedBar = ui.progressBar(stats.passed, stats.totalIssues, 12);
  const failedBar = ui.progressBar(stats.failed, stats.totalIssues, 12);

  console.log(
    `  ${colors.success("\u2713 Passed")}     ${stats.passed} (${stats.successRate.toFixed(1)}%)     ${passedBar}`,
  );
  console.log(
    `  ${colors.error("\u2717 Failed")}     ${stats.failed} (${stats.failureRate.toFixed(1)}%)     ${failedBar}`,
  );
  if (stats.partial > 0) {
    const partialRate = (stats.partial / stats.totalIssues) * 100;
    const partialBar = ui.progressBar(stats.partial, stats.totalIssues, 12);
    console.log(
      `  ${colors.warning("\u26A0 Partial")}    ${stats.partial} (${partialRate.toFixed(1)}%)     ${partialBar}`,
    );
  }

  // Phase durations table
  if (stats.phaseDurations.size > 0) {
    console.log(ui.sectionHeader("Phase Durations"));

    // Sort phases by count (most common first)
    const sortedPhases = [...stats.phaseDurations.entries()].sort(
      (a, b) => b[1].count - a[1].count,
    );

    const phaseRows = sortedPhases.map(([phase, data]) => [
      phase,
      formatDuration(data.avg),
      data.count,
    ]);

    console.log(
      ui.table(phaseRows, {
        columns: [
          { header: "Phase", width: 12 },
          { header: "Avg Time", width: 12 },
          { header: "Runs", width: 8 },
        ],
      }),
    );
  }

  // Common failures
  if (stats.commonFailures.size > 0) {
    console.log(ui.sectionHeader("Common Failures"));

    // Sort by frequency
    const sortedFailures = [...stats.commonFailures.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5); // Top 5

    for (const [error, count] of sortedFailures) {
      console.log(`  ${colors.error(`${count}x`)} ${error}`);
    }
  }

  console.log("");
}

/**
 * Local metrics analytics
 */
interface MetricsAnalytics {
  totalRuns: number;
  successCount: number;
  partialCount: number;
  failedCount: number;
  successRate: number;
  avgTokensPerRun: number;
  avgFilesChanged: number;
  avgLinesAdded: number;
  avgDuration: number;
  chainModeSuccessRate: number;
  singleIssueSuccessRate: number;
  insights: string[];
  // Token breakdown (AC-10)
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgCacheTokens: number;
}

/**
 * Load metrics from file
 */
function loadMetrics(): Metrics | null {
  if (!fs.existsSync(METRICS_FILE_PATH)) {
    return null;
  }

  try {
    const content = fs.readFileSync(METRICS_FILE_PATH, "utf-8");
    const data = JSON.parse(content);
    return MetricsSchema.parse(data);
  } catch {
    return null;
  }
}

/**
 * Calculate analytics from metrics
 */
function calculateMetricsAnalytics(metrics: Metrics): MetricsAnalytics {
  const runs = metrics.runs;

  if (runs.length === 0) {
    return {
      totalRuns: 0,
      successCount: 0,
      partialCount: 0,
      failedCount: 0,
      successRate: 0,
      avgTokensPerRun: 0,
      avgFilesChanged: 0,
      avgLinesAdded: 0,
      avgDuration: 0,
      chainModeSuccessRate: 0,
      singleIssueSuccessRate: 0,
      insights: [],
      // Token breakdown
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheTokens: 0,
      avgInputTokens: 0,
      avgOutputTokens: 0,
      avgCacheTokens: 0,
    };
  }

  const successCount = runs.filter((r) => r.outcome === "success").length;
  const partialCount = runs.filter((r) => r.outcome === "partial").length;
  const failedCount = runs.filter((r) => r.outcome === "failed").length;

  const successRate = (successCount / runs.length) * 100;

  const avgTokensPerRun =
    runs.reduce((sum, r) => sum + r.metrics.tokensUsed, 0) / runs.length;
  const avgFilesChanged =
    runs.reduce((sum, r) => sum + r.metrics.filesChanged, 0) / runs.length;
  const avgLinesAdded =
    runs.reduce((sum, r) => sum + r.metrics.linesAdded, 0) / runs.length;
  const avgDuration =
    runs.reduce((sum, r) => sum + r.duration, 0) / runs.length;

  // Chain mode vs single issue analysis
  const chainRuns = runs.filter((r) => r.flags.includes("--chain"));
  const singleIssueRuns = runs.filter((r) => r.issues.length === 1);

  const chainModeSuccessRate =
    chainRuns.length > 0
      ? (chainRuns.filter((r) => r.outcome === "success").length /
          chainRuns.length) *
        100
      : 0;

  const singleIssueSuccessRate =
    singleIssueRuns.length > 0
      ? (singleIssueRuns.filter((r) => r.outcome === "success").length /
          singleIssueRuns.length) *
        100
      : 0;

  // Generate insights
  const insights = generateInsights(
    runs,
    successRate,
    avgFilesChanged,
    avgLinesAdded,
    chainModeSuccessRate,
    singleIssueSuccessRate,
  );

  // Token breakdown (AC-10)
  const totalInputTokens = runs.reduce(
    (sum, r) => sum + (r.metrics.inputTokens ?? 0),
    0,
  );
  const totalOutputTokens = runs.reduce(
    (sum, r) => sum + (r.metrics.outputTokens ?? 0),
    0,
  );
  const totalCacheTokens = runs.reduce(
    (sum, r) => sum + (r.metrics.cacheTokens ?? 0),
    0,
  );

  return {
    totalRuns: runs.length,
    successCount,
    partialCount,
    failedCount,
    successRate,
    avgTokensPerRun,
    avgFilesChanged,
    avgLinesAdded,
    avgDuration,
    chainModeSuccessRate,
    singleIssueSuccessRate,
    insights,
    // Token breakdown
    totalInputTokens,
    totalOutputTokens,
    totalCacheTokens,
    avgInputTokens: runs.length > 0 ? totalInputTokens / runs.length : 0,
    avgOutputTokens: runs.length > 0 ? totalOutputTokens / runs.length : 0,
    avgCacheTokens: runs.length > 0 ? totalCacheTokens / runs.length : 0,
  };
}

/**
 * Generate insights from metrics data
 */
function generateInsights(
  runs: MetricRun[],
  successRate: number,
  avgFilesChanged: number,
  avgLinesAdded: number,
  chainModeSuccessRate: number,
  singleIssueSuccessRate: number,
): string[] {
  const insights: string[] = [];

  // Success rate insight
  if (successRate >= 80) {
    insights.push(`Strong success rate: ${successRate.toFixed(0)}%`);
  } else if (successRate >= 60) {
    insights.push(
      `Moderate success rate: ${successRate.toFixed(0)}% - consider simpler AC`,
    );
  } else if (runs.length >= 5) {
    insights.push(
      `Low success rate: ${successRate.toFixed(0)}% - review issue complexity`,
    );
  }

  // Optimal file change range (based on common patterns)
  if (avgFilesChanged > 0) {
    if (avgFilesChanged <= 5) {
      insights.push(
        `Your sweet spot: ${avgFilesChanged.toFixed(1)} files changed avg`,
      );
    } else if (avgFilesChanged <= 10) {
      insights.push(
        `Avg files changed: ${avgFilesChanged.toFixed(1)} (moderate scope)`,
      );
    } else {
      insights.push(
        `High avg files (${avgFilesChanged.toFixed(1)}) - consider smaller issues`,
      );
    }
  }

  // Lines of code insight
  if (avgLinesAdded > 0) {
    if (avgLinesAdded >= 200 && avgLinesAdded <= 400) {
      insights.push(
        `Optimal LOC range: ~${avgLinesAdded.toFixed(0)} lines avg`,
      );
    } else if (avgLinesAdded > 500) {
      insights.push(
        `Large changes (${avgLinesAdded.toFixed(0)} LOC avg) - consider splitting issues`,
      );
    }
  }

  // Chain mode comparison
  if (chainModeSuccessRate > 0 && singleIssueSuccessRate > 0) {
    const diff = singleIssueSuccessRate - chainModeSuccessRate;
    if (diff > 10) {
      insights.push(
        `Chain mode: ${chainModeSuccessRate.toFixed(0)}% (vs ${singleIssueSuccessRate.toFixed(0)}% single issue)`,
      );
    }
  }

  // Multi-issue runs
  const multiIssueRuns = runs.filter((r) => r.issues.length > 1);
  if (multiIssueRuns.length >= 3) {
    const multiIssueSuccess = multiIssueRuns.filter(
      (r) => r.outcome === "success",
    ).length;
    const multiSuccessRate = (multiIssueSuccess / multiIssueRuns.length) * 100;
    if (multiSuccessRate < singleIssueSuccessRate - 15) {
      insights.push(
        `Multi-issue runs less successful (${multiSuccessRate.toFixed(0)}%)`,
      );
    }
  }

  return insights;
}

/**
 * Display local metrics analytics with dashboard-style boxes
 */
function displayMetricsAnalytics(analytics: MetricsAnalytics): void {
  console.log(ui.headerBox("SEQUANT ANALYTICS"));
  console.log(colors.muted("\n  Local data only - no telemetry\n"));

  // Overview with progress bars
  const total =
    analytics.successCount + analytics.partialCount + analytics.failedCount;
  const successBar = ui.progressBar(analytics.successCount, total, 12);
  const failedBar = ui.progressBar(analytics.failedCount, total, 12);

  console.log(`  Runs: ${analytics.totalRuns} total\n`);
  console.log(
    `  ${colors.success("\u2713 Success")}   ${analytics.successCount} (${analytics.successRate.toFixed(0)}%)    ${successBar}`,
  );
  if (analytics.partialCount > 0) {
    const partialRate = (analytics.partialCount / total) * 100;
    const partialBar = ui.progressBar(analytics.partialCount, total, 12);
    console.log(
      `  ${colors.warning("\u26A0 Partial")}   ${analytics.partialCount} (${partialRate.toFixed(0)}%)    ${partialBar}`,
    );
  }
  if (analytics.failedCount > 0) {
    const failedRate = (analytics.failedCount / total) * 100;
    console.log(
      `  ${colors.error("\u2717 Failed")}    ${analytics.failedCount} (${failedRate.toFixed(0)}%)    ${failedBar}`,
    );
  }

  // Averages table
  console.log(ui.sectionHeader("Averages"));

  const avgData: Record<string, string | number> = {};
  if (analytics.avgTokensPerRun > 0) {
    avgData["Tokens/run"] = analytics.avgTokensPerRun.toLocaleString();
  }
  avgData["Files changed"] = analytics.avgFilesChanged.toFixed(1);
  if (analytics.avgLinesAdded > 0) {
    avgData["Lines added"] = analytics.avgLinesAdded.toFixed(0);
  }
  avgData["Duration"] = formatDuration(analytics.avgDuration);

  console.log(ui.keyValueTable(avgData));

  // Token breakdown (AC-10)
  const hasTokenBreakdown =
    analytics.totalInputTokens > 0 ||
    analytics.totalOutputTokens > 0 ||
    analytics.totalCacheTokens > 0;

  if (hasTokenBreakdown) {
    console.log(ui.sectionHeader("Token Usage"));

    const tokenData: Record<string, string | number> = {};
    if (analytics.totalInputTokens > 0) {
      tokenData["Input tokens"] = analytics.totalInputTokens.toLocaleString();
      tokenData["Avg input/run"] = Math.round(
        analytics.avgInputTokens,
      ).toLocaleString();
    }
    if (analytics.totalOutputTokens > 0) {
      tokenData["Output tokens"] = analytics.totalOutputTokens.toLocaleString();
      tokenData["Avg output/run"] = Math.round(
        analytics.avgOutputTokens,
      ).toLocaleString();
    }
    if (analytics.totalCacheTokens > 0) {
      tokenData["Cache tokens"] = analytics.totalCacheTokens.toLocaleString();
      tokenData["Avg cache/run"] = Math.round(
        analytics.avgCacheTokens,
      ).toLocaleString();
    }

    console.log(ui.keyValueTable(tokenData));
  }

  // Insights
  if (analytics.insights.length > 0) {
    console.log(ui.sectionHeader("Insights"));
    for (const insight of analytics.insights) {
      console.log(`  ${colors.accent("\u2022")} ${insight}`);
    }
  }

  console.log(colors.muted("\n  Data stored locally in .sequant/metrics.json"));
  console.log("");
}

/**
 * Calculate detailed analytics from run logs
 */
function calculateDetailedAnalytics(logs: RunLog[]): DetailedAnalytics {
  const allIssues = logs.flatMap((l) => l.issues);

  // QA verdict distribution
  const qaVerdictDistribution: Record<string, number> = {};
  let totalQaPhases = 0;

  for (const issue of allIssues) {
    for (const phase of issue.phases) {
      if (phase.phase === "qa") {
        totalQaPhases++;
        const verdict = phase.verdict ?? "no_verdict";
        qaVerdictDistribution[verdict] =
          (qaVerdictDistribution[verdict] ?? 0) + 1;
      }
    }
  }

  // First-pass QA rate: group by issue, check if first QA attempt was READY_FOR_MERGE
  const qaByIssue = new Map<
    number,
    { verdict?: string; startTime: string }[]
  >();
  for (const issue of allIssues) {
    const issueQa = issue.phases
      .filter((p) => p.phase === "qa")
      .map((p) => ({ verdict: p.verdict, startTime: p.startTime }));
    if (issueQa.length > 0) {
      const existing = qaByIssue.get(issue.issueNumber) ?? [];
      existing.push(...issueQa);
      qaByIssue.set(issue.issueNumber, existing);
    }
  }

  let firstPassSuccess = 0;
  let totalIssuesWithQa = 0;
  for (const [, phases] of qaByIssue) {
    totalIssuesWithQa++;
    const sorted = phases.sort((a, b) =>
      a.startTime.localeCompare(b.startTime),
    );
    if (sorted[0]?.verdict === "READY_FOR_MERGE") {
      firstPassSuccess++;
    }
  }

  // Weekly trends
  const weekBuckets = new Map<
    string,
    { runs: number; issues: number; successes: number }
  >();
  for (const log of logs) {
    const d = new Date(log.startTime);
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff),
    );
    const week = monday.toISOString().slice(0, 10);

    const existing = weekBuckets.get(week) ?? {
      runs: 0,
      issues: 0,
      successes: 0,
    };
    existing.runs++;
    existing.issues += log.issues.length;
    existing.successes += log.issues.filter(
      (i) => i.status === "success",
    ).length;
    weekBuckets.set(week, existing);
  }

  const weeklyTrends = [...weekBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, data]) => ({
      week,
      runs: data.runs,
      issues: data.issues,
      successRate: data.issues > 0 ? (data.successes / data.issues) * 100 : 0,
    }));

  // Label segmentation
  const labelAcc = new Map<string, { issues: number; successes: number }>();
  for (const issue of allIssues) {
    for (const label of issue.labels) {
      const existing = labelAcc.get(label) ?? { issues: 0, successes: 0 };
      existing.issues++;
      if (issue.status === "success") existing.successes++;
      labelAcc.set(label, existing);
    }
  }

  const labelSegments = [...labelAcc.entries()]
    .map(([label, data]) => ({
      label,
      issues: data.issues,
      successRate: data.issues > 0 ? (data.successes / data.issues) * 100 : 0,
    }))
    .sort((a, b) => b.issues - a.issues)
    .slice(0, 10);

  return {
    qaVerdictDistribution,
    firstPassQaRate:
      totalIssuesWithQa > 0 ? (firstPassSuccess / totalIssuesWithQa) * 100 : 0,
    totalQaPhases,
    weeklyTrends,
    labelSegments,
  };
}

/**
 * Display detailed analytics
 */
function displayDetailedAnalytics(detailed: DetailedAnalytics): void {
  // QA Verdicts
  console.log(ui.sectionHeader("QA Verdicts"));
  console.log(
    `  First-pass QA rate: ${colors.accent(detailed.firstPassQaRate.toFixed(1) + "%")}`,
  );
  console.log(`  Total QA phases:    ${detailed.totalQaPhases}\n`);

  for (const [verdict, count] of Object.entries(
    detailed.qaVerdictDistribution,
  ).sort((a, b) => b[1] - a[1])) {
    const pct =
      detailed.totalQaPhases > 0
        ? ((count / detailed.totalQaPhases) * 100).toFixed(1)
        : "0";
    const bar = ui.progressBar(count, detailed.totalQaPhases, 10);
    console.log(
      `  ${verdict.padEnd(26)} ${String(count).padStart(3)}  (${pct}%)  ${bar}`,
    );
  }

  // Weekly Trends
  if (detailed.weeklyTrends.length > 0) {
    console.log(ui.sectionHeader("Weekly Trends"));

    const rows = detailed.weeklyTrends.map((w) => [
      w.week,
      String(w.runs),
      String(w.issues),
      `${w.successRate.toFixed(0)}%`,
    ]);

    console.log(
      ui.table(rows, {
        columns: [
          { header: "Week", width: 12 },
          { header: "Runs", width: 6 },
          { header: "Issues", width: 8 },
          { header: "Success", width: 9 },
        ],
      }),
    );
  }

  // Label Segmentation
  if (detailed.labelSegments.length > 0) {
    console.log(ui.sectionHeader("Success by Label"));

    for (const seg of detailed.labelSegments) {
      const bar = ui.progressBar(Math.round(seg.successRate), 100, 10);
      const rateStr =
        seg.successRate >= 80
          ? colors.success(`${seg.successRate.toFixed(0)}%`)
          : seg.successRate >= 60
            ? colors.warning(`${seg.successRate.toFixed(0)}%`)
            : colors.error(`${seg.successRate.toFixed(0)}%`);

      console.log(
        `  ${seg.label.padEnd(20)} ${String(seg.issues).padStart(3)} issues  ${rateStr}  ${bar}`,
      );
    }
  }
}

/**
 * Main stats command
 */
export async function statsCommand(options: StatsOptions): Promise<void> {
  // Try to load local metrics first
  const metrics = loadMetrics();

  // If JSON output requested
  if (options.json) {
    if (metrics && metrics.runs.length > 0) {
      const analytics = calculateMetricsAnalytics(metrics);
      const output = {
        source: "metrics",
        totalRuns: analytics.totalRuns,
        successCount: analytics.successCount,
        partialCount: analytics.partialCount,
        failedCount: analytics.failedCount,
        successRate: analytics.successRate,
        avgTokensPerRun: analytics.avgTokensPerRun,
        avgFilesChanged: analytics.avgFilesChanged,
        avgLinesAdded: analytics.avgLinesAdded,
        avgDuration: analytics.avgDuration,
        chainModeSuccessRate: analytics.chainModeSuccessRate,
        singleIssueSuccessRate: analytics.singleIssueSuccessRate,
        insights: analytics.insights,
        // Token breakdown (AC-10)
        tokenBreakdown: {
          totalInputTokens: analytics.totalInputTokens,
          totalOutputTokens: analytics.totalOutputTokens,
          totalCacheTokens: analytics.totalCacheTokens,
          avgInputTokens: analytics.avgInputTokens,
          avgOutputTokens: analytics.avgOutputTokens,
          avgCacheTokens: analytics.avgCacheTokens,
        },
        runs: metrics.runs,
      };
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    // Fall back to run logs for JSON
    const logDir = resolveLogPath(options.path);
    const logFiles = listLogFiles(logDir);

    if (logFiles.length === 0) {
      console.log(JSON.stringify({ error: "No data found", runs: [] }));
      return;
    }

    const logs = logFiles
      .map((filename) => {
        const filePath = path.join(logDir, filename);
        return parseLogFile(filePath);
      })
      .filter((log): log is RunLog => log !== null);

    if (logs.length === 0) {
      console.log(JSON.stringify({ error: "No valid logs found", runs: [] }));
      return;
    }

    const stats = calculateStats(logs);
    const output = {
      source: "logs",
      totalRuns: stats.totalRuns,
      totalIssues: stats.totalIssues,
      passed: stats.passed,
      failed: stats.failed,
      partial: stats.partial,
      successRate: stats.successRate,
      failureRate: stats.failureRate,
      avgDurationSeconds: stats.avgDurationSeconds,
      phaseDurations: Object.fromEntries(stats.phaseDurations),
      commonFailures: Object.fromEntries(stats.commonFailures),
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // CSV output - use run logs
  if (options.csv) {
    const logDir = resolveLogPath(options.path);
    const logFiles = listLogFiles(logDir);

    if (logFiles.length === 0) {
      console.log("runId,startTime,duration,issues,passed,failed,phases");
      return;
    }

    const logs = logFiles
      .map((filename) => {
        const filePath = path.join(logDir, filename);
        return parseLogFile(filePath);
      })
      .filter((log): log is RunLog => log !== null);

    console.log(generateCsv(logs));
    return;
  }

  // Human-readable output - prefer metrics, fall back to logs
  if (metrics && metrics.runs.length > 0) {
    const analytics = calculateMetricsAnalytics(metrics);
    displayMetricsAnalytics(analytics);
  } else {
    // Fall back to run logs display
    const logDir = resolveLogPath(options.path);
    const logFiles = listLogFiles(logDir);

    if (logFiles.length === 0) {
      console.log(ui.headerBox("SEQUANT ANALYTICS"));
      console.log(colors.muted("\n  Local data only - no telemetry\n"));
      console.log(colors.warning("  No data found."));
      console.log(
        colors.muted("  Run `npx sequant run <issues>` to collect metrics."),
      );
      console.log("");
      return;
    }

    const logs = logFiles
      .map((filename) => {
        const filePath = path.join(logDir, filename);
        return parseLogFile(filePath);
      })
      .filter((log): log is RunLog => log !== null);

    if (logs.length === 0) {
      console.log(colors.warning("\n  No valid log files found.\n"));
      return;
    }

    const stats = calculateStats(logs);
    displayStats(stats, logDir);
  }

  // Detailed analytics from run logs (--detailed flag)
  if (options.detailed) {
    const logDir = resolveLogPath(options.path);
    const logFiles = listLogFiles(logDir);
    const logs = logFiles
      .map((filename) => {
        const filePath = path.join(logDir, filename);
        return parseLogFile(filePath);
      })
      .filter((log): log is RunLog => log !== null);

    if (logs.length > 0) {
      const detailed = calculateDetailedAnalytics(logs);
      displayDetailedAnalytics(detailed);
      console.log("");
    }
  }
}
