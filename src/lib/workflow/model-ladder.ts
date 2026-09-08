/**
 * Model escalation ladder on capability-bound non-convergence (#971).
 *
 * #914 fixed the per-phase model at launch and #915 escalates *effort* one
 * tier on an observed retry. This module adds the next rungs — *model*
 * escalation — for the cases where an effort bump was not enough.
 *
 * The load-bearing design constraint is that **model escalation only helps
 * capability-bound churn, not spec-bound churn.** When the loop churns because
 * the spec diverges from reality, a stronger model rediscovers the
 * contradiction more expensively before halting. So the ladder routes on *why*
 * the loop is churning, and the two failure classes leave different
 * fingerprints in data `qa-stagnation.ts` already computes:
 *
 * - **No progress** (`LOOP_NO_DIFF`, `SAME_SHA_NO_PROGRESS`): the agent cannot
 *   produce a working change → capability-bound → escalate.
 * - **Progress but repeated failure** (a new SHA each iteration, QA still
 *   failing): plausible diffs that do not converge → divergence-suspect →
 *   never escalate (#971 AC-3). That halt, and the `SPEC_DIVERGENCE` escape
 *   hatch, are node 14 (#995); this module's contract is only that such a
 *   pattern produces no trigger, so the model option stays constant.
 *
 * Deliberately its own module rather than living beside `resolvePhasePolicies`
 * in `config-resolver.ts`, for the same reason `effort-escalation.ts` is:
 * `config-resolver.ts` imports `getEnvConfig` from `batch-executor.ts`, and
 * `batch-executor.ts` is one of this module's dispatch-time callers, so
 * co-locating there would introduce that cycle.
 *
 * Two deliberate divergences from `withEscalatedEffort`'s contract, both
 * AC-mandated:
 *
 * - Escalation is **sticky** (AC-6): once a phase reaches a rung it stays
 *   there for its remaining iterations in the run. #915 explicitly does *not*
 *   accumulate — but dropping back to a model that already failed re-burns the
 *   cheap rung, which is the opposite of the evidence this ladder acts on.
 * - Escalation is **trigger-gated**, not retry-gated: a retry alone is not
 *   evidence of model incapability.
 *
 * Everything else follows `withEscalatedEffort`'s shape, including its
 * "return the input config by reference when nothing changed" contract, so a
 * shared `ExecutionConfig` is never mutated and an escalation never leaks into
 * a phase execution it was not computed for.
 */

import type { ExecutionConfig, ModelEscalationFacts } from "./types.js";
import type { PhaseMarker } from "./state-schema.js";
import {
  detectStagnation,
  type LoopProgressDecision,
  type StagnationReason,
} from "./qa-stagnation.js";

/**
 * The deterministic no-progress signals the ladder routes on.
 *
 * Identical to `qa-stagnation.ts`'s `StagnationReason` by construction — these
 * are that module's reason codes, not a parallel taxonomy. Aliased (rather
 * than re-declared) so a reason added there cannot silently fail to reach the
 * ladder.
 *
 * Deliberately NOT "QA returned the same finding twice": finding-level
 * identity across LLM-written verdicts needs semantic comparison, the same
 * fuzzy-gate class rejected in #922/#928.
 */
export type EscalationTrigger = StagnationReason;

/**
 * Per-run, per-phase rung state — where the **stickiness** in AC-6 lives.
 *
 * Deliberately mutable state owned by the dispatch loop rather than a field on
 * `ExecutionConfig`: `buildExecutionConfig`/`buildPhaseConfig` run once per
 * run/gate, not once per phase execution, so a rung baked into the config
 * would leak across every phase in the chain — exactly the bug #915's AC-7
 * exists to prevent.
 */
export interface LadderState {
  /** Phase name → 0-based rung index currently in force for that phase. */
  rungByPhase: Map<string, number>;
  /** Phases that have hit the last rung and have nowhere left to go (AC-6). */
  topOfLadder: Set<string>;
}

