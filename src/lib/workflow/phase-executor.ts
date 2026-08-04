/**
 * Phase execution engine for workflow orchestration.
 *
 * Handles executing individual phases via an AgentDriver interface,
 * including cold-start retry logic and MCP fallback strategies.
 *
 * The SDK import has been moved to ClaudeCodeDriver — this module
 * is agent-agnostic.
 */

import chalk from "chalk";
import { execFileSync } from "child_process";
import { ShutdownManager } from "../shutdown.js";
import { resolveDiffBase } from "./git-diff-utils.js";
import {
  Phase,
  ExecutionConfig,
  PhaseResult,
  QaVerdict,
  PhasePauseHandle,
} from "./types.js";
import type { QaSummary } from "./run-log-schema.js";
import { readAgentsMd } from "../agents-md.js";
import { getDriver } from "./drivers/index.js";
import type {
  AgentDriver,
  AgentExecutionConfig,
  AgentPhaseResult,
  ResumeHandle,
} from "./drivers/index.js";
import { classifyError } from "./error-classifier.js";
import {
  ApiError,
  BillingError,
  RateLimitError,
  SequantError,
  formatRateLimitMessage,
  formatResetTime,
  resetsAtToMs,
} from "../errors.js";
import { formatElapsedTime } from "../cli-ui/format.js";
import { phaseRegistry } from "./phase-registry.js";
import { bracketedConsoleLog } from "./notice.js";

/**
 * Determine whether a phase's session must run inside the issue worktree.
 *
 * Sourced from `phaseRegistry.get(phase).requiresWorktree` — replaces the
 * previous hardcoded `ISOLATED_PHASES` array. Phases must:
 * 1. Read/modify worktree code
 * 2. Resume a session from the same cwd it was created in (SDK constraint)
 */
function phaseRequiresWorktree(phase: Phase): boolean {
  return phaseRegistry.has(phase)
    ? phaseRegistry.get(phase).requiresWorktree
    : false;
}

/**
 * Cold-start retry threshold in seconds.
 * Failures under this duration are likely Claude Code subprocess initialization
 * issues rather than genuine phase failures (based on empirical data: cold-start
 * failures consistently complete in 15-39s vs 150-310s for real work).
 */
const COLD_START_THRESHOLD_SECONDS = 60;
const COLD_START_MAX_RETRIES = 2;

/**
 * Leading + trailing throttle. Fires the wrapped callback immediately on the
 * first call, drops subsequent calls that arrive inside `intervalMs` but
 * remembers the latest payload, and fires one final "trailing" call with that
 * latest payload after the window closes. Used to bridge the agent driver's
 * fine-grained `onOutput` stream (#543) to the TUI's `nowLine` without
 * either burning the 10 Hz snapshot budget on every chunk or losing the last
 * useful chunk before the agent goes idle.
 *
 * `cancel()` clears the pending timer + payload — call after the consuming
 * phase finishes so a residual trailing fire doesn't outlive its phase
 * context. (The orchestrator's stale-phase guard catches it anyway, but
 * cleanup avoids holding even a no-op timer.)
 *
 * @internal Exported for testing only.
 */
export function createThrottledReporter(
  fn: (text: string) => void,
  intervalMs: number,
): { report(text: string): void; cancel(): void } {
  let timer: NodeJS.Timeout | null = null;
  let pending: string | null = null;
  const report = (text: string): void => {
    if (timer) {
      // Inside the throttle window — stash the latest payload for the
      // trailing fire and drop this call.
      pending = text;
      return;
    }
    fn(text);
    timer = setTimeout(() => {
      const trailing = pending;
      pending = null;
      timer = null;
      if (trailing !== null) report(trailing);
    }, intervalMs);
    timer.unref?.();
  };
  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return { report, cancel };
}

/**
 * Spec-specific retry configuration. Sourced from the phase registry's
 * `retryStrategy` field — `phase-registry.ts` is the source of truth.
 *
 * Spec failures have a higher failure rate (~8.6%) than other phases due to
 * transient GitHub API issues and rate limits. One extra retry with backoff
 * recovers most of these without user intervention.
 *
 * Fallback literals (5000 / 1) match the legacy hardcoded values and only
 * fire if the spec registration is removed or its `retryStrategy` is unset,
 * which would be a misconfiguration. Tests pin these at 5000 / 1, so any
 * drift surfaces immediately.
 */
const SPEC_RETRY_STRATEGY = phaseRegistry.get("spec").retryStrategy;
/** @internal Exported for testing only */
export const SPEC_RETRY_BACKOFF_MS = SPEC_RETRY_STRATEGY?.backoffMs ?? 5000;
/** @internal Exported for testing only */
export const SPEC_EXTRA_RETRIES = SPEC_RETRY_STRATEGY?.extraRetries ?? 1;

/**
 * A rate limit whose window resets further out than this is treated as
 * exhausted rather than transient (#761 AC-2): no retry can succeed inside a
 * closed window, so consuming cold-start retries (each burning up to a full
 * `phaseTimeout`) only delays the labeled halt. Five minutes comfortably
 * exceeds any backoff this executor performs while staying far below the
 * five-hour/seven-day windows the check exists to catch.
 *
 * @internal Exported for testing only
 */
