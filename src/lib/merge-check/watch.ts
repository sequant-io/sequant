/**
 * `sequant merge --watch` — poll a PR's CI rollup until it is terminal, then let
 * the existing merge-check report run. This module owns only the *wait*: it
 * never merges and never runs the checks itself (merge.ts orchestrates that).
 *
 * See #818. Design contract:
 *  - foreground `await sleep` loop — no daemon, no child process, no OS notifier;
 *  - all `gh` access through `GitHubProvider` (#443), using `statusCheckRollup`
 *    (the `--json checks` field is known-broken);
 *  - three dispatch-block signatures short-circuit to BLOCKED instead of polling
 *    until timeout (AC-3): merge conflict, zero-checks-because-conflicting, and a
 *    uniformly-failing board whose annotations show the runner never started.
 */

import type {
  RollupEntry,
  MergeableState,
} from "../workflow/platforms/github.js";
import {
  allChecksFailing,
  detectInfraBlockedCi,
  type CiCheckBucket,
  type AnnotatedCheck,
} from "../qa/infra-blocked-ci.js";

/**
 * The subset of `GitHubProvider` the watch loop depends on. Declared as an
 * interface so tests inject a fake without spawning real `gh` calls.
 */
export interface WatchGitHub {
  getMergeableStateSync(prNumber: number): MergeableState;
  getStatusCheckRollupSync(prNumber: number): RollupEntry[];
  getPRHeadShaSync(prNumber: number): string | null;
  getCheckRunAnnotationsSync(headSha: string): AnnotatedCheck[];
}

/**
 * Map one rollup entry to a `gh`-style bucket (`pass | fail | pending |
 * skipping`), normalising the two entry shapes (CheckRun vs StatusContext) so
 * `allChecksFailing` — which the billing-lockout detector gates on — can be
 * reused verbatim.
 */
export function rollupEntryBucket(entry: RollupEntry): string {
  // CheckRun: progress in `status`, outcome in `conclusion`.
  if (entry.status !== undefined || entry.conclusion !== undefined) {
    const status = (entry.status ?? "").toUpperCase();
    if (status !== "COMPLETED") return "pending"; // QUEUED | IN_PROGRESS | ...
    const conclusion = (entry.conclusion ?? "").toUpperCase();
    switch (conclusion) {
      case "SUCCESS":
        return "pass";
      case "NEUTRAL":
      case "SKIPPED":
        return "skipping";
      default:
        // FAILURE | TIMED_OUT | CANCELLED | ACTION_REQUIRED | STARTUP_FAILURE | STALE
        return "fail";
    }
  }
  // StatusContext: combined state.
  const state = (entry.state ?? "").toUpperCase();
  switch (state) {
    case "SUCCESS":
      return "pass";
    case "FAILURE":
    case "ERROR":
      return "fail";
    default:
      // PENDING | EXPECTED
      return "pending";
  }
}

/** Is a rollup entry in a terminal (no-longer-changing) state? */
export function isRollupEntryTerminal(entry: RollupEntry): boolean {
  return rollupEntryBucket(entry) !== "pending";
}

/** Outcome of classifying a single poll tick. */
export type TickOutcome =
  | { kind: "terminal" }
  | { kind: "blocked"; reason: string; checkName?: string }
  | { kind: "pending"; pending: number; total: number };

/**
 * Classify a single poll of `(mergeable, rollup)`.
 *
 * Pure except for the lazily-invoked `fetchAnnotations`, which is called ONLY
 * when the whole board is terminal-and-failing — so healthy or partial boards
 * never pay for the extra check-run annotation API calls.
 */