/**
 * Is a ladder configured at all?
 *
 * The one predicate dispatch sites use to gate the ladder's *side costs* — the
 * per-iteration `git` snapshot in `batch-executor.ts` (AC-D2) — so an
 * unconfigured run issues no extra work and stays byte-identical to pre-#971
 * (AC-1). Kept here so no call site reads `config.modelLadder` directly.
 */
export function isLadderConfigured(config: ExecutionConfig): boolean {
  return (config.modelLadder?.length ?? 0) > 0;
}

/** Fresh per-run ladder state. One per issue/gate invocation. */
export function createLadderState(): LadderState {
  return { rungByPhase: new Map(), topOfLadder: new Set() };
}

/**
 * Pure ladder step: exactly one rung up, clamped at the last entry (AC-6).
 *
 * Never skips a rung — the whole cost argument for a ladder is that the cheap
 * rung is tried first, and jumping past it spends the expensive rung on work
 * the next one up might have done.
 */
export function resolveNextRung(
  ladder: string[],
  currentIndex: number,
): number {
  if (ladder.length === 0) return currentIndex;
  const from = Math.max(0, Math.min(currentIndex, ladder.length - 1));
  return Math.min(from + 1, ladder.length - 1);
}

/**
 * Where a phase's ladder starts (AC-7).
 *
 * An explicit `--models` pin (or a `settings.run.phases[phase].model`, which
 * reaches this function through the same resolved `phasePolicies` field) sets
 * the starting rung. Returns:
 *
 * - `null` when no ladder is configured, or when the phase carries a pin that
 *   is **not** a ladder entry. An off-ladder pin never escalates: treating
 *   `ladder[0]` as "next" after it could silently *downgrade* the user's
 *   explicit pin, the exact inversion #915 and #971 both reject.
 * - the pin's index when the pin IS a ladder entry.
 * - `0` when the phase has no model pin.
 */
export function startingRungFor(
  phase: string,
  config: ExecutionConfig,
): number | null {
  const ladder = config.modelLadder;
  if (!ladder || ladder.length === 0) return null;

  const pinned = config.phasePolicies?.[phase]?.model;
  if (pinned === undefined) return 0;

  const idx = ladder.indexOf(pinned);
  return idx === -1 ? null : idx;
}

/**
 * Is there a rung left for this phase to escalate to?
 *
 * Exists so a dispatch site can ask the question without reading
 * `config.modelLadder` itself. `ready-gate.ts` uses it to decide whether
 * `LOOP_NO_DIFF` is continuable, and must not name the ladder field directly
 * (AC-11's static gate: the gate receives the ladder through the shared
 * config, it never resolves one).
 */
export function canEscalateFurther(
  config: ExecutionConfig,
  phase: string,
  state: LadderState,
): boolean {
  const ladder = config.modelLadder;
  if (!ladder || ladder.length === 0) return false;
  const start = startingRungFor(phase, config);
  if (start === null) return false;
  const current = state.rungByPhase.get(phase) ?? start;
  return current < ladder.length - 1;
}

/** Why {@link detectCapabilityBoundTrigger} decided as it did. */
export interface CapabilityTriggerDecision {
  /** The signal to escalate on, or `null` for "do not escalate". */
  trigger: EscalationTrigger | null;
  /** Human-readable explanation, for verbose output and records. */
  reason: string;
}

export interface CapabilityTriggerInput {
  /**
   * Is this dispatch a retry at all? A first attempt is never escalated — the
   * ladder acts on observed failure, never speculatively (the same rule #915
   * states for effort, and the same reason downgrades are out of scope).
   */
  isRetry: boolean;
  /**
   * Result of `compareLoopProgress(before, after)` for the fix loop that ran
   * before this dispatch. `progressed: false` is the `LOOP_NO_DIFF` signal.
   * Omit when the caller has no snapshot pair.
   */
  loopProgress?: LoopProgressDecision | null;
  /**
   * The most recent phase marker for the phase being retried. Pass `null`
   * explicitly to assert "a marker was looked for and none was found" — that
   * is the AC-8 missing-marker case, not a "no marker path requested".
   * Leave `undefined` when the caller does not consult markers at all.
   */
  lastMarker?: PhaseMarker | null;
  /** Current `git rev-parse HEAD`. Supplying it requests the SAME_SHA path. */
  currentSha?: string;
  /** Whether `git status --porcelain` is non-empty. */
  isDirty?: boolean;
  /** Phase the marker is expected to belong to, when one is consulted. */
  markerPhase?: string;
}

