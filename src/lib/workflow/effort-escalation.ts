/**
 * Evidence-based effort escalation on quality-loop retries (#915).
 *
 * Sequant already detects several "this attempt is a retry" moments: the
 * outer quality-loop re-entering a phase (`batch-executor.ts`) and the
 * `sequant ready` QA-pass loop re-running `qa`/`loop` (`ready-gate.ts`).
 * Escalation raises the phase's reasoning effort one tier for exactly that
 * retried execution when the workflow observed a prior attempt fail — never
 * speculatively, and never more than one tier per retry (see AC-6).
 *
 * Deliberately its own module rather than living beside `resolvePhasePolicies`
 * in `config-resolver.ts`: `config-resolver.ts` imports `getEnvConfig` from
 * `batch-executor.ts`, and `batch-executor.ts` is one of this module's
 * dispatch-time callers, so co-locating here avoids introducing that cycle.
 */

import { EFFORT_LEVELS } from "../settings.js";
import type { ExecutionConfig, Phase } from "./types.js";

/**
 * Base effort assumed for a phase with no configured `effort` override, when
 * escalation needs a starting point to step up from (AC-5). `phase-executor.ts`
 * omits the `effort` key entirely in that case (#914) so the Agent SDK's own
 * default applies — #914 deliberately never encoded what that default is, since
 * "omitted" is not the same claim as "equals X". Escalation can't inherit that
 * silence: it needs one tier *above* something. This constant is that
 * something, named so the assumption is visible and a one-line fix if the
 * SDK's actual default turns out to differ.
 */
export const DEFAULT_ESCALATION_BASE: (typeof EFFORT_LEVELS)[number] = "high";

/**
 * Pure ladder step: one tier above `base` on `EFFORT_LEVELS`, capped at the
 * top (`max`). Returns `base` unchanged whenever `enabled` is false or this
 * isn't a retry — the disabled/first-attempt path must be indistinguishable
 * from #914 with escalation never having existed (AC-2).
 *
 * Always escalates from the phase's CONFIGURED base, never from a previously
 * escalated value — callers must not accumulate escalation across iterations
 * (AC-6): base `high` on the 3rd loop iteration is `xhigh`, not `max`.
 */
export function resolveEscalatedEffort(
  base: string | undefined,
  isRetry: boolean,
  enabled: boolean,
): string | undefined {
  if (!enabled || !isRetry) return base;

  const effectiveBase = (base ??
    DEFAULT_ESCALATION_BASE) as (typeof EFFORT_LEVELS)[number];
  const baseIdx = EFFORT_LEVELS.indexOf(effectiveBase);
  const resolvedIdx =
    baseIdx === -1 ? EFFORT_LEVELS.indexOf(DEFAULT_ESCALATION_BASE) : baseIdx;
  const nextIdx = Math.min(resolvedIdx + 1, EFFORT_LEVELS.length - 1);
  return EFFORT_LEVELS[nextIdx];
}

/** One escalated execution, for observability (run metrics + verbose output). */
export interface EscalationRecord {
  phase: Phase;
  base: string;
  escalated: string;
}

export interface EscalationOutcome {
  /**
   * The config to dispatch with. Identical by reference to the input `config`
   * whenever nothing escalated — so a shared `ExecutionConfig` object is never
   * mutated and an escalation never leaks into a phase execution it wasn't
   * computed for (AC-7).
   */
  config: ExecutionConfig;
  /** Present only when this dispatch actually escalated. */
  record?: EscalationRecord;
}

/**
 * Apply escalation to ONE phase's execution, for THIS dispatch only.
 *
 * This is deliberately a per-execution decision made at the dispatch site,
 * not a value baked into `ExecutionConfig` at build time: `buildExecutionConfig`
 * / `buildPhaseConfig` run once per run/gate, not once per phase execution, so
 * a static escalated value would leak across every phase in the chain and
 * violate AC-7. The three retry-dispatch sites (batch-executor.ts's quality
 * loop, ready-gate.ts's QA-pass loop `qa`/`loop` dispatch) call this function
 * — and only this function — so they cannot drift on the cap/one-tier rules
 * in AC-6 (see resolveEscalatedEffort's doc comment).
 */
export function withEscalatedEffort(
  config: ExecutionConfig,
  phase: Phase,
  isRetry: boolean,
): EscalationOutcome {
  if (!config.effortEscalation || !isRetry) return { config };

  const currentPolicy = config.phasePolicies?.[phase];
  const base = currentPolicy?.effort;
  const escalated = resolveEscalatedEffort(base, isRetry, true);

  if (!escalated || escalated === base) return { config };

  return {
    config: {
      ...config,
      phasePolicies: {
        ...config.phasePolicies,
        [phase]: { ...currentPolicy, effort: escalated },
      },
    },
    record: { phase, base: base ?? DEFAULT_ESCALATION_BASE, escalated },
  };
}
