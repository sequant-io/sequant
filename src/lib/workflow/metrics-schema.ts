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

/**
 * Outcome of a workflow run
 */
export const RunOutcomeSchema = z.enum(["success", "partial", "failed"]);

export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

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
  /** Estimated tokens used (if available, 0 if not) */
  tokensUsed: z.number().int().nonnegative(),
  /** Number of files changed during the run */
  filesChanged: z.number().int().nonnegative(),
  /** Lines added during the run */
  linesAdded: z.number().int().nonnegative(),
  /** Number of acceptance criteria in the issue */
  acceptanceCriteria: z.number().int().nonnegative(),
  /** Number of QA iterations needed */
  qaIterations: z.number().int().nonnegative(),
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
    metrics: {
      tokensUsed: options.metrics?.tokensUsed ?? 0,
      filesChanged: options.metrics?.filesChanged ?? 0,
      linesAdded: options.metrics?.linesAdded ?? 0,
      acceptanceCriteria: options.metrics?.acceptanceCriteria ?? 0,
      qaIterations: options.metrics?.qaIterations ?? 0,
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
