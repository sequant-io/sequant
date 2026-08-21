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

import { randomUUID } from "node:crypto";
import { z } from "zod";

// Import canonical Phase types from types.ts (single source of truth)
import { PhaseSchema, type Phase } from "./types.js";
export { PhaseSchema };
export type { Phase } from "./types.js";

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
 * Valid QA verdicts schema
 */
export const QaVerdictSchema = z.enum([
  "READY_FOR_MERGE",
  "AC_MET_BUT_NOT_A_PLUS",
  "AC_NOT_MET",
  "NEEDS_VERIFICATION",
]);

export type QaVerdict = z.infer<typeof QaVerdictSchema>;

/**
 * Source that produced the resolved spec→run phase recommendation (#921).
 *
 * Ordered by resolution priority: a durable structured marker in the spec's
 * GitHub comment beats the same comment's prose section, which beats the
 * spec agent's ephemeral chat text, which beats label-based guessing.
 */
export const SpecRecommendationSourceSchema = z.enum([
  "marker",
  "comment-prose",
  "chat",
  "label-fallback",
]);

export type SpecRecommendationSource = z.infer<
  typeof SpecRecommendationSourceSchema
>;

/**
 * Resolved spec→run phase recommendation, recorded on the issue log so
 * fallback frequency is auditable (#921 AC-4). Additive/optional — absent on
 * runs that never reached spec resolution (e.g. spec failed) or predate this
 * field, keeping the persisted-log schema stable at `version: 1`.
 */
export const SpecRecommendationSchema = z.object({
  /** Which step in the resolution chain produced this result */
  source: SpecRecommendationSourceSchema,
  /** Resolved phases, spec excluded (spec already ran) */
  phases: z.array(PhaseSchema),
  /** Whether the quality loop should be enabled */
  qualityLoop: z.boolean(),
});

export type SpecRecommendation = z.infer<typeof SpecRecommendationSchema>;

/**
 * File diff statistics for a single file (AC-3)
 */
export const FileDiffStatSchema = z.object({
  /** File path relative to repository root */
  path: z.string(),
  /** Number of lines added */
  additions: z.number().int().nonnegative(),
  /** Number of lines deleted */
  deletions: z.number().int().nonnegative(),
  /** Change status */
  status: z.enum(["added", "modified", "deleted", "renamed"]),
});

export type FileDiffStat = z.infer<typeof FileDiffStatSchema>;

/**
 * Cache metrics for QA phase (AC-7)
 */
export const CacheMetricsSchema = z.object({
  /** Number of cache hits */
  hits: z.number().int().nonnegative(),
  /** Number of cache misses */
  misses: z.number().int().nonnegative(),
  /** Number of skipped checks */
  skipped: z.number().int().nonnegative(),
});

export type CacheMetrics = z.infer<typeof CacheMetricsSchema>;

/**
 * Structured error context captured from phase failures (#447).
 *
 * Provides stderr/stdout tails and a categorized error type
 * for better failure diagnostics and analytics.
 */
export const ErrorContextSchema = z.object({
  /** Last N lines of stderr before process exit */
  stderrTail: z.array(z.string()),
  /** Last N lines of stdout before process exit */
  stdoutTail: z.array(z.string()),
  /** Process exit code */
  exitCode: z.number().int().optional(),
  /**
   * Classified error category (legacy, kept for backwards compatibility).
   * Keep in sync with `ERROR_CATEGORIES` in `error-classifier.ts` —
   * `rate_limit` / `billing` added by #761 AC-6, `pr_creation` by #920.
   */
  category: z.enum([
    "context_overflow",
    "api_error",
    "hook_failure",
    "build_error",
    "timeout",
    "rate_limit",
    "billing",
    "pr_creation",
    "unknown",
  ]),
  /** Typed error class name (AC-8), e.g. "ApiError", "BuildError" */
  errorType: z.string().optional(),
  /** Structured error metadata (AC-8) */
  errorMetadata: z.record(z.string(), z.unknown()).optional(),
  /** Whether this error type is retryable (AC-9) */
  isRetryable: z.boolean().optional(),
});

export type ErrorContext = z.infer<typeof ErrorContextSchema>;

/**
 * Finite taxonomy for a single gap finding surfaced by `/qa` (#937).
 *
 * Replaces the lossy prose-scrape gap channel (`parseListSection` against
 * `**Issues:**`/`**Gaps**` headers, which misses AC-table NOT_MET rows, §6d
 * Adversarial Re-Read findings, and §5 Risk Assessment). `evidence` is
 * required so a finding can't be speculative — see #608's 0%-action-rate
 * result for open-ended "what might we be missing" findings.
 */
