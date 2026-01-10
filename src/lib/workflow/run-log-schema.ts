/**
 * Zod schemas for structured workflow run logs
 *
 * These schemas define the structure of JSON logs produced by `sequant run`
 * for analysis, debugging, and automation purposes.
 *
 * @example
 * ```typescript
 * import { RunLogSchema, type RunLog } from './run-log-schema';
 *
 * // Validate a log file
 * const log = RunLogSchema.parse(JSON.parse(logContent));
 *
 * // Type-safe access
 * console.log(log.summary.passed, log.summary.failed);
 * ```
 */

import { z } from "zod";

/**
 * Available workflow phases
 */
export const PhaseSchema = z.enum([
  "spec",
  "security-review",
  "testgen",
  "exec",
  "test",
  "qa",
  "loop",
]);

export type Phase = z.infer<typeof PhaseSchema>;

/**
 * Phase execution status
 */
export const PhaseStatusSchema = z.enum([
  "success",
  "failure",
  "timeout",
  "skipped",
]);

export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;

/**
 * Issue execution status
 */
export const IssueStatusSchema = z.enum(["success", "failure", "partial"]);

export type IssueStatus = z.infer<typeof IssueStatusSchema>;

/**
 * Log entry for a single phase execution
 */
export const PhaseLogSchema = z.object({
  /** Phase that was executed */
  phase: PhaseSchema,
  /** GitHub issue number */
  issueNumber: z.number().int().positive(),
  /** When the phase started */
  startTime: z.string().datetime(),
  /** When the phase ended */
  endTime: z.string().datetime(),
  /** Duration in seconds */
  durationSeconds: z.number().nonnegative(),
  /** Execution result */
  status: PhaseStatusSchema,
  /** Error message if failed */
  error: z.string().optional(),
  /** Number of iterations (for loop phase) */
  iterations: z.number().int().nonnegative().optional(),
  /** Files modified during this phase */
  filesModified: z.array(z.string()).optional(),
  /** Number of tests run (for test/qa phases) */
  testsRun: z.number().int().nonnegative().optional(),
  /** Number of tests passed */
  testsPassed: z.number().int().nonnegative().optional(),
});

export type PhaseLog = z.infer<typeof PhaseLogSchema>;

/**
 * Complete execution record for a single issue
 */
export const IssueLogSchema = z.object({
  /** GitHub issue number */
  issueNumber: z.number().int().positive(),
  /** Issue title */
  title: z.string(),
  /** Issue labels */
  labels: z.array(z.string()),
  /** Overall execution result */
  status: IssueStatusSchema,
  /** Log entries for each phase executed */
  phases: z.array(PhaseLogSchema),
  /** Total execution time in seconds */
  totalDurationSeconds: z.number().nonnegative(),
});

export type IssueLog = z.infer<typeof IssueLogSchema>;

/**
 * Run configuration
 */
export const RunConfigSchema = z.object({
  /** Phases that were configured to run */
  phases: z.array(PhaseSchema),
  /** Whether issues were run sequentially */
  sequential: z.boolean(),
  /** Whether quality loop was enabled */
  qualityLoop: z.boolean(),
  /** Maximum iterations for fix loops */
  maxIterations: z.number().int().positive(),
});

export type RunConfig = z.infer<typeof RunConfigSchema>;

/**
 * Summary statistics for a run
 */
export const RunSummarySchema = z.object({
  /** Total number of issues processed */
  totalIssues: z.number().int().nonnegative(),
  /** Number of issues that passed */
  passed: z.number().int().nonnegative(),
  /** Number of issues that failed */
  failed: z.number().int().nonnegative(),
  /** Total execution time in seconds */
  totalDurationSeconds: z.number().nonnegative(),
});

export type RunSummary = z.infer<typeof RunSummarySchema>;

/**
 * Complete run log schema
 *
 * This is the top-level schema for a workflow run log file.
 */
export const RunLogSchema = z.object({
  /** Schema version for backwards compatibility */
  version: z.literal(1),
  /** Unique identifier for this run */
  runId: z.string().uuid(),
  /** When the run started */
  startTime: z.string().datetime(),
  /** When the run ended */
  endTime: z.string().datetime(),
  /** Run configuration */
  config: RunConfigSchema,
  /** Execution logs for each issue */
  issues: z.array(IssueLogSchema),
  /** Summary statistics */
  summary: RunSummarySchema,
});

export type RunLog = z.infer<typeof RunLogSchema>;

/**
 * Default log directory paths
 */
export const LOG_PATHS = {
  /** User-level logs */
  user: "~/.sequant/logs",
  /** Project-level logs */
  project: ".sequant/logs",
} as const;

/**
 * Generate a log filename from run metadata
 *
 * @param runId - Unique run identifier
 * @param startTime - Run start time
 * @returns Filename in format: run-<timestamp>-<runId>.json
 */
export function generateLogFilename(runId: string, startTime: Date): string {
  const timestamp = startTime.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `run-${timestamp}-${runId}.json`;
}

/**
 * Create an empty run log with initial values
 *
 * @param config - Run configuration
 * @returns Initial RunLog structure
 */
export function createEmptyRunLog(config: RunConfig): Omit<RunLog, "endTime"> {
  const runId = crypto.randomUUID();
  const startTime = new Date().toISOString();

  return {
    version: 1,
    runId,
    startTime,
    config,
    issues: [],
    summary: {
      totalIssues: 0,
      passed: 0,
      failed: 0,
      totalDurationSeconds: 0,
    },
  };
}

/**
 * Create a phase log entry
 *
 * @param phase - Phase being executed
 * @param issueNumber - GitHub issue number
 * @returns PhaseLog with start time set
 */
export function createPhaseLog(
  phase: Phase,
  issueNumber: number,
): Omit<PhaseLog, "endTime" | "durationSeconds" | "status"> {
  return {
    phase,
    issueNumber,
    startTime: new Date().toISOString(),
  };
}

/**
 * Complete a phase log entry
 *
 * @param phaseLog - Partial phase log
 * @param status - Final status
 * @param options - Additional fields (error, filesModified, etc.)
 * @returns Complete PhaseLog
 */
export function completePhaseLog(
  phaseLog: Omit<PhaseLog, "endTime" | "durationSeconds" | "status">,
  status: PhaseStatus,
  options?: Partial<
    Pick<
      PhaseLog,
      "error" | "iterations" | "filesModified" | "testsRun" | "testsPassed"
    >
  >,
): PhaseLog {
  const endTime = new Date();
  const startTime = new Date(phaseLog.startTime);
  const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

  return {
    ...phaseLog,
    endTime: endTime.toISOString(),
    durationSeconds,
    status,
    ...options,
  };
}

/**
 * Finalize a run log with summary statistics
 *
 * @param runLog - Partial run log
 * @returns Complete RunLog with endTime and summary
 */
export function finalizeRunLog(runLog: Omit<RunLog, "endTime">): RunLog {
  const endTime = new Date();
  const startTime = new Date(runLog.startTime);
  const totalDurationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

  const passed = runLog.issues.filter(
    (i: IssueLog) => i.status === "success",
  ).length;
  const failed = runLog.issues.filter(
    (i: IssueLog) => i.status === "failure",
  ).length;

  return {
    ...runLog,
    endTime: endTime.toISOString(),
    summary: {
      totalIssues: runLog.issues.length,
      passed,
      failed,
      totalDurationSeconds,
    },
  };
}