/** Outcome of {@link checkMarkerIntegrity}. */
export interface MarkerIntegrityResult {
  ok: boolean;
  reason: string;
}

/**
 * The AC-8 marker-integrity guard.
 *
 * A missing or self-inconsistent phase marker is not evidence of model
 * incapability — it is evidence that the record is broken. Escalating on it
 * would spend the expensive rung on a bookkeeping fault, so a failed check
 * means "do not escalate, and say why"; healing the marker itself is
 * `reconcile.ts`'s job and is deliberately not wired in here (#971 OQ-4 —
 * `doctor.ts` has no phase-marker check to route through).
 *
 * @internal Exported for testing and for the trigger detector below.
 */
export function checkMarkerIntegrity(
  marker: PhaseMarker | null,
  expectedPhase?: string,
): MarkerIntegrityResult {
  if (marker === null) {
    return {
      ok: false,
      reason:
        "phase marker missing — a broken record is not evidence of model incapability",
    };
  }
  if (expectedPhase !== undefined && marker.phase !== expectedPhase) {
    return {
      ok: false,
      reason: `phase marker belongs to phase '${marker.phase}', expected '${expectedPhase}'`,
    };
  }
  if (!marker.commitSHA) {
    return {
      ok: false,
      reason: "phase marker has no commitSHA — no-progress cannot be compared",
    };
  }
  if (!marker.timestamp || Number.isNaN(Date.parse(marker.timestamp))) {
    return {
      ok: false,
      reason: `phase marker timestamp is unparseable ('${marker.timestamp}')`,
    };
  }
  return { ok: true, reason: "phase marker is intact" };
}

/**
 * The single place both dispatch paths agree on what "capability-bound" means.
 *
 * Order matters: the integrity guard runs BEFORE any signal is read, so a
 * rigged marker suppresses escalation even when the snapshot pair would
 * otherwise have produced `LOOP_NO_DIFF` (AC-8).
 *
 * The guard only engages when the caller actually consults markers — passing
 * `lastMarker` (including `null`) or `currentSha`. The `run` path's
 * snapshot-only `LOOP_NO_DIFF` detection needs no marker and is not blocked by
 * the absence of one.
 */
export function detectCapabilityBoundTrigger(
  input: CapabilityTriggerInput,
): CapabilityTriggerDecision {
  const {
    isRetry,
    loopProgress,
    lastMarker,
    currentSha,
    isDirty,
    markerPhase,
  } = input;

  if (!isRetry) {
    return {
      trigger: null,
      reason: "not a retry — nothing observed to act on",
    };
  }

  // AC-8: the marker path was requested (a marker was consulted, or a SHA
  // comparison asked for) — check its integrity before reading any signal.
  const markerPathRequested =
    lastMarker !== undefined || currentSha !== undefined;
  if (markerPathRequested) {
    const integrity = checkMarkerIntegrity(lastMarker ?? null, markerPhase);
    if (!integrity.ok) {
      return { trigger: null, reason: `no escalation — ${integrity.reason}` };
    }
  }

  if (loopProgress && !loopProgress.progressed) {
    return {
      trigger: "LOOP_NO_DIFF",
      reason: loopProgress.message,
    };
  }

  if (currentSha !== undefined && lastMarker) {
    const stagnation = detectStagnation({
      currentSha,
      isDirty: isDirty ?? false,
      lastMarker,
    });
    if (stagnation.stagnant && stagnation.reason === "SAME_SHA_NO_PROGRESS") {
      return { trigger: "SAME_SHA_NO_PROGRESS", reason: stagnation.message };
    }
    return { trigger: null, reason: stagnation.message };
  }

  // Progress was observed (new SHA, new diff) but the work still failed. That
  // is the divergence-suspect half of AC-3: plausible diffs that do not
  // converge. A stronger model would rediscover the contradiction more
  // expensively — so the model option must stay constant.
  return {
    trigger: null,
    reason:
      "progress observed since the last attempt — divergence-suspect, not capability-bound",
  };
}