export function classifyTick(
  mergeable: MergeableState,
  rollup: RollupEntry[],
  fetchAnnotations: () => AnnotatedCheck[],
): TickOutcome {
  // (1) Merge conflict blocks CI dispatch entirely — CI never starts against an
  // unmergeable ref, so waiting on checks is futile. Fire regardless of check
  // count: this also covers the "zero checks because CONFLICTING" trap (AC-3a,
  // AC-3b) — the case the issue calls out where 0 checks after a push means
  // dispatch was blocked, not that CI is slow.
  if (mergeable === "CONFLICTING") {
    return {
      kind: "blocked",
      reason:
        "PR is not mergeable (CONFLICTING) — merge conflicts block CI dispatch. " +
        "Resolve conflicts and re-push before running merge-check.",
    };
  }

  // No checks yet. While GitHub is still computing mergeability or hasn't
  // dispatched, keep polling; a genuine no-CI PR falls through to the timeout,
  // whose message names the zero-checks case. We deliberately do NOT declare
  // terminal here — proceeding on an empty board would skip the very CI the
  // user asked us to wait for.
  if (rollup.length === 0) {
    return { kind: "pending", pending: 0, total: 0 };
  }

  const pending = rollup.filter((e) => !isRollupEntryTerminal(e));
  if (pending.length > 0) {
    return { kind: "pending", pending: pending.length, total: rollup.length };
  }

  // (3) Every check is terminal. If the board is uniformly failing it may be a
  // billing lockout (runner never started) rather than real test failures —
  // scan the head-SHA annotations for the not-started signature (AC-3c). Only
  // then; a healthy or partially-failing board is a real verdict, not a block.
  const buckets: CiCheckBucket[] = rollup.map((e) => ({
    bucket: rollupEntryBucket(e),
  }));
  if (allChecksFailing(buckets)) {
    const infra = detectInfraBlockedCi(fetchAnnotations());
    if (infra.blocked) {
      return {
        kind: "blocked",
        reason:
          infra.message ??
          "CI runner was not started (infrastructure blocked).",
        checkName: infra.checkName,
      };
    }
  }

  return { kind: "terminal" };
}

/** Terminal status of a watch. */
export type WatchStatus = "terminal" | "blocked" | "timeout";

/** Result of watching a single PR's checks to completion. */
export interface WatchResult {
  status: WatchStatus;
  /** Human-readable cause for `blocked`/`timeout`; undefined when `terminal`. */
  reason?: string;
  /** Check name whose annotation matched, for a billing-lockout BLOCKED. */
  checkName?: string;
  /** Number of polls performed. */
  polls: number;
  /** Elapsed wall-clock time in milliseconds. */
  elapsedMs: number;
}

/** Options for {@link waitForChecks}. */
export interface WatchOptions {
  /** Delay between polls, in milliseconds. */
  intervalMs: number;
  /** Give-up deadline measured from the first poll, in milliseconds. */
  timeoutMs: number;
  /** Optional per-poll progress callback (terminal output). */
  onPoll?: (message: string) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll a PR's rollup until it is terminal, blocked, or timed out.
 *
 * `sleepFn`/`nowFn` are injectable so tests run instantly and deterministically
 * without real timers. The loop always classifies a *fresh* poll before it can
 * declare a timeout, so a check that turns terminal on the final interval is
 * never swallowed by the deadline.
 */
export async function waitForChecks(
  prNumber: number,
  options: WatchOptions,
  gh: WatchGitHub,
  sleepFn: (ms: number) => Promise<void> = defaultSleep,
  nowFn: () => number = Date.now,
): Promise<WatchResult> {
  const { intervalMs, timeoutMs, onPoll } = options;
  const start = nowFn();
  const deadline = start + timeoutMs;
  let polls = 0;

  // Lazy annotation fetch — only reached from classifyTick's all-failing branch.
  const fetchAnnotations = (): AnnotatedCheck[] => {
    const sha = gh.getPRHeadShaSync(prNumber);
    if (!sha) return [];
    return gh.getCheckRunAnnotationsSync(sha);
  };

  for (;;) {
    polls++;
    const mergeable = gh.getMergeableStateSync(prNumber);
    const rollup = gh.getStatusCheckRollupSync(prNumber);
    const tick = classifyTick(mergeable, rollup, fetchAnnotations);
    const elapsedMs = nowFn() - start;

    if (tick.kind === "blocked") {
      return {
        status: "blocked",
        reason: tick.reason,
        checkName: tick.checkName,
        polls,
        elapsedMs,
      };
    }
    if (tick.kind === "terminal") {
      return { status: "terminal", polls, elapsedMs };
    }

    // Pending: report progress.
    if (onPoll) {
      onPoll(
        tick.total === 0
          ? "No checks reported yet…"
          : `${tick.total - tick.pending}/${tick.total} checks terminal…`,
      );
    }

    // Deadline reached. The classify above was a fresh poll, so timing out now
    // cannot swallow a late terminal.
    if (nowFn() >= deadline) {
      const timeoutSec = Math.round(timeoutMs / 1000);
      const reason =
        tick.total === 0
          ? `Watch timed out after ${timeoutSec}s: no CI checks ever appeared for PR #${prNumber} ` +
            `(CI may not be configured, or dispatch was blocked).`
          : `Watch timed out after ${timeoutSec}s: ${tick.pending}/${tick.total} checks still pending on PR #${prNumber}.`;
      return { status: "timeout", reason, polls, elapsedMs };
    }

    const remaining = deadline - nowFn();
    await sleepFn(Math.min(intervalMs, Math.max(0, remaining)));
  }
}
