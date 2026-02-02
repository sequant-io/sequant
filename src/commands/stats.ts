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

        // Track failure patterns
        if (phase.status === "failure" && phase.error) {
          // Normalize error message (truncate and clean)
          const errorKey = `${phase.phase}: ${phase.error.slice(0, 100)}`;
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
    return;
  }

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