/**
 * The retry index at which a capability-bound trigger may first spend a model
 * rung (#971 AC-5).
 *
 * Retry 1 belongs to #915: "effort escalation remains the first rung (retry 1
 * → effort +1 tier, same model). Model escalation fires only on a subsequent
 * capability-bound trigger (retry ≥ 2 with no-progress stagnation)." The cheap
 * rung is tried first — that is the ladder's whole cost argument, and it
 * applies to the effort rung exactly as it applies to skipping a model rung.
 */
export const FIRST_MODEL_RUNG_RETRY = 2;

/**
 * Gate a capability-bound trigger on the retry it arrived at (#971 AC-5).
 *
 * Returns the trigger only from {@link FIRST_MODEL_RUNG_RETRY} onward, and
 * `null` before it — so retry 1 falls through to `withEscalatedEffort` and
 * spends the effort rung, while the model rung waits for a *subsequent*
 * capability-bound retry.
 *
 * Both dispatch paths call this and feed its result to BOTH escalators —
 * `withEscalatedEffort(cfg, phase, isRetry && modelTrigger === null)` then
 * `withEscalatedModel(cfg, phase, modelTrigger, state)`. That keeps AC-5's
 * two halves structural rather than conventional: "effort first" because a
 * suppressed trigger leaves the effort bump enabled, and "never both" because
 * an active one disables it. Kept here, next to `withEscalatedModel`, so the
 * run path and the ready gate cannot drift on the rule (AC-11's
 * single-choke-point discipline).
 *
 * @param trigger The capability-bound signal observed by the previous
 *   iteration, or `null` when it made progress.
 * @param retryIndex 0 on a first attempt, 1 on the first retry, and so on.
 */
export function effectiveModelTrigger(
  trigger: EscalationTrigger | null,
  retryIndex: number,
): EscalationTrigger | null {
  return retryIndex >= FIRST_MODEL_RUNG_RETRY ? trigger : null;
}

/** One escalated dispatch, for observability (run metrics + verbose output). */
export interface ModelEscalationRecord extends ModelEscalationFacts {
  phase: string;
}

export interface ModelEscalationOutcome {
  /**
   * The config to dispatch with. Identical **by reference** to the input
   * `config` whenever nothing escalated — so a shared `ExecutionConfig` is
   * never mutated and an unconfigured run is indistinguishable from pre-#971
   * (AC-1).
   */
  config: ExecutionConfig;
  /**
   * Present only when THIS dispatch advanced a rung. A sticky dispatch that
   * merely stays at an already-reached rung carries no record — so
   * "the model changed on this iteration" is exactly "a record was emitted"
   * (what AC-5's never-both assertion reads).
   */
  record?: ModelEscalationRecord;
  /**
   * True when this phase is on the last rung with nowhere left to go. Set on
   * the dispatch where a further trigger arrived and could not be honored;
   * node 14 (#995) turns it into the human-facing halt + evidence bundle.
   */
  topOfLadder?: boolean;
}

/**
 * Apply the ladder to ONE phase's execution, for THIS dispatch only.
 *
 * Returns the input config by reference — no escalation — when any of:
 *
 * - no ladder is configured (the feature is off);
 * - the phase carries a model pin that is not a ladder entry (AC-7);
 * - no trigger arrived and no sticky rung has been reached yet;
 * - the resolved rung is still the phase's starting rung.
 *
 * A trigger at the top rung leaves the model unchanged and reports
 * `topOfLadder` (AC-6): the ladder never escalates past its last entry.
 *
 * `state` is mutated — that is what makes the rung sticky across the run's
 * remaining iterations for this phase (AC-6). Later dispatches with a `null`
 * trigger still re-apply the reached rung.
 */