export const RATE_LIMIT_WINDOW_SKIP_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Base backoff for transient rate-limit retries (#761 AC-4), doubled per
 * attempt (5s, 10s). Same scale as `SPEC_RETRY_BACKOFF_MS` — long enough to
 * outlive a momentary throttle, short enough to be negligible next to a
 * phase's runtime.
 *
 * @internal Exported for testing only
 */
export const RATE_LIMIT_RETRY_BACKOFF_MS = 5000;

/**
 * True when a failure is a rate limit whose reset lies beyond
 * {@link RATE_LIMIT_WINDOW_SKIP_THRESHOLD_MS} — i.e. window exhaustion, not a
 * transient throttle. Metadata-absent rate limits (the assistant-error channel
 * carries no `resetsAt`, see #761 AC-9) return false and fall through to the
 * transient path: with no timing signal, retry-with-backoff is the safe
 * default, skipping all retries is not.
 *
 * @internal Exported for testing only
 */
export function isWindowExhaustedRateLimit(
  error: SequantError | undefined,
  now: number = Date.now(),
): boolean {
  if (!(error instanceof RateLimitError)) return false;
  const resetsAt = error.metadata.resetsAt;
  if (typeof resetsAt !== "number") return false;
  return resetsAtToMs(resetsAt) - now > RATE_LIMIT_WINDOW_SKIP_THRESHOLD_MS;
}

/**
 * Buffer added to a rate-limit reset before waking (#804 AC-5). `resetsAt` is a
 * floor, not an exact moment: clock skew between this host and the API, plus
 * server-side rounding, otherwise produce an immediate second rejection on
 * wake. One minute is negligible against the five-hour/seven-day windows this
 * exists for.
 *
 * @internal Exported for testing only
 */
export const AUTO_WAIT_BUFFER_MS = 60 * 1000;

/**
 * Hard cap on auto-waits per issue (#804 AC-6), independent of the minutes
 * budget. A window that is still closed on wake must not produce an unbounded
 * pause loop, so the count bounds the *number* of pauses while
 * `autoWaitMinutes` bounds their *total duration*. Either bound being spent
 * halts with today's labeled message.
 *
 * @internal Exported for testing only
 */
export const AUTO_WAIT_MAX_WAITS = 2;

/**
 * Granularity of the auto-wait sleep (#804 AC-7). The wait is performed as a
 * series of ticks rather than one multi-hour `delayFn` call so that (a) the
 * renderer/heartbeat can be refreshed with the remaining time, and (b) a
 * Ctrl-C is observed promptly instead of at the wake time.
 *
 * @internal Exported for testing only
 */
export const AUTO_WAIT_TICK_MS = 15 * 1000;

/**
 * Mutable per-issue accounting for auto-wait (#804 AC-6).
 *
 * Deliberately per-ISSUE, not per-phase: `executePhaseWithRetry` runs once per
 * phase, so a ledger created inside it would grant every phase its own full
 * budget and bound. `runIssueWithLogging` creates one and threads it through
 * all of an issue's phases.
 */
export interface AutoWaitLedger {
  /** Total wait budget in ms. `0` disables auto-wait entirely. */
  budgetMs: number;
  /** Number of waits already granted for this issue. */
  waits: number;
  /** Cumulative ms already spent waiting for this issue. */
  spentMs: number;
}

/**
 * Build a fresh ledger from a minutes budget. A missing, negative or
 * non-finite budget yields a disabled ledger (`budgetMs: 0`) — the default,
 * which preserves pre-#804 behavior exactly.
 */
export function createAutoWaitLedger(budgetMinutes?: number): AutoWaitLedger {
  const minutes =
    typeof budgetMinutes === "number" && Number.isFinite(budgetMinutes)
      ? Math.max(0, budgetMinutes)
      : 0;
  return { budgetMs: minutes * 60 * 1000, waits: 0, spentMs: 0 };
}

/**
 * A granted auto-wait: how long to sleep, when to wake, and the narrowed
 * rate-limit error that justified it (carried so callers need no cast).
 */
export interface AutoWaitDecision {
  /** Ms to sleep. Always > 0. */
  waitMs: number;
  /** Epoch ms to wake at — `resetsAt` normalized to ms, plus the buffer. */
  wakeAtMs: number;
  /** The rate limit that triggered the wait. Never a `BillingError`. */
  error: RateLimitError;
}

/**
 * Decide whether to wait out an exhausted rate-limit window (#804 AC-3).
 *
 * Deliberately separate from {@link isWindowExhaustedRateLimit} and
 * {@link RATE_LIMIT_WINDOW_SKIP_THRESHOLD_MS}, which answer *"is this transient
 * or exhausted?"*. This answers a different question — *"am I willing to wait
 * that long?"* — and fires ONLY once the former is already true. Keeping them
 * apart is what leaves `autoWaitMinutes` the single user-facing dial for the
 * wait-vs-halt outcome.
 *
 * Returns `null` (no wait — halt as before) when:
 * - auto-wait is off, or the per-issue wait count is spent;
 * - the failure is not a window-exhausted `RateLimitError`. A `BillingError`
 *   lands here: it is a sibling class, not a subclass, so the `instanceof`
 *   check inside `isWindowExhaustedRateLimit` excludes it. That is load-bearing
 *   — a `BillingError` may still carry `resetsAt` (an explicit
 *   `credits_required`, or a window that has already passed — see the #860
 *   narrowing in `isBillingFailure`), so gating on the timestamp's presence
 *   instead of the error type would wait out a credits failure that no amount
 *   of waiting can heal (AC-4). Since #860, a *live* recognized window
 *   (`five_hour`/`seven_day*` + future reset) classifies as `RateLimitError`
 *   upstream even when `out_of_credits` is present, which is what lets the
 *   real captured subscription payloads reach this decision at all;
 * - the reset has already passed (nothing to wait for);
 * - the required wait exceeds the budget REMAINING, not the total (AC-6).
 *
 * @internal Exported for testing only
 */
export function shouldAutoWaitForReset(
  error: SequantError | undefined,
  ledger: AutoWaitLedger,
  now: number = Date.now(),
): AutoWaitDecision | null {
  if (ledger.budgetMs <= 0) return null;
  if (ledger.waits >= AUTO_WAIT_MAX_WAITS) return null;

  // These two guards duplicate checks inside `isWindowExhaustedRateLimit`, and
  // that duplication is deliberate: TypeScript cannot narrow through a boolean
  // helper, so without them the lines below need `as RateLimitError` /
  // `as number` casts. Real narrowing beats a cast in the one function that
  // decides whether to pause a run for hours. The classifier below still owns
  // the "transient or exhausted?" question (AC-3) — these only prove types.
  if (!(error instanceof RateLimitError)) return null;
  const resetsAt = error.metadata.resetsAt;
  if (typeof resetsAt !== "number") return null;

  if (!isWindowExhaustedRateLimit(error, now)) return null;

  // All arithmetic stays in epoch ms (AC-5) — resetsAtToMs first, buffer
  // after, formatting only ever for display.
  const wakeAtMs = resetsAtToMs(resetsAt) + AUTO_WAIT_BUFFER_MS;
  const waitMs = wakeAtMs - now;
  if (waitMs <= 0) return null;

  const remainingMs = ledger.budgetMs - ledger.spentMs;
  if (waitMs > remainingMs) return null;

  // Carry the narrowed error forward so callers don't have to re-cast it.
  return { waitMs, wakeAtMs, error };
}

/**
 * Sleep until an auto-wait's wake time, in ticks (#804 AC-7).
 *
 * Chunking the sleep is what makes a multi-hour pause survivable:
 * - `onTick` refreshes the live display so the wait is visible rather than a
 *   silent stall (the #574 complaint at 60x scale);
 * - each tick races the injected `delayFn` against the abort signal, so Ctrl-C
 *   returns immediately instead of blocking until the wake.
 *
 * Reuses the caller's `delayFn` so the wait stays fully test-injectable.
 *
 * Returns the ms actually slept and whether the wait was aborted.
 *
 * @internal Exported for testing only
 */
export async function waitForWindowReset(
  waitMs: number,
  options: {
    delayFn: (ms: number) => Promise<void>;
    signal?: AbortSignal;
    onTick?: (remainingMs: number) => void;
    now?: () => number;
    tickMs?: number;
  },
): Promise<{ sleptMs: number; aborted: boolean }> {
  const { delayFn, signal, onTick } = options;
  const now = options.now ?? Date.now;
  const tickMs = options.tickMs ?? AUTO_WAIT_TICK_MS;

  const startedAt = now();
  const deadline = startedAt + waitMs;

  // Two independent notions of "how much is left", and the loop honors
  // whichever expires first:
  //   - `budgetLeft` counts down by the slices actually requested. This is what
  //     terminates the loop, and it does so after a fixed number of iterations
  //     regardless of what the clock does — without it, an injected delayFn
  //     that resolves instantly (every test) would spin against the wall clock
  //     until the real reset time arrived.
  //   - the `deadline` check ends the wait early when real time has outrun the
  //     slices, e.g. a laptop resumed from sleep mid-wait.
  let budgetLeft = waitMs;
  let sleptMs = 0;

  // ONE abort listener for the whole wait, not one per tick. A 5-hour wait is
  // ~1200 ticks; registering inside the loop would pile up that many listeners
  // (and as many pending promises) on a single signal, tripping Node's
  // max-listeners warning and leaking until the wait ended.
  const abortPromise = signal
    ? new Promise<boolean>((resolve) => {
        signal.addEventListener("abort", () => resolve(true), { once: true });
      })
    : null;

  for (;;) {
    if (signal?.aborted) {
      return { sleptMs: Math.max(sleptMs, now() - startedAt), aborted: true };
    }

    const clockLeft = deadline - now();
    const remainingMs = Math.min(budgetLeft, clockLeft);
    if (remainingMs <= 0) break;

    onTick?.(remainingMs);

    const sliceMs = Math.min(tickMs, remainingMs);
    budgetLeft -= sliceMs;
    sleptMs += sliceMs;

    // The injected delayFn exposes no timer handle, so an in-flight slice
    // cannot be cleared on abort. Racing bounds the *observed* Ctrl-C latency
    // to ~0 regardless; only the orphaned timer runs on, and it is one tick
    // long, not one window long.
    if (abortPromise) {
      const aborted = await Promise.race([
        delayFn(sliceMs).then(() => false),
        abortPromise,
      ]);
      if (aborted) {
        // This slice never completed — don't bill the ledger for it.
        sleptMs -= sliceMs;
        return { sleptMs: Math.max(sleptMs, now() - startedAt), aborted: true };
      }
    } else {
      await delayFn(sliceMs);
    }
  }

  return {
    sleptMs: Math.max(sleptMs, now() - startedAt),
    aborted: signal?.aborted === true,
  };
}

/**
 * Run one granted auto-wait end to end (#804): emit the live notices, sleep,
 * update the ledger, and report whether Ctrl-C interrupted it.
 *
 * Shared by both arms of the retry ladder (the cold-start loop and the
 * `skipColdStartRetry` single-attempt path) so the two cannot drift on
 * bookkeeping or messaging.
 *
 * @internal Exported for testing only
 */
export async function performAutoWait(
  issueNumber: number,
  phase: Phase,
  config: ExecutionConfig,
  decision: AutoWaitDecision,
  ledger: AutoWaitLedger,
  delayFn: (ms: number) => Promise<void>,
  shutdownManager?: ShutdownManager,
  spinner?: PhasePauseHandle,
): Promise<{ aborted: boolean }> {
  // Count the wait BEFORE sleeping. If the process dies mid-wait the ledger is
  // gone anyway, but an exception on the sleep path must not hand back a free
  // retry — the bound exists to stop unbounded pause loops.
  ledger.waits += 1;

  // AC-5: reuse the driver's own formatter for the cause rather than
  // re-deriving a timestamp, and render the wake time (a distinct value —
  // reset plus buffer) through the same `formatResetTime` convention.
  const cause = formatRateLimitMessage(decision.error.metadata);
  const wakeLabel = formatResetTime(decision.wakeAtMs);
  const header = `${cause} · auto-wait ${ledger.waits}/${AUTO_WAIT_MAX_WAITS} — resuming at ${wakeLabel}`;

  bracketedConsoleLog(
    spinner,
    chalk.yellow(
      `\n    ⏸ ${header} (${formatElapsedTime(decision.waitMs / 1000)})`,
    ),
  );

  const emit = (remainingMs: number, done: boolean) => {
    try {
      config.onAutoWait?.({
        issueNumber,
        phase,
        wakeAtMs: decision.wakeAtMs,
        remainingMs,
        message: done
          ? `${cause} · auto-wait complete`
          : `${header} · ${formatElapsedTime(remainingMs / 1000)} left`,
        done,
      });
    } catch {
      // Liveness notices must never disrupt the run.
    }
  };

  // AC-7: a registered controller is aborted by ShutdownManager on SIGINT, so
  // Ctrl-C ends the wait instead of blocking until the wake.
  const controller = new AbortController();
  shutdownManager?.addAbortController(controller);
  try {
    const { sleptMs, aborted } = await waitForWindowReset(decision.waitMs, {
      delayFn,
      signal: controller.signal,
      onTick: (remainingMs) => emit(remainingMs, false),
    });
    ledger.spentMs += sleptMs;
    emit(0, true);

    if (aborted) {
      bracketedConsoleLog(
        spinner,
        chalk.yellow(`    ✕ Auto-wait interrupted — halting`),
      );
    }
    return { aborted };
  } finally {
    shutdownManager?.removeAbortController(controller);
  }
}

export function parseQaVerdict(output: string): QaVerdict | null {
  if (!output) return null;

  // Match various verdict formats:
  // - "### Verdict: X" (markdown header)
  // - "**Verdict:** X" (bold label with colon inside)
  // - "**Verdict:** **X**" (bold label and bold value)
  // - "Verdict: X" (plain)
  // - "Verdict: ✅ X" (emoji-prefixed value — QA agents commonly write this)
  // The gap between "Verdict:" and the token tolerates any run of
  // non-alphanumeric characters (emoji, ✅/❌/⚠️, asterisks, whitespace). A
  // negated ASCII class (not an emoji literal class) keeps this ReDoS-safe and
  // avoids the no-misleading-character-class lint, matching parseQaSummary's
  // approach below. Without this, `Verdict: ✅ READY_FOR_MERGE` parsed as null
  // and a genuine PASS was recorded as "completed without a parseable verdict"
  // (live repro: `sequant run 687 --phases exec,qa`, 2026-06-01).
  // Case insensitive, handles optional markdown formatting.
  const verdictMatch = output.match(
    /(?:###?\s*)?(?:\*\*)?Verdict:?[^A-Za-z0-9_]*(READY_FOR_MERGE|AC_MET_BUT_NOT_A_PLUS|AC_NOT_MET|NEEDS_VERIFICATION)\*?\*?/i,
  );

  if (!verdictMatch) return null;

  // Normalize to uppercase with underscores
  const verdict = verdictMatch[1].toUpperCase().replace(/-/g, "_") as QaVerdict;
  return verdict;
}

/**
 * Deferral/continuation markers that signal a QA agent ended its turn intending
 * to continue *later* — as if a subsequent turn or a background poll were
 * available to it. Seeded from the #853 live repro, whose QA turn deferred to a
 * background CI poll and "the completion notification" instead of emitting a
 * verdict. Matched as lowercased literal substrings (ReDoS-safe) against the
 * output tail only.
 *
 * The second group covers deferral-to-*user* phrasing, observed by running the
 * detector against every `qa` phase output in 99 real `.sequant/logs` runs: a
 * turn that ended "this needs a decision from you … Tell me which one and I'll
 * execute it" (run-2026-06-06) is the same one-shot violation with the wait
 * pointed at a human instead of a poll. Structural alternatives were tried
 * against the same corpus and rejected: 19/45 outputs with a *parseable*
 * verdict have no `Verdict`-labelled line at all, so label-presence cannot
 * discriminate — a literal marker list is the shape that works here.
 */
const QA_DEFERRAL_MARKERS = [
  "i'll pick this up",
  "pick this up on the completion",
  "completion notification",
  "background poll",
  "when the background",
  "when ci ",
  "later turn",
  "i'll invoke",
  // Deferral-to-user (corpus-observed, run-2026-06-06T03-33-20):
  "needs a decision from you",
  "tell me which",
  "let me know which",
  "tell me and i'll",
] as const;

/**
 * Distinguish a QA turn that produced *no verdict at all* from one whose output
 * was present but unparseable (#853). Returns true when the output is empty /
 * whitespace, or when its tail contains deferral language — the agent treating
 * its one-shot phase as if a later turn were available.
 *
 * Both cases are hard failures either way; this only refines which message is
 * emitted, so a false positive is harmless (it swaps one failing message for
 * another). Kept deliberately conservative and literal to stay ReDoS-safe.
 *
 * @internal Exported for testing only.
 */
export function endedWithoutVerdict(output: string | undefined): boolean {
  if (!output || output.trim().length === 0) return true;
  // Scan the tail only: deferral language lives at the end of the turn, where
  // the agent signs off planning to continue. A larger window would also catch
  // a mid-review aside that says "later" without deferring the whole turn.
  const tail = output.slice(-2000).toLowerCase();
  return QA_DEFERRAL_MARKERS.some((marker) => tail.includes(marker));
}

/**
 * Parse condensed QA summary from QA phase output (#434).
 *
 * Handles multiple AC table formats produced by the QA skill:
 * - 5-column: | AC-N | source | desc | STATUS | notes |
 * - 4-column: | AC-N | desc | STATUS | notes |
 * - 3-column: | AC-N | desc | STATUS |
 *
 * Status cells may contain emoji prefixes (✅ MET), shorthand
 * (PARTIAL), or trailing text (MET — explanation).
 *
 * @internal Exported for testing only
 */
export function parseQaSummary(output: string): QaSummary | null {
  if (!output) return null;

  // Anchored pattern: cell content starts with optional emoji, then status keyword
  // Uses alternation (not character class) to avoid ESLint no-misleading-character-class
  const STATUS_CELL =
    /^(?:\u2705|\u274C|\u26A0\uFE0F|\u2B50|\u2139\uFE0F|\u2753|\u2757)?\s*(MET|NOT_MET|PARTIALLY_MET|PARTIAL|PENDING|N\/A)\b/i;

  const lines = output.split("\n");
  const acRows = lines.filter((line) => /^\s*\|\s*\*?\*?AC-\d+/.test(line));

  if (acRows.length === 0) return null;

  let acMet = 0;
  let acTotal = 0;

  for (const row of acRows) {
    const cells = row
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);

    // Scan cells right-to-left to find the status cell
    let found = false;
    for (let i = cells.length - 1; i >= 1; i--) {
      const match = cells[i].match(STATUS_CELL);
      if (match) {
        const status = match[1].toUpperCase();
        acTotal++;
        if (status === "MET") acMet++;
        found = true;
        break;
      }
    }
    // Row with AC-N but no parseable status is skipped
    if (!found) continue;
  }

  if (acTotal === 0) return null;

  const gaps = parseListSection(output, /\*\*(?:Issues|Gaps)/);
  const suggestions = parseListSection(output, /\*\*Suggestions/);

  return { acMet, acTotal, gaps, suggestions };
}

/**
 * Parse a markdown bullet list section, filtering out "None" variants.
 */
function parseListSection(output: string, headerPattern: RegExp): string[] {
  const items: string[] = [];
  const lines = output.split("\n");

  let inSection = false;
  for (const line of lines) {
    if (headerPattern.test(line)) {
      // If the header line itself contains a bullet (inline), capture it
      inSection = true;
      continue;
    }

    if (inSection) {
      // Section ends at next markdown header or bold label
      if (/^#{1,4}\s/.test(line) || /^\*\*[^*]+\*\*:/.test(line)) {
        break;
      }

      const bulletMatch = line.match(/^\s*[-*]\s+(.+)/);
      if (bulletMatch) {
        const trimmed = bulletMatch[1].trim();
        // Filter "None", "None found", "None — text", etc.
        if (trimmed && !/^None\b/i.test(trimmed)) {
          items.push(trimmed);
        }
      } else if (line.trim() === "") {
        continue;
      } else {
        break;
      }
    }
  }

  return items;
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs.toFixed(0)}s`;
}

/**
 * Resolve the base ref the zero-diff guard should compare against for
 * this worktree.
 *
 * Reads `branch.<current>.sequantBase` — written by `scripts/new-feature.sh`
 * when a worktree is created with `--base <branch>`. Returns `origin/<base>`
 * (prepending `origin/` only when the recorded value does not already
 * reference a remote). Falls back to `"origin/main"` on missing config,
 * missing branch, or any git error — preserves the pre-#537 behavior
 * for worktrees that predate this change or are managed outside
 * `new-feature.sh`.
 *
 * Uses `execFileSync` (not `execSync`) so argv is passed directly to
 * `execve` without shell interpretation — the recorded value originates
 * from the user-supplied `--base` CLI flag, and shell-interpolating it
 * would open a shell-injection vector. With `execFileSync`, a malicious
 * value is at worst treated as an invalid revspec by git (triggering
 * the fail-open path), never executed as shell.
 *
 * @internal Exported for testing only.
 */
export function resolveBaseRef(cwd: string): string {
  const fallback = "origin/main";
  let branch: string;
  try {
    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdio: "pipe",
    })
      .toString()
      .trim();
  } catch {
    return fallback;
  }
  // Guard against multi-line output (paranoid — should never happen) and
  // the detached-HEAD case where we have no recorded base to look up.
  if (!branch || branch === "HEAD" || branch.includes("\n")) return fallback;
  let recorded: string;
  try {
    recorded = execFileSync(
      "git",
      ["config", "--get", `branch.${branch}.sequantBase`],
      { cwd, stdio: "pipe" },
    )
      .toString()
      .trim();
  } catch {
    return fallback;
  }
  if (!recorded || recorded.includes("\n")) return fallback;
  return recorded.startsWith("origin/") ? recorded : `origin/${recorded}`;
}

/**
 * Three-way classification of what the exec phase left in the worktree (#879).
 *
 * - `commits`: HEAD has commits unique to it relative to the base ref — real,
 *   deliverable work that can rebase, push, and become a PR.
 * - `uncommitted`: no such commits, but the tree is dirty. This is NOT a
 *   deliverable: uncommitted work cannot rebase, push, or become a PR (#879's
 *   defect — a dirty tree used to be counted as exec success, producing a run
 *   that "passed" with no commits and no PR). `paths` names the dirty files.
 * - `none`: no commits and a clean tree — exec produced literally nothing
 *   (#534's original empty-branch class).
 * - `unknown`: a git command failed. Callers fail OPEN on this (treat as work)
 *   — a transient git error is better diagnosed as a real run than as a
 *   spurious phase failure on every exec.
 */
export type ExecChangeState =
  | { kind: "commits" }
  | { kind: "uncommitted"; paths: string[] }
  | { kind: "none" }
  | { kind: "unknown" };

/**
 * Parse the file paths out of `git status --porcelain` (v1) output. Each line
 * is `XY <path>` (two status chars + a space); renames are `R  <old> -> <new>`,
 * for which we name the new path.
 */
function parsePorcelainPaths(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0)
    .map((line) => {
      const rest = line.slice(3);
      const arrow = rest.indexOf(" -> ");
      return arrow >= 0 ? rest.slice(arrow + 4) : rest;
    });
}

/**
 * Classify what the exec phase produced in the worktree (#879).
 *
 * Uses `git rev-list --count <base>..HEAD` (commits reachable from HEAD but not
 * the base) instead of `git diff <base>..HEAD`, because the two-dot diff also
 * fires in reverse when the base has advanced past HEAD — on stale branches
 * that would falsely report "has commits" even when exec produced nothing,
 * reintroducing the bug #534 is fixing.
 *
 * The base ref defaults to `origin/main` but is overridden to the worktree's
 * recorded base (see #537) so zero-diff execs are still detected on custom-base
 * worktrees (e.g. those created with `--base feature/epic`).
 *
 * Read-only: runs only `git rev-list` and `git status --porcelain`, so it never
 * mutates the worktree — an exec phase that fails on an `uncommitted` result
 * leaves the dirty files exactly where the agent left them (#879 AC-3).
 *
 * @internal Exported for testing only.
 */
export function classifyExecChanges(cwd: string): ExecChangeState {
  const baseRef = resolveBaseRef(cwd);
  let commitsAhead: boolean;
  try {
    const count = execFileSync(
      "git",
      ["rev-list", "--count", `${baseRef}..HEAD`],
      { cwd, stdio: "pipe" },
    )
      .toString()
      .trim();
    commitsAhead = Number.parseInt(count, 10) > 0;
  } catch {
    return { kind: "unknown" };
  }
  if (commitsAhead) return { kind: "commits" };
  try {
    // `--untracked-files=all` lists each new file individually rather than
    // collapsing a wholly-untracked directory to its top-level path — so the
    // #879 failure message names the actual files the agent left behind (AC-2).
    const porcelain = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd, stdio: "pipe" },
    ).toString();
    const paths = parsePorcelainPaths(porcelain);
    return paths.length > 0 ? { kind: "uncommitted", paths } : { kind: "none" };
  } catch {
    return { kind: "unknown" };
  }
}

/**
 * Check whether the exec phase produced deliverable work in the worktree.
 *
 * Thin boolean wrapper over {@link classifyExecChanges}: only `commits` (real
 * work) and `unknown` (git error — fail open) count as "has changes". Note the
 * #879 behaviour change: an `uncommitted`-only tree now returns **false**, since
 * uncommitted work is not a deliverable. Both callers (the exec guard in
 * {@link mapAgentSuccessToPhaseResult} and the ready gate) want this stricter
 * semantics.
 *
 * @internal Exported for testing only.
 */
export function hasExecChanges(cwd: string): boolean {
  const { kind } = classifyExecChanges(cwd);
  return kind === "commits" || kind === "unknown";
}

/** Cap on how many dirty paths the #879 exec-failure message lists inline. */
const MAX_UNCOMMITTED_PATHS_LISTED = 20;

/**
 * Build the exec-failure message for an `uncommitted`-only worktree (#879 AC-2).
 * Names the dirty paths so the work is discoverable from the run log alone,
 * capped at {@link MAX_UNCOMMITTED_PATHS_LISTED} to keep the log bounded.
 */
function formatUncommittedExecError(paths: string[], cwd: string): string {
  const listed = paths.slice(0, MAX_UNCOMMITTED_PATHS_LISTED);
  const remainder = paths.length - listed.length;
  const suffix = remainder > 0 ? `, … and ${remainder} more` : "";
  return (
    `exec left ${paths.length} file(s) uncommitted and made no commits — ` +
    `uncommitted work cannot rebase, push, or become a PR. The work is ` +
    `preserved in ${cwd}: ${listed.join(", ")}${suffix}`
  );
}

/**
 * Map a successful AgentPhaseResult to a PhaseResult, applying phase-specific
 * guards that catch agent sessions which returned success without producing
 * usable work (#534):
 *
 * - `qa`: fails when no parseable verdict is found (empty or malformed output).
 * - `exec`: fails when no commits and no uncommitted changes exist.
 *
 * @internal Exported for testing only.
 */
export function mapAgentSuccessToPhaseResult(
  phase: Phase,
  agentResult: AgentPhaseResult,
  durationSeconds: number,
  cwd: string,
): PhaseResult & { sessionId?: string; resumeHandle?: ResumeHandle } {
  const tails = {
    stderrTail: agentResult.stderrTail,
    stdoutTail: agentResult.stdoutTail,
    exitCode: agentResult.exitCode,
  };
  const resume = {
    sessionId: agentResult.sessionId,
    resumeHandle: agentResult.resumeHandle,
  };

  if (phase === "qa") {
    const verdict = agentResult.output
      ? parseQaVerdict(agentResult.output)
      : null;
    const summary = agentResult.output
      ? (parseQaSummary(agentResult.output) ?? undefined)
      : undefined;
    if (verdict === "AC_NOT_MET") {
      // #749: only AC_NOT_MET (and the null branch below, #534) hard-fails.
      // AC_MET_BUT_NOT_A_PLUS is a stopping/ready state — it must break to PR,
      // not feed the quality loop (mirrors ready-gate.ts's `ac` policy). The
      // verdict is retained on the success result so the PR/log surfaces the
      // "not A+" note.
      return {
        phase,
        success: false,
        durationSeconds,
        error: `QA verdict: ${verdict}`,
        ...resume,
        output: agentResult.output,
        verdict,
        summary,
        ...tails,
      };
    }
    if (!verdict) {
      // #534: a null verdict is not success. #853 splits this into two classes
      // so the message is not misleading. A turn that deferred to a later turn
      // (or produced no output) never emitted a verdict — reporting that as
      // "unparseable" sends a debugger to inspect a verdict regex that was
      // never the problem. Both remain hard failures (`success:false`); only
      // the message differs.
      const error = endedWithoutVerdict(agentResult.output)
        ? "QA ended without producing a verdict — the phase is one-shot; the agent deferred to a later turn or emitted no output"
        : "QA completed without a parseable verdict";
      return {
        phase,
        success: false,
        durationSeconds,
        error,
        ...resume,
        output: agentResult.output,
        summary,
        ...tails,
      };
    }
    return {
      phase,
      success: true,
      durationSeconds,
      ...resume,
      output: agentResult.output,
      verdict,
      summary,
      ...tails,
    };
  }

  if (phase === "exec") {
    // #534/#879: an exec phase that produced no deliverable commits is not
    // success. Two distinct non-deliverable states, each with its own message:
    //   - `none`: literally nothing (#534's empty-branch class).
    //   - `uncommitted`: a dirty tree with no commits — used to be counted as
    //     success (#879), but it cannot rebase, push, or become a PR. Failing
    //     here (rather than auto-committing) preserves the work in place; the
    //     message names the paths so it is discoverable from the run log alone.
    // `commits`/`unknown` fall through to success (unknown fails open).
    const changes = classifyExecChanges(cwd);
    if (changes.kind === "none") {
      return {
        phase,
        success: false,
        durationSeconds,
        error: "exec produced no changes (no commits, no uncommitted work)",
        ...resume,
        output: agentResult.output,
        ...tails,
      };
    }
    if (changes.kind === "uncommitted") {
      return {
        phase,
        success: false,
        durationSeconds,
        error: formatUncommittedExecError(changes.paths, cwd),
        ...resume,
        output: agentResult.output,
        ...tails,
      };
    }
  }

  return {
    phase,
    success: true,
    durationSeconds,
    ...resume,
    output: agentResult.output,
    ...tails,
  };
}

/**
 * Map a failed driver result to a `PhaseResult`.
 *
 * Symmetric to {@link mapAgentSuccessToPhaseResult}; extracted so the
 * failure-path mapping (notably the #739 capped/output gating) is unit-testable
 * without spawning a driver.
 *
 * `output` is propagated **only** for a capped phase (#739): a capped result is
 * incomplete-but-not-hard-failed, so its partial work must survive downstream.
 * A genuine (non-capped) failure keeps the historical behaviour of dropping
 * `output`, leaving the `/loop` fix-context (`formatFailureContext`) unchanged.
 *
 * @internal Exported for testing only
 */
export function mapAgentFailureToPhaseResult(
  phase: Phase,
  agentResult: AgentPhaseResult,
  durationSeconds: number,
): PhaseResult & { sessionId?: string; resumeHandle?: ResumeHandle } {
  return {
    phase,
    success: false,
    durationSeconds,
    error: agentResult.error,
    // Propagate the driver's typed cause (#732) so the retry logic can prefer
    // it over stderr-regex classification and gate the MCP fallback.
    structuredError: agentResult.structuredError,
    // Propagate the turn-cap flag and the partial output (#739). On the failure
    // path `output` was previously dropped entirely — for a capped phase the
    // partial work is usable and must be preserved, mirroring the driver/skill
    // slice from #733. Gating `output` on `capped` keeps non-capped failures
    // byte-for-byte identical to pre-#739 behaviour.
    capped: agentResult.capped,
    output: agentResult.capped ? agentResult.output : undefined,
    sessionId: agentResult.sessionId,
    resumeHandle: agentResult.resumeHandle,
    stderrTail: agentResult.stderrTail,
    stdoutTail: agentResult.stdoutTail,
    exitCode: agentResult.exitCode,
  };
}

/**
 * Get the prompt for a phase with the issue number substituted.
 * Selects self-contained prompts for non-Claude agents.
 * Includes AGENTS.md content as context so non-Claude agents
 * receive project conventions and workflow instructions.
 *
 * @internal Exported for testing only
 */
export async function getPhasePrompt(
  phase: Phase,
  issueNumber: number,
  agent?: string,
  promptContext?: string,
): Promise<string> {
  const definition = phaseRegistry.get(phase);
  // Non-claude drivers consult driverOverrides[<driver>] first; fall back to
  // the default promptTemplate when no override is registered for the driver.
  const driverPrompt =
    agent && agent !== "claude-code"
      ? definition.driverOverrides?.[agent]?.promptTemplate
      : undefined;
  const template = driverPrompt ?? definition.promptTemplate;
  let basePrompt = template.replace(/\{issue\}/g, String(issueNumber));

  // Append phase-specific context (e.g., QA findings for loop phase)
  if (promptContext) {
    basePrompt += `\n\n---\n\n${promptContext}`;
  }

  // Include AGENTS.md content in the prompt context for non-Claude agent compatibility.
  // Claude reads CLAUDE.md natively, but other agents (Aider, Codex, Gemini CLI)
  // rely on AGENTS.md for project context.
  const agentsMd = await readAgentsMd();
  if (agentsMd) {
    return `Project context (from AGENTS.md):\n\n${agentsMd}\n\n---\n\n${basePrompt}`;
  }

  return basePrompt;
}

/**
 * Execute a single phase for an issue using the configured AgentDriver.
 */
async function executePhase(
  issueNumber: number,
  phase: Phase,
  config: ExecutionConfig,
  resumeHandle?: ResumeHandle,
  worktreePath?: string,
  shutdownManager?: ShutdownManager,
  spinner?: PhasePauseHandle,
): Promise<PhaseResult & { sessionId?: string; resumeHandle?: ResumeHandle }> {
  const startTime = Date.now();

  const prompt = await getPhasePrompt(
    phase,
    issueNumber,
    config.agent,
    config.promptContext,
  );

  if (config.dryRun) {
    // Dry run - show the prompt that would be sent, then return
    if (config.verbose) {
      bracketedConsoleLog(
        spinner,
        chalk.gray(`    Would execute: /${phase} ${issueNumber}`),
      );
      bracketedConsoleLog(spinner, chalk.gray(`    Prompt: ${prompt}`));
    }
    return {
      phase,
      success: true,
      durationSeconds: 0,
      output: prompt,
    };
  }

  if (config.verbose) {
    bracketedConsoleLog(spinner, chalk.gray(`    Prompt: ${prompt}`));
    if (worktreePath && phaseRequiresWorktree(phase)) {
      bracketedConsoleLog(spinner, chalk.gray(`    Worktree: ${worktreePath}`));
    }
  }

  // Determine working directory and environment
  const shouldUseWorktree = worktreePath && phaseRequiresWorktree(phase);
  const cwd = shouldUseWorktree ? worktreePath : process.cwd();

  // Resolve file context for file-oriented drivers (e.g., Aider --file)
  let files: string[] | undefined;
  if (config.agent && config.agent !== "claude-code") {
    try {
      const diffBase = resolveDiffBase(cwd, "main");
      const output = execFileSync(
        "git",
        ["diff", "--name-only", `${diffBase}...HEAD`],
        {
          cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      ).trim();
      if (output) {
        files = output.split("\n").filter(Boolean);
      }
    } catch {
      // No changed files or git error — proceed without file context
    }
  }

  // Check if shutdown is in progress
  if (shutdownManager?.shuttingDown) {
    return {
      phase,
      success: false,
      durationSeconds: 0,
      error: "Shutdown in progress",
    };
  }

  // Create abort controller for timeout
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, config.phaseTimeout * 1000);

  // Register abort controller with shutdown manager for graceful shutdown
  // Uses add/remove to support concurrent phase execution (#404)
  if (shutdownManager) {
    shutdownManager.addAbortController(abortController);
  }

  // Build environment with worktree isolation variables
  const env: Record<string, string> = {
    ...process.env,
    CLAUDE_HOOKS_SMART_TESTS: config.noSmartTests ? "false" : "true",
  };

  // Set worktree isolation environment variables
  if (shouldUseWorktree) {
    env.SEQUANT_WORKTREE = worktreePath;
    env.SEQUANT_ISSUE = String(issueNumber);
  }

  // Set orchestration context for skills to detect they're part of a workflow
  // Skills can check these to skip redundant pre-flight checks
  env.SEQUANT_ORCHESTRATOR = "sequant-run";
  env.SEQUANT_PHASE = phase;

  // #683: force full-weight QA. `sequant ready` sets config.fullQa so its QA
  // pass runs the standalone branch-freshness / process-state pre-flight checks
  // even though SEQUANT_ORCHESTRATOR is set unconditionally above. Scoped to the
  // qa phase — the loop/exec phases don't have a git-trust skip to override.
  if (config.fullQa && phase === "qa") {
    env.SEQUANT_FULL_QA = "1";
  }

  // Propagate issue type for skills to adapt behavior (e.g., lighter QA for docs)
  if (config.issueType) {
    env.SEQUANT_ISSUE_TYPE = config.issueType;
  }

  // Pass QA context to loop phase so it doesn't need to reconstruct from GitHub (#488)
  if (config.lastVerdict) {
    env.SEQUANT_LAST_VERDICT = config.lastVerdict;
  }
  if (config.failedAcs) {
    env.SEQUANT_FAILED_ACS = config.failedAcs;
  }

  // Propagate parallel isolation mode to exec skill (#485)
  if (config.isolateParallel) {
    env.SEQUANT_ISOLATE_PARALLEL = "true";
  }

  // Activate interactive relay (#383) unless explicitly disabled.
  // `relay-check.sh` (sourced from post-tool.sh) reads this env var on every
  // tool call. Disabled by default in non-interactive scenarios — controlled
  // via `settings.run.relay` (true by default).
  if (config.relayEnabled) {
    env.SEQUANT_RELAY = "true";
    try {
      const { resolveBundledFramePath } =
        await import("../relay/activation.js");
      const framePath = resolveBundledFramePath();
      if (framePath) env.SEQUANT_RELAY_FRAME = framePath;
    } catch {
      /* relay module unavailable — fall back to bash's search heuristic. */
    }
  }

  // Track whether we're actively streaming verbose output
  // Pausing spinner once per streaming session prevents truncation from rapid pause/resume cycles
  // (Issue #283: ora's stop() clears the current line, which can truncate output when
  // pause/resume is called for every chunk in rapid succession)
  let verboseStreamingActive = false;

  // Activity ping throttle (#543): the agent driver streams text in many small
  // chunks; the TUI only polls at 10 Hz. Coalesce to ≤2 calls per ~100ms
  // window (leading + trailing) so we don't burn the poll budget on snapshot
  // churn but still surface the latest chunk before the agent goes idle.
  const ACTIVITY_THROTTLE_MS = 100;
  const onActivity = config.onActivity;
  const throttle = onActivity
    ? createThrottledReporter((text: string) => {
        try {
          onActivity(text);
        } catch {
          // Activity reporting must never disrupt the run.
        }
      }, ACTIVITY_THROTTLE_MS)
    : undefined;
  const reportActivity = throttle ? throttle.report : undefined;

  // Resolve driver before the resume check — eligibility is now driver-owned
  // (#674). Each driver's `canResume(handle, cwd)` enforces its own contract:
  // Claude Code requires byte-equal cwd match (session storage is
  // cwd-namespaced); Aider declines all resume (no session concept); Codex
  // (when added in #497) folds in AGENTS.md parity. Replacing the prior
  // `sessionId && !worktreePath` heuristic also unblocks same-worktree resume
  // across phases.
  const driver: AgentDriver = getDriver(config.agent, {
    aiderSettings: config.aiderSettings,
  });

  const eligibleHandle =
    resumeHandle && driver.canResume(resumeHandle, cwd)
      ? resumeHandle
      : undefined;

  // Build AgentExecutionConfig for the driver
  const agentConfig: AgentExecutionConfig = {
    cwd,
    env,
    abortSignal: abortController.signal,
    phaseTimeout: config.phaseTimeout,
    verbose: config.verbose,
    mcp: config.mcp,
    resumeHandle: eligibleHandle,
    sessionId: eligibleHandle?.token,
    files,
    onOutput:
      config.verbose || reportActivity
        ? (text: string) => {
            if (config.verbose) {
              if (!verboseStreamingActive) {
                spinner?.pause();
                verboseStreamingActive = true;
              }
              // eslint-disable-next-line no-restricted-syntax -- spinner is paused above; verbose subprocess streaming bypasses log-update intentionally.
              process.stdout.write(chalk.gray(text));
            }
            reportActivity?.(text);
          }
        : undefined,
    onStderr: config.verbose
      ? (data: string) => {
          if (!verboseStreamingActive) {
            spinner?.pause();
            verboseStreamingActive = true;
          }
          // eslint-disable-next-line no-restricted-syntax -- spinner is paused above; verbose subprocess streaming bypasses log-update intentionally.
          process.stderr.write(chalk.red(data));
        }
      : undefined,
  };

  const agentResult = await driver.executePhase(prompt, agentConfig);

  // Cancel any pending trailing activity fire — phase is done; the
  // orchestrator's stale-phase guard would no-op a late call anyway, but
  // clearing the timer is cheaper than letting it elapse.
  throttle?.cancel();

  // Resume spinner after execution completes (if we paused it)
  if (verboseStreamingActive) {
    spinner?.resume();
  }

  clearTimeout(timeoutId);

  // Remove this specific abort controller from shutdown manager
  if (shutdownManager) {
    shutdownManager.removeAbortController(abortController);
  }

  const durationSeconds = (Date.now() - startTime) / 1000;

  if (agentResult.success) {
    return mapAgentSuccessToPhaseResult(
      phase,
      agentResult,
      durationSeconds,
      cwd,
    );
  }

  return mapAgentFailureToPhaseResult(phase, agentResult, durationSeconds);
}

/**
 * Execute a phase with automatic retry for cold-start failures and MCP fallback.
 *
 * Retry strategy:
 * 1. If phase fails within COLD_START_THRESHOLD_SECONDS, retry up to COLD_START_MAX_RETRIES times
 * 2. If still failing and MCP is enabled, retry once with MCP disabled (npx-based MCP servers
 *    can fail on first run due to cold-cache issues)
 *
 * The MCP fallback is safe because MCP servers are optional enhancements, not required
 * for core functionality.
 */
/**
 * @internal Exported for testing only
 */
export async function executePhaseWithRetry(
  issueNumber: number,
  phase: Phase,
  config: ExecutionConfig,
  resumeHandle?: ResumeHandle,
  worktreePath?: string,
  shutdownManager?: ShutdownManager,
  spinner?: PhasePauseHandle,
  /** @internal Injected for testing — defaults to module-level executePhase */
  executePhaseFn: typeof executePhase = executePhase,
  /** @internal Injected for testing — defaults to setTimeout-based delay */
  delayFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  /**
   * Per-issue auto-wait accounting (#804). Deliberately the LAST parameter:
   * the #761/#799 regression tests call this function positionally with
   * `executePhaseFn` at 8 and `delayFn` at 9, and AC-2 requires those tests to
   * pass unmodified. Defaults to a fresh disabled-or-config-derived ledger, so
   * a caller that does not thread one still gets correct (bounded) behavior —
   * just scoped to this phase rather than the issue.
   */
  autoWaitLedger: AutoWaitLedger = createAutoWaitLedger(config.autoWaitMinutes),
): Promise<PhaseResult & { sessionId?: string; resumeHandle?: ResumeHandle }> {
  // Skip retry logic if explicitly disabled
  if (config.retry === false) {
    return executePhaseFn(
      issueNumber,
      phase,
      config,
      resumeHandle,
      worktreePath,
      shutdownManager,
      spinner,
    );
  }

  // Skip cold-start retries for phases registered with `retryStrategy.maxRetries: 0`.
  // `loop` is the canonical user (#488) — it's always a re-run after a failed QA,
  // never a first boot. Failures at 47-51s are genuine skill failures, not cold-start
  // issues. Without this guard, 2 cold-start retries + 1 MCP fallback = 3 wasted
  // spawns per loop. Sourcing the decision from the registry makes the rule
  // data-driven — any future phase registered with `maxRetries: 0` inherits the
  // same behavior without a code change here.
  const skipColdStartRetry =
    phaseRegistry.has(phase) &&
    phaseRegistry.get(phase).retryStrategy?.maxRetries === 0;

  let lastResult: PhaseResult & {
    sessionId?: string;
    resumeHandle?: ResumeHandle;
  };

  if (skipColdStartRetry) {
    // Single attempt — no cold-start retry loop. The only thing that re-enters
    // this loop is a granted auto-wait (#804): `maxRetries: 0` means "a retry
    // cannot help", but a reopened rate-limit window is precisely the case
    // where it can. Bounded by AUTO_WAIT_MAX_WAITS.
    for (;;) {
      lastResult = await executePhaseFn(
        issueNumber,
        phase,
        config,
        resumeHandle,
        worktreePath,
        shutdownManager,
        spinner,
      );

      if (lastResult.success) {
        return lastResult;
      }

      // Turn-capped phase (#739): incomplete-but-not-hard-failed. A retry cannot
      // un-cap a turn limit, so short-circuit before any fallback — same rationale
      // as the billing skip (#732), but capped must skip *all* retries (incl.
      // cold-start), so an explicit early return is required, not just a guard
      // flag at the MCP gate.
      if (lastResult.capped) {
        return lastResult;
      }

      // #804: without this, `--auto-wait` would silently not cover the `loop`
      // phase — the one phase registered with `maxRetries: 0` — and a window
      // limit hitting /loop would still hard-halt with the flag set.
      const decision = shouldAutoWaitForReset(
        lastResult.structuredError,
        autoWaitLedger,
      );
      if (!decision) break;

      const { aborted } = await performAutoWait(
        issueNumber,
        phase,
        config,
        decision,
        autoWaitLedger,
        delayFn,
        shutdownManager,
        spinner,
      );
      if (aborted) return lastResult;
    }
  } else {
    // Phase 1: Cold-start retry attempts (with MCP enabled if configured)
    for (let attempt = 0; attempt <= COLD_START_MAX_RETRIES; attempt++) {
      lastResult = await executePhaseFn(
        issueNumber,
        phase,
        config,
        resumeHandle,
        worktreePath,
        shutdownManager,
        spinner,
      );

      const duration = lastResult.durationSeconds ?? 0;

      // Success → return immediately
      if (lastResult.success) {
        return lastResult;
      }

      // Turn-capped phase (#739): short-circuit before cold-start retries, the
      // MCP fallback, and the spec-extra retry — a retry cannot un-cap a turn
      // limit. The early return here (rather than a guard at the MCP gate alone)
      // is what skips the cold-start re-spawns, unlike the billing case which
      // still cold-start-retries in the <60s window.
      if (lastResult.capped) {
        return lastResult;
      }

      // Window-exhausted rate limit (#761 AC-2): the reset is hours away, so
      // every retry re-spawns into the same closed window — worst case
      // ~4 × phaseTimeout (≈2h) of doomed attempts before the run halts.
      // Modelled on the `capped` early return above: skip all remaining
      // cold-start retries and (via the return) the MCP fallback. Checked
      // before the duration branch because a rate-limit rejection typically
      // fails fast and would otherwise be mistaken for a cold-start failure.
      if (isWindowExhaustedRateLimit(lastResult.structuredError)) {
        // #804: opt-in auto-wait. Sits between phase attempts (never inside a
        // spawn), so `phaseTimeout` is not implicated. Returns null — and this
        // falls through to today's halt — whenever auto-wait is off, the
        // budget/bound is spent, or the failure is billing rather than a rate
        // limit.
        const decision = shouldAutoWaitForReset(
          lastResult.structuredError,
          autoWaitLedger,
        );
        if (decision) {
          const { aborted } = await performAutoWait(
            issueNumber,
            phase,
            config,
            decision,
            autoWaitLedger,
            delayFn,
            shutdownManager,
            spinner,
          );
          if (!aborted) {
            // A wait is not a cold-start retry, so it must not consume one:
            // the loop's `attempt++` cancels this out. Bounded by
            // AUTO_WAIT_MAX_WAITS, which is what makes this safe from looping.
            attempt--;
            continue;
          }
          return lastResult;
        }

        if (config.verbose) {
          bracketedConsoleLog(
            spinner,
            chalk.yellow(
              `\n    ✕ ${lastResult.error ?? "Rate limited"} — window exhausted, skipping retries`,
            ),
          );
        }
        return lastResult;
      }

      // Transient rate limit (#761 AC-4): retry, but with real backoff — the
      // bare `continue` this replaces re-spawned immediately into the same
      // throttle. Reuses the injected `delayFn`; delay doubles per attempt.
      // Metadata-absent rate limits land here by design (AC-9 fallback rule).
      if (
        lastResult.structuredError instanceof RateLimitError &&
        attempt < COLD_START_MAX_RETRIES
      ) {
        const backoffMs = RATE_LIMIT_RETRY_BACKOFF_MS * 2 ** attempt;
        if (config.verbose) {
          bracketedConsoleLog(
            spinner,
            chalk.yellow(
              `\n    ⟳ ${lastResult.error ?? "Rate limited"} — backing off ${backoffMs}ms before retry... (attempt ${attempt + 2}/${COLD_START_MAX_RETRIES + 1})`,
            ),
          );
        }
        await delayFn(backoffMs);
        continue;
      }

      // Genuine failure (took long enough to be real work) → skip cold-start retries.
      // Use error classification (AC-9): if the error is retryable (e.g., API
      // rate limit, transient 503), allow one more attempt even for genuine failures.
      if (duration >= COLD_START_THRESHOLD_SECONDS) {
        // Prefer the driver's structured cause (#732) — it reflects the real
        // SDK rate-limit/billing signal — over stderr-regex classification,
        // which only sees text and never the structured data.
        const typedError =
          lastResult.structuredError ??
          classifyError(lastResult.stderrTail ?? [], lastResult.exitCode);
        if (typedError.isRetryable && attempt < COLD_START_MAX_RETRIES) {
          if (config.verbose) {
            const label =
              typedError instanceof ApiError
                ? `API error (status ${typedError.metadata.statusCode ?? "unknown"})`
                : typedError.name;
            bracketedConsoleLog(
              spinner,
              chalk.yellow(
                `\n    ⟳ Retryable error: ${label}, retrying... (attempt ${attempt + 2}/${COLD_START_MAX_RETRIES + 1})`,
              ),
            );
          }
          continue;
        }
        if (phase === "spec") {
          break;
        }
        return lastResult;
      }

      // Cold-start failure detected — retry
      if (attempt < COLD_START_MAX_RETRIES) {
        if (config.verbose) {
          bracketedConsoleLog(
            spinner,
            chalk.yellow(
              `\n    ⟳ Cold-start failure detected (${duration.toFixed(1)}s), retrying... (attempt ${attempt + 2}/${COLD_START_MAX_RETRIES + 1})`,
            ),
          );
        }
      }
    }
  }

  // Capture the original error for better diagnostics
  const originalError = lastResult!.error;

  // Phase 2: MCP fallback - if MCP is enabled and we're still failing, try without MCP
  // This handles npx-based MCP servers that fail on first run due to cold-cache issues.
  // Skip for `loop` phase — MCP is never the cause of loop failures (#488).
  //
  // Also skip when the failure is a billing/credits error (#732): a no-MCP
  // retry cannot refill credits, so the misleading "retrying without MCP"
  // noise (#592) would only mask the real cause. The accurate structured
  // message (e.g. "Out of credits") is surfaced instead.
  const failureIsBilling = lastResult!.structuredError instanceof BillingError;
  // Belt-and-suspenders (#739): the capped early-returns above already exit
  // before reaching here, but gate the MCP fallback on `!failureIsCapped` too so
  // intent is documented and future code paths can't accidentally re-spawn a
  // capped phase without MCP.
  const failureIsCapped = lastResult!.capped === true;
  // A throttle must not trigger "retrying without MCP" (#761 AC-3): MCP was
  // never the cause, and the re-spawn burns up to another full phaseTimeout
  // against the same limit while mislabeling the failure as MCP-related.
  const failureIsRateLimited =
    lastResult!.structuredError instanceof RateLimitError;
  if (
    config.mcp &&
    !lastResult!.success &&
    !skipColdStartRetry &&
    !failureIsBilling &&
    !failureIsCapped &&
    !failureIsRateLimited
  ) {
    bracketedConsoleLog(
      spinner,
      chalk.yellow(
        `\n    ! Phase failed with MCP enabled, retrying without MCP...`,
      ),
    );

    // Create config copy with MCP disabled
    const configWithoutMcp: ExecutionConfig = {
      ...config,
      mcp: false,
    };

    const retryResult = await executePhaseFn(
      issueNumber,
      phase,
      configWithoutMcp,
      resumeHandle,
      worktreePath,
      shutdownManager,
      spinner,
    );

    if (retryResult.success) {
      bracketedConsoleLog(
        spinner,
        chalk.green(
          `    ✓ Phase succeeded without MCP (MCP cold-start issue detected)`,
        ),
      );
      return retryResult;
    }

    // Update lastResult for Phase 3 (spec retry)
    lastResult = retryResult;

    // Non-spec phases: return original error after MCP fallback exhausted
    if (phase !== "spec") {
      return {
        ...lastResult!,
        error: originalError,
      };
    }
  }

  // Phase 3: Spec-specific retry — spec has a higher transient failure rate
  // than other phases (~8.6%), so one extra retry with backoff recovers most cases.
  if (phase === "spec" && !lastResult!.success) {
    for (let i = 0; i < SPEC_EXTRA_RETRIES; i++) {
      bracketedConsoleLog(
        spinner,
        chalk.yellow(
          `\n    ⟳ Spec phase failed, retrying with ${SPEC_RETRY_BACKOFF_MS}ms backoff... (spec retry ${i + 1}/${SPEC_EXTRA_RETRIES})`,
        ),
      );

      await delayFn(SPEC_RETRY_BACKOFF_MS);

      const specRetryResult = await executePhaseFn(
        issueNumber,
        phase,
        config,
        resumeHandle,
        worktreePath,
        shutdownManager,
        spinner,
      );

      if (specRetryResult.success) {
        bracketedConsoleLog(
          spinner,
          chalk.green(`    ✓ Spec phase succeeded on retry`),
        );
        return specRetryResult;
      }

      lastResult = specRetryResult;
    }

    // All spec retries exhausted — return with original error for diagnostics
    return {
      ...lastResult!,
      error: originalError,
    };
  }

  return lastResult!;
}
