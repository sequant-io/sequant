/**
 * sequant stats - Aggregate analysis of workflow run logs
 *
 * Provides success/failure rates, phase durations, and common failure patterns.
 */

import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  RunLogSchema,
  type RunLog,
  type Phase,
  LOG_PATHS,
} from "../lib/workflow/run-log-schema.js";

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
 * Display human-readable statistics
 */
function displayStats(stats: AggregateStats, logDir: string): void {
  console.log(chalk.blue("\n📊 Sequant Run Statistics\n"));
  console.log(chalk.gray(`  Log directory: ${logDir}`));

  // Overall summary
  console.log(chalk.blue("\n  Overview"));
  console.log(chalk.gray(`  ─────────────────────────────────`));
  console.log(chalk.gray(`  Total runs analyzed: ${stats.totalRuns}`));
  console.log(chalk.gray(`  Total issues processed: ${stats.totalIssues}`));
  console.log(
    chalk.gray(
      `  Average run duration: ${formatDuration(stats.avgDurationSeconds)}`,
    ),
  );

  // Success/failure rates
  console.log(chalk.blue("\n  Success/Failure Rates"));
  console.log(chalk.gray(`  ─────────────────────────────────`));
  console.log(
    chalk.green(`  Passed: ${stats.passed} (${stats.successRate.toFixed(1)}%)`),
  );
  console.log(
    chalk.red(`  Failed: ${stats.failed} (${stats.failureRate.toFixed(1)}%)`),
  );
  if (stats.partial > 0) {
    console.log(chalk.yellow(`  Partial: ${stats.partial}`));
  }

  // Phase durations
  if (stats.phaseDurations.size > 0) {
    console.log(chalk.blue("\n  Average Phase Durations"));
    console.log(chalk.gray(`  ─────────────────────────────────`));

    // Sort phases by count (most common first)
    const sortedPhases = [...stats.phaseDurations.entries()].sort(
      (a, b) => b[1].count - a[1].count,
    );

    for (const [phase, data] of sortedPhases) {
      const avgFormatted = formatDuration(data.avg);
      console.log(
        chalk.gray(
          `  ${phase.padEnd(10)} ${avgFormatted.padStart(8)} avg (${data.count} runs)`,
        ),
      );
    }
  }

  // Common failures
  if (stats.commonFailures.size > 0) {
    console.log(chalk.blue("\n  Common Failure Points"));
    console.log(chalk.gray(`  ─────────────────────────────────`));

    // Sort by frequency
    const sortedFailures = [...stats.commonFailures.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5); // Top 5

    for (const [error, count] of sortedFailures) {
      console.log(chalk.red(`  ${count}x ${error}`));
    }
  }

  console.log("");
}

/**
 * Main stats command
 */
export async function statsCommand(options: StatsOptions): Promise<void> {
  const logDir = resolveLogPath(options.path);

  // List log files
  const logFiles = listLogFiles(logDir);

  if (logFiles.length === 0) {
    if (options.json) {
      console.log(JSON.stringify({ error: "No logs found", runs: [] }));
    } else if (options.csv) {
      console.log("runId,startTime,duration,issues,passed,failed,phases");
    } else {
      console.log(chalk.blue("\n📊 Sequant Run Statistics\n"));
      console.log(chalk.yellow("  No logs found."));
      console.log(
        chalk.gray("  Run `npx sequant run <issues>` to generate logs."),
      );
      console.log("");
    }
    return;
  }

  // Parse all logs
  const logs = logFiles
    .map((filename) => {
      const filePath = path.join(logDir, filename);
      return parseLogFile(filePath);
    })
    .filter((log): log is RunLog => log !== null);

  if (logs.length === 0) {
    if (options.json) {
      console.log(JSON.stringify({ error: "No valid logs found", runs: [] }));
    } else if (options.csv) {
      console.log("runId,startTime,duration,issues,passed,failed,phases");
    } else {
      console.log(chalk.yellow("\n  No valid log files found.\n"));
    }
    return;
  }

  // CSV output
  if (options.csv) {
    console.log(generateCsv(logs));
    return;
  }

  // JSON output
  if (options.json) {
    const stats = calculateStats(logs);
    const output = {
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

  // Human-readable output
  const stats = calculateStats(logs);
  displayStats(stats, logDir);
}