export function withEscalatedModel(
  config: ExecutionConfig,
  phase: string,
  trigger: EscalationTrigger | null,
  state: LadderState,
): ModelEscalationOutcome {
  const ladder = config.modelLadder;
  if (!ladder || ladder.length === 0) return { config };

  const start = startingRungFor(phase, config);
  if (start === null) return { config };

  const current = state.rungByPhase.get(phase) ?? start;
  let rung = current;
  let advanced = false;
  let hitTop = false;

  if (trigger) {
    const next = resolveNextRung(ladder, current);
    if (next === current) {
      // Already on the last rung — a further trigger buys nothing.
      hitTop = true;
      state.topOfLadder.add(phase);
    } else {
      rung = next;
      advanced = true;
      // Landing ON the last rung does not set the OUTCOME's `topOfLadder`:
      // that flag means "a trigger arrived and could not be honored", which is
      // the `hitTop` branch above, and this dispatch did escalate. The
      // recorded FACTS below do carry `topOfLadder` here — they describe the
      // rung the phase now sits on, so #995 can see there is no headroom left
      // without replaying the run.
    }
  }

  state.rungByPhase.set(phase, rung);

  // Nothing to apply: still at the phase's configured starting rung.
  if (rung === start) {
    return { config, ...(hitTop ? { topOfLadder: true } : {}) };
  }

  const escalatedModel = ladder[rung];
  const baseModel = ladder[start];
  const currentPolicy = config.phasePolicies?.[phase];

  const facts: ModelEscalationFacts = {
    rung,
    base: baseModel,
    escalated: escalatedModel,
    // A sticky re-application carries the trigger that got it here only when
    // this dispatch advanced; otherwise it names why it is still up here.
    trigger: trigger ?? "STICKY",
    ...(config.modelLadderRequested?.[rung] !== undefined
      ? { requestedModel: config.modelLadderRequested[rung] }
      : {}),
    ...(hitTop || rung === ladder.length - 1 ? { topOfLadder: true } : {}),
  };

  return {
    config: {
      ...config,
      phasePolicies: {
        ...config.phasePolicies,
        [phase]: { ...currentPolicy, model: escalatedModel },
      },
      modelEscalation: facts,
    },
    ...(advanced ? { record: { phase, ...facts } } : {}),
    ...(hitTop ? { topOfLadder: true } : {}),
  };
}

/**
 * Flatten escalation facts into `SEQUANT_PHASE` phase-marker fields (AC-10).
 *
 * Flat scalars only, and that is not a style choice: `phase-detection.ts`
 * parses markers with `/<!-- SEQUANT_PHASE: (\{[^}]+\}) -->/g`, whose
 * `[^}]+` body cannot span a nested object — a `{escalation:{…}}` marker
 * would silently stop parsing at the inner brace and take every marker in the
 * comment with it. `formatPhaseMarker` → `parsePhaseMarkers` round-trip is
 * the standing proof (AC-D1).
 *
 * `requestedModel` is included per the #975 trail note: `PhaseMarkerSchema`
 * has carried the field since #975, which deferred emission to this issue so
 * the machinery is built once.
 */
export function buildEscalationMarkerFields(
  facts: ModelEscalationFacts,
): Record<string, string | number | boolean> {
  return {
    ladderRung: facts.rung,
    baseModel: facts.base,
    escalatedModel: facts.escalated,
    escalationTrigger: facts.trigger,
    ...(facts.requestedModel !== undefined
      ? { requestedModel: facts.requestedModel }
      : {}),
    ...(facts.topOfLadder ? { topOfLadder: true } : {}),
  };
}
