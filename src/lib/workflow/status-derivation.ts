/**
 * Shared status derivation for the run's live state machines (#766).
 *
 * Both the orchestrator's `IssueRuntimeState` machine and the renderer's
 * `IssueState` machine used to *pin* an issue `failed` on any phase failure and
 * never de-escalate — so a phase that failed on an early quality-loop iteration
 * left the card red even after a later iteration recovered and shipped the PR.
 *
 * The fix derives the failed verdict from the CURRENT phase slots instead.
 * `findOrAppendPhase` (orchestrator) and the renderer both key phases by name,
 * so a retried phase overwrites its slot with the latest attempt — the slot
 * already holds "the last attempt". The one phase that is NOT overwritten on
 * recovery is `loop`: it is an auxiliary recovery step that only runs after a
 * failure, so a stale failed `loop` slot must not pin the issue. Excluding
 * `loop` never hides a genuine failure — an unrecovered pipeline failure always
 * leaves a non-loop phase's latest slot failed too (the qa/exec the loop was
 * trying to fix).
 */

/** Auxiliary recovery phase — excluded from the failed verdict (see above). */
export const LOOP_PHASE = "loop";

/** Minimal phase shape both live state machines satisfy. */
export interface DerivablePhase {
  name: string;
  status: string;
}

/**
 * True iff a non-loop phase's latest slot is `failed`. The single source of
 * truth for "is this issue failed" across both live state machines (#766 AC-2).
 */
export function pipelineHasFailed(phases: DerivablePhase[]): boolean {
  return phases.some((p) => p.name !== LOOP_PHASE && p.status === "failed");
}
