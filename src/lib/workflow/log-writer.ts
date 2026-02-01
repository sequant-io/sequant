/**
 * Log writer for structured workflow run logs
 *
 * Writes JSON logs to disk for analysis and debugging.
 *
 * @example
 * ```typescript
 * import { LogWriter } from './log-writer';
 *
 * const writer = new LogWriter({ projectPath: '.sequant/logs' });
 * await writer.initialize(config);
 * await writer.logPhase(phaseLog);
 * await writer.finalize();
 * ```
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  type RunLog,
  type RunConfig,
  type IssueLog,
  type PhaseLog,
  type Phase,
  type IssueStatus,
  createEmptyRunLog,
  finalizeRunLog,
  generateLogFilename,
  LOG_PATHS,
} from "./run-log-schema.js";
import {
  rotateIfNeeded,
  type RotationSettings,
  DEFAULT_ROTATION_SETTINGS,
} from "./log-rotation.js";

export interface LogWriterOptions {
  /** Path to log directory (default: .sequant/logs in current directory) */
  logPath?: string;
  /** Whether to also write to user-level logs */
  writeToUserLogs?: boolean;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Log rotation settings */
  rotation?: RotationSettings;
}

/**
 * Manages writing structured run logs to disk
 */
export class LogWriter {
  private runLog: Omit<RunLog, "endTime"> | null = null;
  private currentIssue: Partial<IssueLog> | null = null;
  private logPath: string;
  private writeToUserLogs: boolean;
  private verbose: boolean;
  private rotation: RotationSettings;

  constructor(options: LogWriterOptions = {}) {
    this.logPath = options.logPath ?? LOG_PATHS.project;
    this.writeToUserLogs = options.writeToUserLogs ?? false;
    this.verbose = options.verbose ?? false;
    this.rotation = options.rotation ?? DEFAULT_ROTATION_SETTINGS;
  }

  /**
   * Initialize a new run log
   *
   * @param config - Run configuration
   */
  async initialize(config: RunConfig): Promise<void> {
    this.runLog = createEmptyRunLog(config);

    // Ensure log directory exists
    await this.ensureLogDirectory(this.logPath);

    if (this.writeToUserLogs) {
      const userPath = LOG_PATHS.user.replace("~", os.homedir());
      await this.ensureLogDirectory(userPath);
    }

    if (this.verbose && this.runLog) {
      console.log(`📝 Log initialized: ${this.runLog.runId}`);
    }
  }

  /**
   * Start logging a new issue
   *
   * @param issueNumber - GitHub issue number
   * @param title - Issue title
   * @param labels - Issue labels
   */
  startIssue(issueNumber: number, title: string, labels: string[]): void {
    if (!this.runLog) {
      throw new Error("LogWriter not initialized. Call initialize() first.");
    }

    this.currentIssue = {
      issueNumber,
      title,
      labels,
      phases: [],
      status: "success" as IssueStatus,
      totalDurationSeconds: 0,
    };

    if (this.verbose) {
      console.log(`📝 Started logging issue #${issueNumber}`);
    }
  }

  /**
   * Log a completed phase
   *
   * @param phaseLog - Complete phase log entry
   */
  logPhase(phaseLog: PhaseLog): void {
    if (!this.currentIssue) {
      throw new Error("No current issue. Call startIssue() first.");
    }

    this.currentIssue.phases = [...(this.currentIssue.phases ?? []), phaseLog];

    // Update issue status based on phase result
    if (phaseLog.status === "failure") {
      this.currentIssue.status = "failure";
    } else if (
      phaseLog.status === "timeout" &&
      this.currentIssue.status !== "failure"
    ) {
      this.currentIssue.status = "partial";
    }

    if (this.verbose) {
      console.log(
        `📝 Logged phase: ${phaseLog.phase} (${phaseLog.status}) - ${phaseLog.durationSeconds.toFixed(1)}s`,
      );
    }
  }

  /**
   * Complete the current issue and add it to the run log
   */
  completeIssue(): void {
    if (!this.runLog || !this.currentIssue) {
      throw new Error("No current issue to complete.");
    }

    // Calculate total duration from phases
    const totalDurationSeconds =
      this.currentIssue.phases?.reduce(
        (sum: number, p: PhaseLog) => sum + p.durationSeconds,
        0,
      ) ?? 0;

    const issueLog: IssueLog = {
      issueNumber: this.currentIssue.issueNumber!,
      title: this.currentIssue.title!,
      labels: this.currentIssue.labels!,
      status: this.currentIssue.status!,
      phases: this.currentIssue.phases!,
      totalDurationSeconds,
    };

    this.runLog.issues.push(issueLog);
    this.currentIssue = null;

    if (this.verbose) {
      console.log(
        `📝 Completed issue #${issueLog.issueNumber} (${issueLog.status})`,
      );
    }
  }

  /**
   * Finalize the run log and write to disk
   *
   * Automatically rotates old logs if thresholds are exceeded.
   *
   * @returns Path to the written log file
   */
  async finalize(): Promise<string> {
    if (!this.runLog) {
      throw new Error("LogWriter not initialized.");
    }

    // Complete any pending issue
    if (this.currentIssue) {
      this.completeIssue();
    }

    const finalLog = finalizeRunLog(this.runLog);
    const filename = generateLogFilename(
      finalLog.runId,
      new Date(finalLog.startTime),
    );

    // Write to project logs
    const projectPath = path.join(this.resolvePath(this.logPath), filename);
    await this.writeLogFile(projectPath, finalLog);

    // Optionally write to user logs
    if (this.writeToUserLogs) {
      const userPath = path.join(this.resolvePath(LOG_PATHS.user), filename);
      await this.writeLogFile(userPath, finalLog);
    }

    if (this.verbose) {
      console.log(`📝 Log written: ${projectPath}`);
    }

    // Auto-rotate if needed
    if (this.rotation.enabled) {
      const result = rotateIfNeeded(this.logPath, this.rotation);
      if (result.rotated && this.verbose) {
        console.log(
          `📝 Rotated ${result.deletedCount} old log(s), reclaimed ${(result.bytesReclaimed / 1024).toFixed(1)} KB`,
        );
      }
    }

    return projectPath;
  }

  /**
   * Get the current run log (for inspection)
   */
  getRunLog(): Omit<RunLog, "endTime"> | null {
    return this.runLog;
  }

  /**
   * Get the run ID
   */
  getRunId(): string | null {
    return this.runLog?.runId ?? null;
  }

  private resolvePath(logPath: string): string {
    return logPath.replace("~", os.homedir());
  }

  private async ensureLogDirectory(logPath: string): Promise<void> {
    const resolved = this.resolvePath(logPath);
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    }
  }

  private async writeLogFile(filePath: string, log: RunLog): Promise<void> {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(log, null, 2));
  }
}

/**
 * Create a simple phase log from timing data
 *
 * Utility function for creating phase logs when you have start/end times.
 */
export function createPhaseLogFromTiming(
  phase: Phase,
  issueNumber: number,
  startTime: Date,
  endTime: Date,
  status: PhaseLog["status"],
  options?: Partial<
    Pick<
      PhaseLog,
      | "error"
      | "iterations"
      | "filesModified"
      | "testsRun"
      | "testsPassed"
      | "verdict"
    >
  >,
): PhaseLog {
  const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

  return {
    phase,
    issueNumber,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    durationSeconds,
    status,
    ...options,
  };
}
