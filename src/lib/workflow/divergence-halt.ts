/**
 * Ladder halts and their evidence bundles (#995, #971 part B).
 *
 * #971 built the model escalation ladder: a capability-bound churn signal buys
 * one rung, cheapest first. This module is the other half of that bargain —
 * the three cases where the run must **stop and hand off to a human** instead
 * of climbing:
 *
 * - `SPEC_DIVERGENCE` — an agent declared the spec impossible as written
 *   (#971 AC-4). The escape hatch. No rung is spent, and no retry is
 *   dispatched: a retry cannot un-contradict a spec.
 * - `DIVERGENCE_SUSPECT` — the loop keeps producing plausible diffs at a
 *   still-failing verdict (#971 AC-3). A stronger model would rediscover the
 *   contradiction more expensively, so the model option stays constant and the
 *   run halts.
 * - `TOP_OF_LADDER` — a further capability-bound trigger arrived with no rung
 *   left to climb (#971 AC-9). Looping again buys nothing.
 *
 * Deliberately its own module rather than living in `model-ladder.ts`: that
 * module is a pure config resolver with two dispatch callers, whereas this is
 * human-facing formatting with two *different* callers (`batch-executor.ts`
 * and `ready-gate.ts`). Folding them together would give the resolver a
 * rendering dependency neither dispatch site needs.
 *
 * The shape follows the #739 turn-cap and #799 billing-window halts — surface,
 * halt, preserve partial work — so this reads as a third member of that family
 * rather than a new idiom.
 */

import type { ModelEscalationRecord } from "./model-ladder.js";

/** Why the ladder halted instead of climbing. */
export type LadderHaltReason =
  /** An agent declared the spec impossible as written (#971 AC-4). */
  | "SPEC_DIVERGENCE"
  /** Repeated progress at a still-failing verdict (#971 AC-3). */
  | "DIVERGENCE_SUSPECT"
  /** A further trigger arrived on the last rung (#971 AC-9). */
  | "TOP_OF_LADDER";

/** One iteration's observable outcome, as replayed in the bundle. */
export interface DivergenceIterationRecord {
  /** 1-based quality-loop iteration. */
  iteration: number;
  /** `git rev-parse HEAD` at the close of the iteration, when known. */
  sha?: string;
  /** QA verdict for the iteration, when one was parsed. */
  verdict?: string;
}

/**
 * Everything a human needs to adjudicate a ladder halt without replaying the
 * run.
 *
 * The load-bearing field is `escalationHistory`: an **empty** history on a
 * `SPEC_DIVERGENCE` or `DIVERGENCE_SUSPECT` halt is the proof that no rung was
 * spent (#971 AC-3/AC-4), and a non-empty one ending at the top rung is what
 * a `TOP_OF_LADDER` halt means (AC-9). It is therefore always present, never
 * optional — "absent" and "empty" must not be confusable here.
 */
export interface EvidenceBundle {
  issueNumber: number;
  /** Phase the run halted in. */
  phase: string;
  reason: LadderHaltReason;
  /** SHAs produced across the iterations that led here, oldest first. */
  shasTried: string[];
  /** Per-iteration verdicts/SHAs, oldest first. */
  iterations: DivergenceIterationRecord[];
  /** Rungs spent during this run. Empty ⇒ no model escalation occurred. */
  escalationHistory: ModelEscalationRecord[];
  /**
   * AC IDs the agent named as impossible, verbatim from its marker
   * (`SPEC_DIVERGENCE` only). Present but empty when the agent halted without
   * naming one — AC-14 requires the halt output to name the AC, so an empty
   * value here is itself a reportable fact, not a formatting no-op.
   */
  declaredAcs?: string;
  /** The agent's own message, when it supplied one. */
  message?: string;
}

/** One-line human summary per halt reason. */
const REASON_HEADLINE: Record<LadderHaltReason, string> = {
  SPEC_DIVERGENCE:
    "the agent declared the spec impossible as written — no model rung was spent",
  DIVERGENCE_SUSPECT:
    "repeated progress at a still-failing verdict — divergence-suspect, so the model was never escalated",
  TOP_OF_LADDER:
    "a further capability-bound trigger arrived on the ladder's last rung — there is nowhere left to climb",
};

/** What the human should do next, per halt reason. */
const REASON_NEXT_STEP: Record<LadderHaltReason, string> = {
  SPEC_DIVERGENCE:
    "Reconcile the acceptance criteria with the repository as it exists, then re-run. A stronger model cannot resolve a contradiction in the spec.",
  DIVERGENCE_SUSPECT:
    "Review the diffs produced above against the failing criteria — the loop is building plausible work that the criteria keep rejecting. Re-specify before re-running.",
  TOP_OF_LADDER:
    "The strongest configured model still could not converge. Review the work in the worktree, or reconsider the criteria, before spending more.",
};

/**
 * Render an {@link EvidenceBundle} as the block printed at the halt and
 * persisted with the run.
 *
 * Plain labelled lines rather than a box or table: this text is read as often
 * by an agent (in a `/loop` or `/qa` prompt) as by a human, and box-drawing
 * characters are hostile to both grep and LLM parsing.
 */
export function formatEvidenceBundle(bundle: EvidenceBundle): string {
  const lines: string[] = [];
  lines.push(
    `Ladder halt: ${bundle.reason} — issue #${bundle.issueNumber}, phase '${bundle.phase}'`,
  );
  lines.push(`  Why: ${REASON_HEADLINE[bundle.reason]}`);

  if (bundle.declaredAcs !== undefined) {
    lines.push(
      `  Declared impossible: ${bundle.declaredAcs.trim() || "(the agent named no AC)"}`,
    );
  }
  if (bundle.message) {
    lines.push(`  Agent message: ${bundle.message}`);
  }

  lines.push(
    `  SHAs tried: ${bundle.shasTried.length > 0 ? bundle.shasTried.join(", ") : "(none recorded)"}`,
  );

  lines.push("  Iterations:");
  if (bundle.iterations.length === 0) {
    lines.push("    (none recorded)");
  } else {
    for (const it of bundle.iterations) {
      lines.push(
        `    ${it.iteration}: verdict=${it.verdict ?? "(none)"} sha=${it.sha ?? "(none)"}`,
      );
    }
  }

  lines.push("  Escalation history:");
  if (bundle.escalationHistory.length === 0) {
    // The proof that AC-3/AC-4's "without escalating" held. Spelled out rather
    // than omitted so a reader never has to infer it from an absent section.
    lines.push("    (empty — no model rung was spent)");
  } else {
    for (const rec of bundle.escalationHistory) {
      lines.push(
        `    ${rec.phase}: ${rec.base} → ${rec.escalated} (rung ${rec.rung}, ${rec.trigger})`,
      );
    }
  }

  lines.push(`  Next step: ${REASON_NEXT_STEP[bundle.reason]}`);
  return lines.join("\n");
}
