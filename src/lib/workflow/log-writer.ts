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
  deriveIssueLogStatus,
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
  /**
   * Run start timestamp (#867). When provided, the log's `startTime` uses this
   * origin instead of self-stamping `new Date()` at initialize(), so the log's
   * stored wall clock and the orchestrator's summary derive from one shared
   * start. Defaults to now when omitted.
   */
  startTime?: Date;
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
  private startTime?: Date;

  constructor(options: LogWriterOptions = {}) {
    this.logPath = options.logPath ?? LOG_PATHS.project;
    this.writeToUserLogs = options.writeToUserLogs ?? false;
    this.verbose = options.verbose ?? false;
    this.rotation = options.rotation ?? DEFAULT_ROTATION_SETTINGS;
    this.startCommit = options.startCommit;
    this.startTime = options.startTime;
  }

  /**
   * Initialize a new run log
   *
   * @param config - Run configuration
   */
  async initialize(config: RunConfig): Promise<void> {
    this.runLog = createEmptyRunLog(config, {
      startCommit: this.startCommit,
      startTime: this.startTime,
    });

    // Ensure log directory exists
    await this.ensureLogDirectory(this.logPath);

    if (this.writeToUserLogs) {
      const userPath = LOG_PATHS.user.replace("~", os.homedir());
      await this.ensureLogDirectory(userPath);
    }

    if (this.verbose && this.runLog) {
      console.log(`Log initialized: ${this.runLog.runId}`);
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

    // #856: seed pessimistically. This slot is only revised by `logPhase`, so
    // an optimistic `"success"` seed became the persisted verdict for any
    // issue whose first phase never completed — the exact shape of a run
    // killed mid-flight. `completeIssue` re-derives from `phases` regardless,
    // but the seed should not itself assert a pass that never happened.
    const issueData: Partial<IssueLog> = {
      issueNumber,
      title,
      labels,
      phases: [],
      status: "failure" as IssueStatus,
      totalDurationSeconds: 0,
    };

    this.activeIssues.set(issueNumber, issueData);
    // Keep currentIssue in sync for callers that don't pass issueNumber
    this.currentIssue = issueData;

    if (this.verbose) {
      console.log(`Log started: issue #${issueNumber}`);
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

    // #766: derive from the latest attempt of each phase (loop excluded) rather
    // than pinning failure/partial forever. A timeout or failure that a later
    // quality-loop iteration recovers from no longer sticks, so the JSON log
    // agrees with the live card and summary table (AC-3/AC-5).
    issue.status = deriveIssueLogStatus(issue.phases);

    if (this.verbose) {
      console.log(
        `Log phase: ${phaseLog.phase} (${phaseLog.status}) - ${phaseLog.durationSeconds.toFixed(1)}s`,
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
   *
   * @param issueNumber - Issue to complete (defaults to the legacy single slot)
   * @param abort - Set when the run is being torn down by an external signal
   *   (#856). Marks the issue aborted with its cause instead of persisting
   *   whatever verdict the incomplete phase list happens to imply.
   */
  completeIssue(
    issueNumber?: number,
    abort?: { signal: string; reason: string },
  ): void {
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

    // #856: derive from the phase list rather than trusting the slot's seed.
    // An issue with no completed phase is a failure — the run was cut short.
    //
    // An abort forces `failure` even when every phase logged so far passed:
    // the issue was still in flight when the signal arrived, so its pipeline
    // never reached a terminal state and a partial prefix of green phases is
    // not a pass. `abortReason` records why, so the log names its own cause
    // instead of leaving a silently truncated record.
    const status = abort ? "failure" : deriveIssueLogStatus(issue.phases ?? []);

    const issueLog: IssueLog = {
      issueNumber: issue.issueNumber!,
      title: issue.title!,
      labels: issue.labels!,
      status,
      phases: issue.phases!,
      totalDurationSeconds,
      ...(abort && {
        aborted: true,
        abortReason: abort.reason,
      }),
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
        `Log complete: issue #${issueLog.issueNumber} (${issueLog.status})`,
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
   * @param options.aborted - Set when finalizing because the run was
   *   terminated by an external signal (#856). Every still-in-flight issue is
   *   recorded as an abort naming its cause, and the run log carries
   *   `abortedBy`. Without it, a killed run's log is indistinguishable from a
   *   clean one that happened to do nothing.
   * @returns Path to the written log file
   */
  async finalize(options?: {
    endCommit?: string;
    aborted?: { signal: string; reason: string };
  }): Promise<string> {
    if (!this.runLog) {
      throw new Error("LogWriter not initialized.");
    }

    const abort = options?.aborted;

    // Complete any pending issues (Map-based concurrent tracking)
    for (const issueNum of [...this.activeIssues.keys()]) {
      this.completeIssue(issueNum, abort);
    }
    // Fallback: complete legacy currentIssue if not already handled
    if (this.currentIssue) {
      this.completeIssue(undefined, abort);
    }

    const finalLog = finalizeRunLog(this.runLog, {
      endCommit: options?.endCommit,
      abortedBy: abort?.signal,
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
      console.log(`Log written: ${projectPath}`);
    }

    // Auto-rotate if needed
    if (this.rotation.enabled) {
      const result = rotateIfNeeded(this.logPath, this.rotation);
      if (result.rotated && this.verbose) {
        console.log(
          `Log rotated: ${result.deletedCount} old log(s), reclaimed ${(result.bytesReclaimed / 1024).toFixed(1)} KB`,
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
      | "capped"
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
