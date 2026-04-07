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
  /** Git commit SHA at run start (AC-2) */
  startCommit?: string;
}

/**
 * Manages writing structured run logs to disk
 */
export class LogWriter {
  private runLog: Omit<RunLog, "endTime"> | null = null;
  /** Active issues being tracked concurrently, keyed by issue number */
  private activeIssues: Map<number, Partial<IssueLog>> = new Map();
  /** @deprecated Single-issue slot for backwards compatibility — use activeIssues */
  private currentIssue: Partial<IssueLog> | null = null;
  private logPath: string;
  private writeToUserLogs: boolean;
  private verbose: boolean;
  private rotation: RotationSettings;
  private startCommit?: string;

  constructor(options: LogWriterOptions = {}) {
    this.logPath = options.logPath ?? LOG_PATHS.project;
    this.writeToUserLogs = options.writeToUserLogs ?? false;
    this.verbose = options.verbose ?? false;
    this.rotation = options.rotation ?? DEFAULT_ROTATION_SETTINGS;
    this.startCommit = options.startCommit;
  }

  /**
   * Initialize a new run log
   *
   * @param config - Run configuration
   */
  async initialize(config: RunConfig): Promise<void> {
    this.runLog = createEmptyRunLog(config, { startCommit: this.startCommit });

    // Ensure log directory exists
    await this.ensureLogDirectory(this.logPath);

    if (this.writeToUserLogs) {
      const userPath = LOG_PATHS.user.replace("~", os.homedir());
      await this.ensureLogDirectory(userPath);
    }

    if (this.verbose && this.runLog) {
      console.log(`Log: Log initialized: ${this.runLog.runId}`);
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

    const issueData: Partial<IssueLog> = {
      issueNumber,
      title,
      labels,
      phases: [],
      status: "success" as IssueStatus,
      totalDurationSeconds: 0,
    };

    this.activeIssues.set(issueNumber, issueData);
    // Keep currentIssue in sync for callers that don't pass issueNumber
    this.currentIssue = issueData;

    if (this.verbose) {
      console.log(`Log: Started logging issue #${issueNumber}`);
    }
  }

  /**
   * Log a completed phase
   *
   * @param phaseLog - Complete phase log entry
   */
  logPhase(phaseLog: PhaseLog): void {
    // Route to the correct issue by issueNumber, falling back to currentIssue
    const issue =
      this.activeIssues.get(phaseLog.issueNumber) ?? this.currentIssue;
    if (!issue) {
      throw new Error(
        `No active issue #${phaseLog.issueNumber}. Call startIssue() first.`,
      );
    }

    issue.phases = [...(issue.phases ?? []), phaseLog];

    // Update issue status based on phase result
    if (phaseLog.status === "failure") {
      issue.status = "failure";
    } else if (phaseLog.status === "timeout" && issue.status !== "failure") {
      issue.status = "partial";
    }

    if (this.verbose) {
      console.log(
        `Log: Logged phase: ${phaseLog.phase} (${phaseLog.status}) - ${phaseLog.durationSeconds.toFixed(1)}s`,
      );
    }
  }

  /**
   * Set PR info on the current issue (call before completeIssue)
   */
  setPRInfo(prNumber: number, prUrl: string, issueNumber?: number): void {
    const issue = issueNumber
      ? (this.activeIssues.get(issueNumber) ?? this.currentIssue)
      : this.currentIssue;
    if (!issue) {
      return;
    }
    issue.prNumber = prNumber;
    issue.prUrl = prUrl;
  }

  /**
   * Complete the current issue and add it to the run log
   */
  completeIssue(issueNumber?: number): void {
    if (!this.runLog) {
      throw new Error("No run log. Call initialize() first.");
    }

    // Resolve the issue to complete
    const issue = issueNumber
      ? this.activeIssues.get(issueNumber)
      : this.currentIssue;
    if (!issue) {
      throw new Error(
        issueNumber
          ? `No active issue #${issueNumber} to complete.`
          : "No current issue to complete.",
      );
    }

    // Calculate total duration from phases
    const totalDurationSeconds =
      issue.phases?.reduce(
        (sum: number, p: PhaseLog) => sum + p.durationSeconds,
        0,
      ) ?? 0;

    const issueLog: IssueLog = {
      issueNumber: issue.issueNumber!,
      title: issue.title!,
      labels: issue.labels!,
      status: issue.status!,
      phases: issue.phases!,
      totalDurationSeconds,
      ...(issue.prNumber != null && {
        prNumber: issue.prNumber,
      }),
      ...(issue.prUrl != null && {
        prUrl: issue.prUrl,
      }),
    };

    this.runLog.issues.push(issueLog);

    // Clean up from activeIssues map
    if (issue.issueNumber != null) {
      this.activeIssues.delete(issue.issueNumber);
    }
    // Clear currentIssue if it was the one completed
    if (this.currentIssue === issue) {
      this.currentIssue = null;
    }

    if (this.verbose) {
      console.log(
        `Log: Completed issue #${issueLog.issueNumber} (${issueLog.status})`,
      );
    }
  }

  /**
   * Finalize the run log and write to disk
   *
   * Automatically rotates old logs if thresholds are exceeded.
   *
   * @param options - Optional finalization options
   * @param options.endCommit - Git commit SHA at run end (AC-2)
   * @returns Path to the written log file
   */
  async finalize(options?: { endCommit?: string }): Promise<string> {
    if (!this.runLog) {
      throw new Error("LogWriter not initialized.");
    }

    // Complete any pending issues (Map-based concurrent tracking)
    for (const issueNum of [...this.activeIssues.keys()]) {
      this.completeIssue(issueNum);
    }
    // Fallback: complete legacy currentIssue if not already handled
    if (this.currentIssue) {
      this.completeIssue();
    }

    const finalLog = finalizeRunLog(this.runLog, {
      endCommit: options?.endCommit,
    });
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
      console.log(`Log: Log written: ${projectPath}`);
    }

    // Auto-rotate if needed
    if (this.rotation.enabled) {
      const result = rotateIfNeeded(this.logPath, this.rotation);
      if (result.rotated && this.verbose) {
        console.log(
          `Log: Rotated ${result.deletedCount} old log(s), reclaimed ${(result.bytesReclaimed / 1024).toFixed(1)} KB`,
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
      | "summary"
      | "commitHash"
      | "fileDiffStats"
      | "cacheMetrics"
      | "errorContext"
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