export const GapCategorySchema = z.enum([
  "requirement_gap",
  "dependency_gap",
  "test_gap",
  "repository_gap",
  "risk_gap",
  "execution_gap",
]);

export type GapCategory = z.infer<typeof GapCategorySchema>;

export const GapActionSchema = z.enum([
  "fix_now",
  "document",
  "pause_for_human",
]);

export type GapAction = z.infer<typeof GapActionSchema>;

export const GapFindingSchema = z.object({
  category: GapCategorySchema,
  /** Concrete observation grounding the finding — never speculation. */
  evidence: z.string().min(1),
  description: z.string().min(1),
  recommendedAction: GapActionSchema,
  /** ACs this finding relates to, e.g. ["AC-3"]. */
  affectedAcs: z.array(z.string()).optional(),
  /** True when the finding overlaps one of the issue's Non-Goals. */
  nonGoal: z.boolean().optional(),
});

export type GapFinding = z.infer<typeof GapFindingSchema>;

/**
 * Condensed QA verdict summary for structured log output (#434).
 *
 * Provides AC coverage counts, gaps, and suggestions so that
 * `sequant_logs` consumers can review QA results without
 * fetching issue comments separately.
 */
export const QaSummarySchema = z.object({
  /** Number of acceptance criteria marked MET */
  acMet: z.number().int().nonnegative(),
  /** Total number of acceptance criteria evaluated */
  acTotal: z.number().int().nonnegative(),
  /** List of gaps identified during QA */
  gaps: z.array(z.string()),
  /** List of improvement suggestions from QA */
  suggestions: z.array(z.string()),
  /**
   * Structured gap findings parsed from the `SEQUANT_QA_GAPS` marker (#937).
   * Present only when the marker was found and validated; `gaps` above
   * always carries the union of marker + prose descriptions (dedupe'd) so
   * marker-unaware consumers never regress.
   */
  findings: z.array(GapFindingSchema).optional(),
});

export type QaSummary = z.infer<typeof QaSummarySchema>;

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
  /**
   * Set when the phase hit its turn cap (`error_max_turns`) (#739). Distinguishes
   * an incomplete-but-not-hard-failed phase (partial output preserved) from a
   * genuine failure. Reuses the `"failure"` status — additive boolean rather than
   * a new `PhaseStatus` enum value, to keep the persisted-log schema stable.
   */
  capped: z.boolean().optional(),
  /** Number of iterations (for loop phase) */
  iterations: z.number().int().nonnegative().optional(),
  /** Files modified during this phase */
  filesModified: z.array(z.string()).optional(),
  /** Number of tests run (for test/qa phases) */
  testsRun: z.number().int().nonnegative().optional(),
  /** Number of tests passed */
  testsPassed: z.number().int().nonnegative().optional(),
  /** Parsed QA verdict (only for qa phase) */
  verdict: QaVerdictSchema.optional(),
  /** Condensed QA summary with AC coverage (#434) */
  summary: QaSummarySchema.optional(),
  /** Git commit SHA after phase completes (AC-2) */
  commitHash: z.string().optional(),
  /** Per-file diff statistics (AC-3) */
  fileDiffStats: z.array(FileDiffStatSchema).optional(),
  /** Cache metrics for QA phase (AC-7) */
  cacheMetrics: CacheMetricsSchema.optional(),
  /** Structured error context for failed phases (#447) */
  errorContext: ErrorContextSchema.optional(),
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
  /**
   * Set when this issue never finished because the run was terminated from
   * outside (#856). Reuses the `"failure"` status — additive boolean rather
   * than a new `IssueStatus` enum value, matching the `capped` precedent
   * above, so the persisted-log schema stays stable at `version: 1`.
   *
   * Without this, a run killed mid-flight persisted as `success`: `startIssue`
   * seeds `status: "success"` and only `logPhase` ever revises it, so an issue
   * whose first phase never completed was written out as a pass with an empty
   * `phases[]`.
   */
  aborted: z.boolean().optional(),
  /** Human-readable cause of the abort (e.g. `terminated by SIGTERM`). */
  abortReason: z.string().optional(),
  /** PR number if created after successful QA */
  prNumber: z.number().int().positive().optional(),
  /** PR URL if created after successful QA */
  prUrl: z.string().optional(),
  /** How the spec→run phase recommendation was resolved (#921 AC-4) */
  specRecommendation: SpecRecommendationSchema.optional(),
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
  /** Whether chain mode was enabled (each issue branches from previous) */
  chain: z.boolean().optional(),
  /** Whether QA gate was enabled (chain pauses if QA fails) */
  qaGate: z.boolean().optional(),
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
  /**
   * Number of issues that ended `partial` — timed out with no genuine failure
   * and no recovery (#766). Given its own bucket so an all-partial run no longer
   * vanishes from both `passed` and `failed` (the `0 passed · 0 failed` bug).
   * `.default(0)` keeps logs written before this field parseable.
   */
  partial: z.number().int().nonnegative().default(0),
  /**
   * Number of issues cut short by an external signal (#856). A sub-count of
   * `failed`, not a fourth disjoint bucket — aborted issues carry
   * `status: "failure"` so existing consumers keep working, and this field
   * says whether the failure was the run's own or something killing it.
   * `.default(0)` keeps logs written before this field parseable.
   */
  aborted: z.number().int().nonnegative().default(0),
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
  /** Git commit SHA at run start (AC-2) */
  startCommit: z.string().optional(),
  /** Git commit SHA at run end (AC-2) */
  endCommit: z.string().optional(),
  /**
   * Signal that terminated the run, when it ended by external signal rather
   * than by finishing (#856). Present iff at least one issue is `aborted`.
   */
  abortedBy: z.string().optional(),
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
 * @param options - Optional fields including startCommit
 * @returns Initial RunLog structure
 */
