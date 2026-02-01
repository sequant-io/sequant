/**
 * sequant logs - View and analyze workflow run logs
 *
 * Provides access to structured JSON logs produced by `sequant run --log-json`.
 */

import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ui, colors } from "../lib/cli-ui.js";
import {
  RunLogSchema,
  type RunLog,
  LOG_PATHS,
} from "../lib/workflow/run-log-schema.js";
import {
  manualRotate,
  getLogStats,
  formatBytes,
} from "../lib/workflow/log-rotation.js";
import { getSettings } from "../lib/settings.js";

interface LogsOptions {
  path?: string;
  last?: number;
  json?: boolean;
  issue?: number;
  failed?: boolean;
  rotate?: boolean;
  dryRun?: boolean;
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

  // Default to project path (even if it doesn't exist yet)
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
    .reverse(); // Most recent first
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
 * Format a timestamp for display
 */
function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString();
}

/**
 * Display a single log summary
 */
function displayLogSummary(log: RunLog, filename: string): void {
  const passed = log.summary.passed;
  const failed = log.summary.failed;
  const total = log.summary.totalIssues;
  const status =
    failed > 0
      ? chalk.red("FAILED")
      : passed === total
        ? chalk.green("PASSED")
        : chalk.yellow("PARTIAL");

  console.log(chalk.blue(`\n  Run: ${log.runId.slice(0, 8)}...`));
  console.log(chalk.gray(`  File: ${filename}`));
  console.log(chalk.gray(`  Time: ${formatTime(log.startTime)}`));
  console.log(
    chalk.gray(
      `  Duration: ${formatDuration(log.summary.totalDurationSeconds)}`,
    ),
  );
  console.log(
    chalk.gray(
      `  Status: ${status} (${passed}/${total} passed, ${failed} failed)`,
    ),
  );
  console.log(chalk.gray(`  Phases: ${log.config.phases.join(" → ")}`));

  // Show issues
  for (const issue of log.issues) {
    const issueStatus =
      issue.status === "success"
        ? chalk.green("✓")
        : issue.status === "failure"
          ? chalk.red("✗")
          : chalk.yellow("~");
    const duration = chalk.gray(
      `(${formatDuration(issue.totalDurationSeconds)})`,
    );
    console.log(
      `    ${issueStatus} #${issue.issueNumber}: ${issue.title} ${duration}`,
    );

    // Show phases for this issue
    for (const phase of issue.phases) {
      const phaseStatus =
        phase.status === "success"
          ? chalk.green("✓")
          : phase.status === "failure"
            ? chalk.red("✗")
            : chalk.yellow("~");
      const phaseDuration = chalk.gray(
        `(${formatDuration(phase.durationSeconds)})`,
      );
      const error = phase.error ? chalk.red(` - ${phase.error}`) : "";
      console.log(
        `      ${phaseStatus} ${phase.phase} ${phaseDuration}${error}`,
      );
    }
  }
}

/**
 * Filter logs based on options
 */
function filterLogs(
  logs: { log: RunLog; filename: string }[],
  options: LogsOptions,
): { log: RunLog; filename: string }[] {
  let filtered = logs;

  // Filter by issue number
  if (options.issue !== undefined) {
    filtered = filtered.filter(({ log }) =>
      log.issues.some(
        (i: { issueNumber: number }) => i.issueNumber === options.issue,
      ),
    );
  }

  // Filter by failed status
  if (options.failed) {
    filtered = filtered.filter(({ log }) => log.summary.failed > 0);
  }

  // Limit results
  if (options.last !== undefined) {
    filtered = filtered.slice(0, options.last);
  }

  return filtered;
}

/**
 * Handle log rotation command
 */
async function handleRotation(logDir: string, dryRun: boolean): Promise<void> {
  const settings = await getSettings();
  const stats = getLogStats(logDir, settings.run.rotation);

  console.log(chalk.blue("\n📝 Log Rotation\n"));
  console.log(chalk.gray(`  Log directory: ${logDir}`));
  console.log(
    chalk.gray(
      `  Current: ${stats.fileCount} files, ${formatBytes(stats.totalSizeBytes)}`,
    ),
  );
  console.log(
    chalk.gray(
      `  Thresholds: ${settings.run.rotation.maxFiles} files, ${settings.run.rotation.maxSizeMB} MB`,
    ),
  );

  if (!stats.exceedsSizeThreshold && !stats.exceedsCountThreshold) {
    console.log(chalk.green("\n  ✓ No rotation needed - under thresholds\n"));
    return;
  }

  const result = manualRotate(logDir, {
    dryRun,
    settings: settings.run.rotation,
  });

  if (result.deletedCount === 0) {
    console.log(chalk.green("\n  ✓ No files to rotate\n"));
    return;
  }

  if (dryRun) {
    console.log(
      chalk.yellow(
        `\n  [DRY RUN] Would delete ${result.deletedCount} file(s):`,
      ),
    );
  } else {
    console.log(chalk.green(`\n  ✓ Deleted ${result.deletedCount} file(s):`));
  }

  for (const filename of result.deletedFiles) {
    console.log(chalk.gray(`    - ${filename}`));
  }

  console.log(
    chalk.gray(
      `\n  Space ${dryRun ? "to be " : ""}reclaimed: ${formatBytes(result.bytesReclaimed)}`,
    ),
  );
  console.log("");
}

/**
 * Main logs command
 */
export async function logsCommand(options: LogsOptions): Promise<void> {
  const logDir = resolveLogPath(options.path);

  // Handle rotation mode
  if (options.rotate) {
    await handleRotation(logDir, options.dryRun ?? false);
    return;
  }

  console.log(ui.headerBox("SEQUANT RUN LOGS"));
  console.log(colors.muted(`\n  Log directory: ${logDir}`));

  // List log files
  const logFiles = listLogFiles(logDir);

  if (logFiles.length === 0) {
    console.log(chalk.yellow("\n  No logs found."));
    console.log(
      chalk.gray("  Run `npx sequant run <issues>` to generate logs."),
    );
    console.log("");
    return;
  }

  console.log(chalk.gray(`  Found ${logFiles.length} log file(s)\n`));

  // Parse all logs
  const logs = logFiles
    .map((filename) => {
      const filePath = path.join(logDir, filename);
      const log = parseLogFile(filePath);
      return log ? { log, filename } : null;
    })
    .filter((item): item is { log: RunLog; filename: string } => item !== null);

  // Apply filters
  const filteredLogs = filterLogs(logs, options);

  if (filteredLogs.length === 0) {
    console.log(chalk.yellow("  No logs match the specified filters."));
    console.log("");
    return;
  }

  // Output
  if (options.json) {
    // JSON output
    const output = filteredLogs.map(({ log }) => log);
    console.log(JSON.stringify(output, null, 2));
  } else {
    // Human-readable output
    for (const { log, filename } of filteredLogs) {
      displayLogSummary(log, filename);
    }

    // Summary
    console.log("\n" + ui.divider());

    const totalPassed = filteredLogs.reduce(
      (sum, { log }) => sum + log.summary.passed,
      0,
    );
    const totalFailed = filteredLogs.reduce(
      (sum, { log }) => sum + log.summary.failed,
      0,
    );
    const totalDuration = filteredLogs.reduce(
      (sum, { log }) => sum + log.summary.totalDurationSeconds,
      0,
    );

    console.log(
      chalk.gray(`
  Showing ${filteredLogs.length} of ${logs.length} runs
  Total: ${totalPassed + totalFailed} issues (${totalPassed} passed, ${totalFailed} failed)
  Combined duration: ${formatDuration(totalDuration)}
`),
    );
  }
}
