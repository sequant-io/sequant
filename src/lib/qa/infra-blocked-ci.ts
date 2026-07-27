/**
 * Infra-blocked CI detection helpers used by the `/qa` Phase 1 CI status check.
 *
 * A repository that has hit its GitHub Actions spending limit fails **every**
 * check within seconds of starting: no runner is ever allocated, so no step
 * executes. `gh pr checks` and `gh run view` report these as ordinary failures,
 * and the default status mapping (`FAILURE → NOT_MET → blocks merge`) then marks
 * CI-dependent ACs as unmet for a condition no code change can fix — findings
 * that would go on to feed `/loop` and burn iterations "fixing" working code.
 *
 * The real cause exists only as a check-run annotation. `/qa` uses these helpers
 * to recognise that signature and reclassify CI as infra-blocked instead.
 *
 * Both functions are pure predicates over already-fetched API data; the `gh api`
 * plumbing lives in the skill prompt, mirroring `./markdown-only-ci.ts`.
 */

/** Minimal shape of a `gh pr checks --json name,state,bucket` entry. */
export interface CiCheckBucket {
  /** `gh` rollup bucket: `pass` | `fail` | `pending` | `skipping`. */
  bucket: string;
}

/**
 * Predicate: is *every* check in the `fail` bucket?
 *
 * This is the gate for the annotation query. A mix of real failures and
 * fail-fast ones is not the billing-lockout signature — only a uniformly red
 * board is — so healthy and partially-failing PRs never pay for the extra API
 * calls, and their status mapping is untouched.
 *
 * An empty list means "no CI configured", which is a separate case handled by
 * the skill's existing empty-response branch, so it returns `false` here rather
 * than vacuously true.
 *
 * @param checks - Entries from `gh pr checks --json name,state,bucket`.
 * @returns `true` only if `checks` is non-empty and every entry is `fail`.
 */
export function allChecksFailing(checks: readonly CiCheckBucket[]): boolean {
  if (checks.length === 0) return false;
  return checks.every((check) => check.bucket === "fail");
}

/**
 * The runner-never-started signature.
 *
 * Deliberately matches on the annotation **message only**, with no
 * `annotation_level` condition. The captured fixture does carry
 * `annotation_level: "failure"`, but gating on it would add a requirement the
 * acceptance criteria never state, and a `warning`-level variant of the same
 * message would then be silently missed — the exact class of failure this
 * detection exists to prevent.
 */
export const NOT_STARTED_SIGNATURE = /job was not started/i;

/** Minimal shape of a GitHub check-run annotation. */
export interface CheckAnnotation {
  message?: string | null;
  annotation_level?: string | null;
  path?: string | null;
}

/** A check paired with the annotations fetched from its `annotations_url`. */
export interface AnnotatedCheck {
  checkName: string;
  annotations?: readonly CheckAnnotation[] | null;
}

/** Outcome of scanning failing checks for the not-started signature. */
export interface InfraBlockedResult {
  /** `true` when CI is red for infrastructure reasons, not code reasons. */
  blocked: boolean;
  /**
   * The matching annotation message, **verbatim**. `/qa` surfaces this as the
   * action item rather than paraphrasing it — the message names the remedy
   * (e.g. the billing settings page), and a paraphrase would lose it.
   */
  message?: string;
  /** Name of the check whose annotation matched, for the QA report. */
  checkName?: string;
}

/**
 * Scan failing checks' annotations for the not-started signature.
 *
 * Returns on the first match: when the board is uniformly red for a billing
 * lockout, every check carries the same annotation, so one is representative
 * and the caller can stop fetching.
 *
 * @param checks - Failing checks with their fetched annotations.
 * @returns `{ blocked: true, message, checkName }` on a match, else `{ blocked: false }`.
 */
export function detectInfraBlockedCi(
  checks: readonly AnnotatedCheck[],
): InfraBlockedResult {
  for (const check of checks) {
    for (const annotation of check.annotations ?? []) {
      const message = annotation?.message;
      if (typeof message === "string" && NOT_STARTED_SIGNATURE.test(message)) {
        return { blocked: true, message, checkName: check.checkName };
      }
    }
  }

  return { blocked: false };
}
