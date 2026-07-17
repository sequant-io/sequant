/**
 * Zod schemas for local workflow analytics metrics
 *
 * Privacy-focused metrics collection that stays local to the machine.
 * No file paths, code content, issue titles, or PII are ever collected.
 *
 * @example
 * ```typescript
 * import { MetricsSchema, type Metrics, type MetricRun } from './metrics-schema';
 *
 * // Validate metrics file
 * const metrics = MetricsSchema.parse(JSON.parse(metricsContent));
 *
 * // Type-safe access
 * console.log(metrics.runs.length, metrics.runs[0].outcome);
 * ```
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ERROR_CATEGORIES } from "./error-classifier.js";

/**
 * Outcome of a workflow run
 */
export const RunOutcomeSchema = z.enum(["success", "partial", "failed"]);

export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

/**
 * Bounded-enum classification of the failure that ended a run (#761 AC-7).
 *
 * Sourced from `ERROR_CATEGORIES` so the metric can never carry free text —
 * error *messages* stay excluded per the privacy contract above MetricRunSchema
 * (they could contain sensitive info); a closed enum cannot.
 */
export const FailureCategorySchema = z.enum(ERROR_CATEGORIES);

export type FailureCategory = z.infer<typeof FailureCategorySchema>;

/**
 * Available phases (aligned with run-log-schema.ts)
 */
export const MetricPhaseSchema = z.enum([
  "spec",
  "security-review",
  "testgen",
  "exec",
  "test",
  "qa",
  "loop",
]);

export type MetricPhase = z.infer<typeof MetricPhaseSchema>;

/**
 * Aggregate metrics for a run
 * Note: No file paths or code content - only aggregate counts
 */
export const RunMetricsSchema = z.object({
  /** Estimated tokens used (if available, 0 if not) - total of input + output */
  tokensUsed: z.number().int().nonnegative(),
  /** Number of files changed during the run */
  filesChanged: z.number().int().nonnegative(),
  /** Lines added during the run */
  linesAdded: z.number().int().nonnegative(),
  /** Number of acceptance criteria in the issue */
  acceptanceCriteria: z.number().int().nonnegative(),
  /** Number of QA iterations needed */
  qaIterations: z.number().int().nonnegative(),
  /** Input tokens used (AC-4 token breakdown) */
  inputTokens: z.number().int().nonnegative().optional(),
  /** Output tokens used (AC-4 token breakdown) */
  outputTokens: z.number().int().nonnegative().optional(),
  /** Cache tokens (creation + read) (AC-4 token breakdown) */
  cacheTokens: z.number().int().nonnegative().optional(),
});

export type RunMetrics = z.infer<typeof RunMetricsSchema>;

/**
 * Single workflow run record
 *
 * Privacy principles:
 * - Only issue numbers, not titles or content
 * - No file paths or names
 * - No error messages (could contain sensitive info)
 * - Aggregate metrics only
 */
export const MetricRunSchema = z.object({
  /** Unique run identifier */
  id: z.string().uuid(),
  /** Run timestamp */
  date: z.string().datetime(),
  /** Issue numbers processed (not titles or content) */
  issues: z.array(z.number().int().positive()),
  /** Phases that were executed */
  phases: z.array(MetricPhaseSchema),
  /** Overall outcome */
  outcome: RunOutcomeSchema,
  /** Total duration in seconds */
  duration: z.number().nonnegative(),
  /** Model used (e.g., "opus", "sonnet") */
  model: z.string(),
  /** CLI flags used (e.g., ["--chain", "--sequential"]) */
  flags: z.array(z.string()),
  /**
   * Category of the failure that ended the run (#761 AC-7). Optional and
   * enum-only; absent on success and on records written before this field
   * existed (additive — no `version` bump required).
   */
  failureCategory: FailureCategorySchema.optional(),
  /** Aggregate metrics */
  metrics: RunMetricsSchema,
});

export type MetricRun = z.infer<typeof MetricRunSchema>;

/**
 * Complete metrics file schema
 *
 * Stored at .sequant/metrics.json
 */
export const MetricsSchema = z.object({
  /** Schema version for backwards compatibility */
  version: z.literal(1),
  /** Array of run records */
  runs: z.array(MetricRunSchema),
});

export type Metrics = z.infer<typeof MetricsSchema>;

/**
 * Default metrics file path
 */
export const METRICS_FILE_PATH = ".sequant/metrics.json";

/**
 * Create an empty metrics file
 */
export function createEmptyMetrics(): Metrics {
  return {
    version: 1,
    runs: [],
  };
}

/**
 * Create a new metric run record
 */
export function createMetricRun(options: {
  issues: number[];
  phases: MetricPhase[];
  outcome: RunOutcome;
  duration: number;
  model?: string;
  flags?: string[];
  failureCategory?: FailureCategory;
  metrics?: Partial<RunMetrics>;
}): MetricRun {
  return {
    id: randomUUID(),
    date: new Date().toISOString(),
    issues: options.issues,
    phases: options.phases,
    outcome: options.outcome,
    duration: options.duration,
    model: options.model ?? "unknown",
    flags: options.flags ?? [],
    failureCategory: options.failureCategory,
    metrics: {
      tokensUsed: options.metrics?.tokensUsed ?? 0,
      filesChanged: options.metrics?.filesChanged ?? 0,
      linesAdded: options.metrics?.linesAdded ?? 0,
      acceptanceCriteria: options.metrics?.acceptanceCriteria ?? 0,
      qaIterations: options.metrics?.qaIterations ?? 0,
      inputTokens: options.metrics?.inputTokens,
      outputTokens: options.metrics?.outputTokens,
      cacheTokens: options.metrics?.cacheTokens,
    },
  };
}

/**
 * Determine outcome from issue results
 */
export function determineOutcome(
  successCount: number,
  totalCount: number,
): RunOutcome {
  if (successCount === totalCount) {
    return "success";
  }
  if (successCount === 0) {
    return "failed";
  }
  return "partial";
}