export function createEmptyRunLog(
  config: RunConfig,
  options?: { startCommit?: string; startTime?: Date },
): Omit<RunLog, "endTime"> {
  const runId = randomUUID();
  // #867: use the caller-supplied run origin when provided so the log's wall
  // clock shares the orchestrator's start; fall back to now for standalone use.
  const startTime = (options?.startTime ?? new Date()).toISOString();

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
      partial: 0,
      aborted: 0,
      totalDurationSeconds: 0,
    },
    startCommit: options?.startCommit,
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
 * @param options - Additional fields (error, filesModified, verdict, etc.)
 * @returns Complete PhaseLog
 */
export function completePhaseLog(
  phaseLog: Omit<PhaseLog, "endTime" | "durationSeconds" | "status">,
  status: PhaseStatus,
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
 * @param options - Optional fields including endCommit
 * @returns Complete RunLog with endTime and summary
 */
export function finalizeRunLog(
  runLog: Omit<RunLog, "endTime">,
  options?: { endCommit?: string; abortedBy?: string },
): RunLog {
  const endTime = new Date();
  const startTime = new Date(runLog.startTime);
  const totalDurationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

  const passed = runLog.issues.filter(
    (i: IssueLog) => i.status === "success",
  ).length;
  const failed = runLog.issues.filter(
    (i: IssueLog) => i.status === "failure",
  ).length;
  // #766: `partial` gets its own bucket so an all-partial run isn't counted as
  // `0 passed · 0 failed` — it landed in neither before.
  const partial = runLog.issues.filter(
    (i: IssueLog) => i.status === "partial",
  ).length;
  // #856: aborted issues are also counted in `failed` (they carry
  // `status: "failure"`); this is the sub-count that says *why* they failed,
  // so a run killed from outside is distinguishable from one whose phases
  // genuinely failed.
  const aborted = runLog.issues.filter((i: IssueLog) => i.aborted).length;

  return {
    ...runLog,
    endTime: endTime.toISOString(),
    summary: {
      totalIssues: runLog.issues.length,
      passed,
      failed,
      partial,
      aborted,
      totalDurationSeconds,
    },
    endCommit: options?.endCommit ?? runLog.endCommit,
    ...((options?.abortedBy ?? runLog.abortedBy) && {
      abortedBy: options?.abortedBy ?? runLog.abortedBy,
    }),
  };
}

/**
 * Derive an issue's overall log status from its phase log entries (#766).
 *
 * Phases are appended in execution order, so the last entry for a given phase
 * name is its latest attempt — that attempt wins. This lets a `timeout`/
 * `failure` that a later quality-loop iteration recovers from de-escalate to
 * `success`, keeping the JSON log consistent with the live card and summary
 * table (AC-3/AC-5). `loop` is auxiliary recovery and never determines the
 * verdict (mirrors the live-card rule); an unrecovered failure still leaves a
 * non-loop phase failed. Priority among latest attempts: failure > timeout >
 * success.
 *
 * An issue with no phase entries is a `failure`, not a `success` (#856). The
 * only way to reach that state is for `startIssue` to have run while no phase
 * ever completed — i.e. the run was cut short. Returning `success` there is
 * what let a SIGTERM'd run persist as a pass with an empty `phases[]`.
 */
export function deriveIssueLogStatus(phases: PhaseLog[]): IssueStatus {
  const latest = new Map<string, PhaseStatus>();
  for (const p of phases) {
    if (p.phase === "loop") continue;
    latest.set(p.phase, p.status);
  }
  const statuses = [...latest.values()];
  if (statuses.length === 0) return "failure";
  if (statuses.some((s) => s === "failure")) return "failure";
  if (statuses.some((s) => s === "timeout")) return "partial";
  return "success";
}
