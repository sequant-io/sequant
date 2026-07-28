/**
 * Which persisted issue statuses mean "this issue is already done" (#837).
 *
 * Single source of truth for every pre-flight guard that skips finished work.
 * It exists because the same predicate was previously spelled out inline at two
 * sites with two different lists, and #817's `--ready-gate` extended the status
 * vocabulary without either site following:
 *
 * - `chain-resume.ts` peels the completed prefix off a `--chain` run.
 * - `run-orchestrator.ts` drops finished issues from a non-chain run.
 *
 * A gated issue deliberately terminates in `waiting_for_human_merge` (policy
 * threshold reached) rather than `ready_for_merge`, since `ready_for_merge`
 * would read as auto-merge-ready and defeat the human merge gate the feature
 * exists to preserve. Both guards missed it, so re-running re-executed
 * already-gated issues from phase 0 — a full spec/exec/qa pipeline plus another
 * full-weight ready gate.
 *
 * `blocked` is deliberately NOT a completed status, for two reasons:
 *
 * 1. It is a *generic* member of `IssueStatusSchema` ("waiting on external input
 *    or dependency"), not a ready-gate-exclusive terminal. Admitting it here
 *    would silently apply to every other writer of that status, present and
 *    future.
 * 2. A guard halt IS the human-attention signal. Skipping it as complete would
 *    report the issue as passed when it demonstrably did not.
 *
 * So a `blocked` issue is re-executed rather than skipped — the same
 * conservative rule already applied to issues whose state lookup fails.
 * Re-running wastes tokens; silently dropping an issue the user must look at is
 * the worse failure. Once the user clears the blocker, the re-run is what lets
 * work resume.
 *
 * NOTE: this is "done, do not re-run", which is NOT the same set as "might have
 * a merged PR" — `state-cleanup.ts`'s merge-detection sweep deliberately keeps
 * its own wider list (it also scans `in_progress`, #592, and
 * `waiting_for_qa_gate`, #606). Do not unify the two.
 *
 * When adding a status to `IssueStatusSchema`, decide here whether it belongs.
 */
export const COMPLETED_ISSUE_STATUSES = [
  "ready_for_merge",
  "merged",
  "waiting_for_human_merge",
] as const;

/** A persisted status that counts as completed work. */
export type CompletedIssueStatus = (typeof COMPLETED_ISSUE_STATUSES)[number];

const COMPLETED_ISSUE_STATUS_SET = new Set<string>(COMPLETED_ISSUE_STATUSES);

/**
 * True iff `status` marks the issue as already finished, so a re-run should
 * skip it unless `--force` is passed.
 *
 * Accepts `string | undefined` because persisted state may predate the current
 * schema or be absent entirely; an unknown or missing status is treated as
 * incomplete (re-execute), never as complete.
 */
export function isCompletedIssueStatus(
  status: string | undefined,
): status is CompletedIssueStatus {
  return status !== undefined && COMPLETED_ISSUE_STATUS_SET.has(status);
}
