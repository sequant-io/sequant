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
 * One phase execution's usage on one model (#986).
 *
 * Rows are emitted in `phaseResults` order and are deliberately NOT keyed by
 * phase name: a quality-loop retry is a second execution of the same phase and
 * must stay a second row. Phase names, model IDs and numbers only — consistent
 * with this schema's no-file-paths/no-content privacy contract.
 */
export const PhaseUsageSchema = z.object({
  /** Phase name, e.g. `"exec"`. Free-form rather than `MetricPhaseSchema` so a
   * phase added to the runtime before this enum cannot fail schema validation
   * at write time. */
  phase: z.string(),
  /** Concrete model ID from the SDK `modelUsage` map, e.g. `"claude-sonnet-5"`. */
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  /** SDK cost estimate in USD. Not `.int()` — see `RunMetricsSchema.costUSD`. */
  costUSD: z.number().nonnegative(),
  /**
   * Model-ladder escalation facts for the phase execution this row belongs to
   * (#971 AC-10). Appended as optional COLUMNS on #986's existing row rather
   * than as a second array: a parallel structure would have to be re-joined to
   * these rows by phase name, and grouping by phase name is exactly what
   * silently merges a quality-loop retry into its first attempt (the reason
   * #986 keeps rows in `phaseResults` order).
   *
   * Absent on every non-escalated execution — which is every execution when no
   * ladder is configured. Optional and additive: records written before #971
   * still load (`stats.test.ts`'s pre-fix-record tests are the standing proof).
   */
  /** 0-based rung index the phase was dispatched at. */
  ladderRung: z.number().int().nonnegative().optional(),
  /** Model the phase would have run on without escalation. */
  baseModel: z.string().optional(),
  /** Model actually dispatched after escalation. */
  escalatedModel: z.string().optional(),
  /** Deterministic no-progress signal that bought the rung. */
  escalationTrigger: z.string().optional(),
  /** Pre-resolution ladder entry (`role:strong`), when a role was used (#975). */
  requestedModel: z.string().optional(),
  /** Set when the phase is on the last rung with nowhere left to go. */
  topOfLadder: z.boolean().optional(),
});

export type PhaseUsage = z.infer<typeof PhaseUsageSchema>;

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
  /**
   * SDK cost estimate in USD for the whole run (#986), summed from the
   * driver's `modelUsage`. Deliberately NOT `.int()` — real costs are
   * fractions of a dollar, and an int constraint would reject every real
   * record at write time. Optional and additive: absent on records written
   * before this field existed, and on runs whose driver reports no cost.
   */
  costUSD: z.number().nonnegative().optional(),
  /**
   * Per-phase-execution × model usage breakdown (#986). Omitted entirely
   * (not an empty array) when no phase reported usage, matching the
   * `phasePolicies`/`effortEscalations` omit-when-empty convention.
   */
  phaseUsage: z.array(PhaseUsageSchema).optional(),
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
  /**
   * Resolved per-phase `model`/`effort` overrides (#914), keyed by phase
   * name. Only phases with a configured override get an entry — a phase
   * that inherited the CLI default is omitted entirely, not recorded with
   * undefined fields. Enum/alias strings only, consistent with this
   * schema's no-file-paths/no-content privacy contract. Optional and
   * additive — absent on records written before this field existed.
   *
   * `requestedModel` and `resolvedModel` are added in #975 to record the
   * role string (pre-resolution) and the concrete model ID from `modelUsage`
   * (post-execution) respectively — enabling cross-time benchmark comparisons
   * as the model roster moves under aliases.
   */
  phasePolicies: z
    .record(
      z.string(),
      z.object({
        model: z.string().optional(),
        effort: z.string().optional(),
        /** The role string or raw model string as configured (pre-resolution, #975). */
        requestedModel: z.string().optional(),
        /** The concrete model ID from `modelUsage` after execution (#975). */
        resolvedModel: z.string().optional(),
      }),
    )
    .optional(),
  /**
   * Effort escalations applied during this run (#915), one entry per
   * escalated phase execution — distinct from `phasePolicies`, which is a
   * flat phase→policy map recorded once per run and can't express a value
   * that changes per retry. Only populated when at least one execution
   * escalated; omitted entirely (not an empty array) otherwise, matching
   * `phasePolicies`'s omit-when-empty convention. Phase names and enum
   * effort strings only, consistent with this schema's privacy contract.
   */
  effortEscalations: z
    .array(
      z.object({
        phase: z.string(),
        base: z.string(),
        escalated: z.string(),
      }),
    )
    .optional(),
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
  /**
   * Resolved per-phase model/effort overrides (#914/#975), keyed by phase name.
   * Pass only the phases that actually had a configured override — a phase
   * that inherited the CLI default should not appear here at all. See
   * `resolvePhasePolicies` in `config-resolver.ts`, which already produces
   * a map shaped this way.
   *
   * `requestedModel` and `resolvedModel` are #975 additions — pass when available
   * to enable cross-time benchmark comparisons as the model roster evolves.
   */
  phasePolicies?: Record<
    string,
    {
      model?: string;
      effort?: string;
      requestedModel?: string;
      resolvedModel?: string;
    }
  >;
  /**
   * Effort escalations applied during this run (#915), one entry per
   * escalated phase execution. Pass only executions that actually escalated
   * — see `MetricRunSchema.effortEscalations`'s doc comment for why this is
   * a sibling array rather than an extension of `phasePolicies`.
   */
  effortEscalations?: Array<{ phase: string; base: string; escalated: string }>;
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
    ...(options.phasePolicies && Object.keys(options.phasePolicies).length > 0
      ? { phasePolicies: options.phasePolicies }
      : {}),
    ...(options.effortEscalations && options.effortEscalations.length > 0
      ? { effortEscalations: options.effortEscalations }
      : {}),
    metrics: {
      tokensUsed: options.metrics?.tokensUsed ?? 0,
      filesChanged: options.metrics?.filesChanged ?? 0,
      linesAdded: options.metrics?.linesAdded ?? 0,
      acceptanceCriteria: options.metrics?.acceptanceCriteria ?? 0,
      qaIterations: options.metrics?.qaIterations ?? 0,
      inputTokens: options.metrics?.inputTokens,
      outputTokens: options.metrics?.outputTokens,
      cacheTokens: options.metrics?.cacheTokens,
      // #986: this block copies fields one at a time, so a field added to
      // `RunMetricsSchema` but not here is silently dropped and lands as
      // `undefined` — the same shape as the zeros bug this issue fixes.
      costUSD: options.metrics?.costUSD,
      ...(options.metrics?.phaseUsage && options.metrics.phaseUsage.length > 0
        ? { phaseUsage: options.metrics.phaseUsage }
        : {}),
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
