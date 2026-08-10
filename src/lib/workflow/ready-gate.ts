/**
 * Ready gate engine (#683).
 *
 * Drives the `sequant ready <issue>` pipeline: a full-weight `qa → loop → qa`
 * loop that reproduces the maintainer's manual fresh-session A+ pass
 * deterministically, then STOPS at a human merge gate — it never merges.
 *
 * The loop's exit threshold is set by a **gate policy**:
 *
 * - `ac` (default): stop once no `AC_NOT_MET` verdict remains. Remaining
 *   quality/polish gaps are surfaced in the report but NOT auto-fixed. Findings
 *   that touch the issue's Non-Goals are report-only. Predictable, scope-
 *   respecting behavior for a team engineer with a fixed agenda.
 * - `a-plus` (opt-in): loop toward `READY_FOR_MERGE`, auto-fixing quality gaps.
 *
 * Both policies are additionally bounded by `maxIterations`, an optional token
 * budget, and the `LOOP_NO_DIFF` stagnation guard. The #534 class (zero-diff
 * exec / null QA verdict) is never reported as ready.
 *
 * This module is the reusable engine — a future `sequant run --ready-gate`
 * (out of scope for #683) can reuse `runReadyGate` directly. The command shell
 * lives in `src/commands/ready.ts`.
 */

import type {
  ExecutionConfig,
  PhaseResult,
  ProgressCallback,
} from "./types.js";
import {
  withEscalatedEffort,
  type EscalationRecord,
} from "./effort-escalation.js";
import type { QaVerdict } from "./run-log-schema.js";
import type { ReadyPolicy } from "../settings.js";
import type { IssueStatus } from "./state-schema.js";
import {
  snapshotLoopProgress,
  compareLoopProgress,
  type LoopProgressSnapshot,
} from "./qa-stagnation.js";
import { classifyExecChanges, type ExecChangeState } from "./phase-executor.js";
import {
  readTokenUsageFiles,
  aggregateTokenUsage,
  TOKEN_USAGE_DIR,
} from "./token-utils.js";
import * as path from "path";

export type { ReadyPolicy } from "../settings.js";

/**
 * Why the gate stopped. Drives `ready`, the persisted issue status, and the
 * human-facing report headline.
 */
export type ReadyTerminalReason =
  /** `ac`: ACs objectively met (no AC_NOT_MET). Quality gaps reported, not fixed. */
  | "AC_MET"
  /** Either policy: QA returned READY_FOR_MERGE. */
  | "READY_FOR_MERGE"
  /** Guard: hit the iteration cap before the threshold. Needs human. */
  | "MAX_ITERATIONS"
  /** Guard: token budget exhausted before the threshold. Needs human. */
  | "TOKEN_BUDGET"
  /** Guard: `/loop` produced no diff — can't make progress. Needs human. */
  | "LOOP_NO_DIFF"
  /** Guard: `/loop` phase itself failed. Needs human. */
  | "LOOP_FAILED"
  /** #534: zero-diff exec worktree — nothing was built. Not ready. */
  | "NO_IMPLEMENTATION"
  /**
   * #879: the worktree is dirty but has no commits. Distinct from
   * NO_IMPLEMENTATION — work exists, but uncommitted work cannot rebase, push,
   * or become a PR, so it is not certifiable as-is. Re-run once it is committed.
   */
  | "UNCOMMITTED_ONLY"
  /**
   * #853: QA ran but produced no verdict (deferred its one-shot turn, or
   * output was unparseable). Distinct from NO_IMPLEMENTATION — the
   * implementation may be complete; it is the *review* that is missing.
   */
  | "NO_VERDICT";

/** A single gap surfaced by QA, classified for the report. */
export interface ReadyGapItem {
  /** Gap description as surfaced by QA. */
  description: string;
  /**
   * True when this finding overlaps one of the issue's Non-Goals. In `ac`
   * mode these are explicitly report-only (never fed to the fix loop).
   */
  nonGoal: boolean;
}

/** Structured outcome of a ready-gate run. */
export interface ReadyResult {
  issueNumber: number;
  policy: ReadyPolicy;
  /** True only when the gate certifies the work as merge-ready for a human. */
  ready: boolean;
  reason: ReadyTerminalReason;
  /** Issue status to persist (`waiting_for_human_merge` iff ready). */
  issueStatus: IssueStatus;
  /** Number of QA passes executed. */
  iterations: number;
  /** Last parsed QA verdict (null if QA never produced one). */
  finalVerdict: QaVerdict | null;
  /** Gap descriptions the fix loop was asked to address across iterations. */
  autoFixed: string[];
  /** Gaps still present / accepted at exit (quality gaps, Non-Goal items). */
  remaining: ReadyGapItem[];
  /** Total tokens consumed across all phases (best-effort from token files). */
  tokensUsed: number;
  /** Human-readable markdown gap report (AC-4). */
  report: string;
  /**
   * Effort escalations applied during this gate's QA-pass loop (#915),
   * base+escalated tier per escalated `qa`/`loop` dispatch. Empty when
   * `effortEscalation` is off or no dispatch escalated.
   */
  effortEscalations: EscalationRecord[];
}

/**
 * Thin phase-runner abstraction so the engine can be unit-tested without the
 * full `executePhaseWithRetry` positional signature or a live agent driver.
 */
export type ReadyPhaseRunner = (
  phase: "qa" | "loop",
  config: ExecutionConfig,
  worktreePath: string,
) => Promise<PhaseResult>;

export interface RunReadyGateOptions {
  issueNumber: number;
  worktreePath: string;
  policy: ReadyPolicy;
  /** Hard iteration cap on QA passes (AC-6). */
  maxIterations: number;
  /** Optional token budget; 0/undefined disables the token cap (AC-6). */
  tokenBudget?: number;
  /** Non-Goals parsed from the issue body, for report-only classification. */
  nonGoals?: string[];
  /** Per-phase timeout in seconds. */
  phaseTimeout: number;
  /** Whether MCP servers are enabled for phase execution. */
  mcp: boolean;
  verbose?: boolean;
  /** Injectable phase runner — defaults to the real executePhaseWithRetry wrapper. */
  runPhase: ReadyPhaseRunner;
  /**
   * #697: optional live-progress sink. The gate owns the qa→loop→qa loop, so it
   * is the natural emit site (the `run` path emits from RunOrchestrator/batch-
   * executor). Fires `start` before each phase and `complete`/`failed` after,
   * carrying the 1-based QA-pass `iteration` so the renderer shows `loop N/M`.
   * Optional — injected unit tests that omit it stay unaffected.
   */
  onProgress?: ProgressCallback;
  /** Injectable token reader — defaults to reading `<worktree>/.sequant`. */
  readTokensUsed?: (worktreePath: string) => number;
  /** Injectable change classifier — defaults to {@link classifyExecChanges}. */
  classifyChangesFn?: (cwd: string) => ExecChangeState;
  /** Injectable loop-progress snapshot — defaults to {@link snapshotLoopProgress}. */
  snapshotFn?: (cwd: string) => LoopProgressSnapshot;
  /**
   * Resolved per-phase `model`/`effort` overrides (#914), keyed by phase
   * name. Callers (e.g. `commands/ready.ts`) resolve this via
   * `resolvePhasePolicies` — the same shared resolver `buildExecutionConfig`
   * uses — so this producer cannot drift from that one (#833 class).
   * `buildPhaseConfig` spreads it onto every `ExecutionConfig` it builds;
   * `phase-executor.ts` applies the entry for the phase actually running.
   */
  phasePolicies?: Record<string, { model?: string; effort?: string }>;
  /**
   * Evidence-based effort escalation on quality-loop retries (#915). Callers
   * (e.g. `commands/ready.ts`) resolve this CLI > settings > `false`, the same
   * precedence `buildExecutionConfig` uses for the `run` path (#833 class).
   * `buildPhaseConfig` spreads it onto every `ExecutionConfig` it builds;
   * `withEscalatedEffort` (`effort-escalation.ts`) reads it at each QA-pass
   * dispatch to decide whether that specific `qa`/`loop` call escalates.
   */
  effortEscalation?: boolean;
}

/**
 * Pure exit predicate. Given a policy and a QA verdict, has the loop reached
 * its stopping threshold?
 *
 * - `READY_FOR_MERGE` always stops (both policies).
 * - `ac`: `AC_MET_BUT_NOT_A_PLUS` also stops — ACs are objectively met; the
 *   remaining gaps are quality-only and `ac` reports rather than fixes them.
 * - `a-plus`: only `READY_FOR_MERGE` stops.
 * - `AC_NOT_MET` / `NEEDS_VERIFICATION` never stop in either policy.
 */
export function isAtThreshold(
  policy: ReadyPolicy,
  verdict: QaVerdict,
): boolean {
  if (verdict === "READY_FOR_MERGE") return true;
  if (policy === "ac") return verdict === "AC_MET_BUT_NOT_A_PLUS";
  return false;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "are",
  "was",
  "has",
  "have",
  "not",
  "but",
  "its",
  "via",
  "any",
  "all",
  "out",
  "should",
  "would",
  "could",
  "when",
  "then",
  "than",
  "must",
  "will",
]);

function significantTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/[\s-]+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
  );
}

/**
 * Does a gap description overlap a Non-Goal? Conservative token-overlap
 * heuristic: ≥2 shared significant words marks the gap as Non-Goal-touching.
 *
 * @internal Exported for testing only.
 */
export function gapTouchesNonGoals(gap: string, nonGoals: string[]): boolean {
  if (nonGoals.length === 0) return false;
  const gapTokens = significantTokens(gap);
  if (gapTokens.size === 0) return false;
  for (const ng of nonGoals) {
    const ngTokens = significantTokens(ng);
    let overlap = 0;
    for (const t of ngTokens) {
      if (gapTokens.has(t)) overlap++;
      if (overlap >= 2) return true;
    }
  }
  return false;
}

/**
 * Parse the issue body's Non-Goals section into a list of bullet items.
 *
 * Recognizes `## Non-goals`, `## Non-Goals`, `### Out of scope`, etc. Captures
 * markdown bullet items until the next heading. Returns `[]` when no section is
 * present.
 *
 * @internal Exported for testing only.
 */
export function parseNonGoals(issueBody: string): string[] {
  if (!issueBody) return [];
  const lines = issueBody.split("\n");
  const items: string[] = [];
  let inSection = false;
  const headingRe = /^#{1,6}\s+(.*)$/;
  const nonGoalHeadingRe = /^(non-?goals?|out[ -]of[ -]scope)\b/i;
  for (const line of lines) {
    const heading = line.match(headingRe);
    if (heading) {
      inSection = nonGoalHeadingRe.test(heading[1].trim());
      continue;
    }
    if (!inSection) continue;
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      // Strip surrounding markdown emphasis/backticks for cleaner matching.
      const text = bullet[1].replace(/[`*]/g, "").trim();
      if (text) items.push(text);
    }
  }
  return items;
}

function classifyGaps(gaps: string[], nonGoals: string[]): ReadyGapItem[] {
  return gaps.map((g) => ({
    description: g,
    nonGoal: gapTouchesNonGoals(g, nonGoals),
  }));
}

function defaultReadTokensUsed(worktreePath: string): number {
  const dir = path.join(worktreePath, TOKEN_USAGE_DIR);
  // Read without cleanup — the engine polls cumulatively across phases.
  const files = readTokenUsageFiles(dir);
  return aggregateTokenUsage(files).tokensUsed;
}

/**
 * Build a minimal ExecutionConfig for a single ready-gate phase.
 */
function buildPhaseConfig(
  opts: RunReadyGateOptions,
  extra: Partial<ExecutionConfig>,
): ExecutionConfig {
  return {
    phases: [],
    phaseTimeout: opts.phaseTimeout,
    qualityLoop: false,
    maxIterations: opts.maxIterations,
    skipVerification: false,
    sequential: true,
    concurrency: 1,
    parallel: false,
    verbose: opts.verbose ?? false,
    noSmartTests: false,
    dryRun: false,
    mcp: opts.mcp,
    retry: true,
    // #914: producer 2 (see the doc comment on RunReadyGateOptions.phasePolicies
    // for why this can't drift from buildExecutionConfig's own assignment).
    phasePolicies: opts.phasePolicies,
    // #915: producer 2 (see RunReadyGateOptions.effortEscalation).
    effortEscalation: opts.effortEscalation,
    ...extra,
  };
}

/**
 * Render the structured gap report (AC-4).
 *
 * @internal Exported for testing only.
 */
export function formatReadyReport(result: ReadyResult): string {
  const headline = result.ready
    ? "✅ READY — awaiting human merge decision"
    : result.reason === "NO_IMPLEMENTATION"
      ? "⛔ NOT READY — no implementation detected"
      : result.reason === "UNCOMMITTED_ONLY"
        ? "⛔ NOT READY — work is uncommitted"
        : result.reason === "NO_VERDICT"
          ? "⛔ NOT READY — QA produced no verdict"
          : "⚠️ NOT READY — needs human intervention";

  const reasonText: Record<ReadyTerminalReason, string> = {
    AC_MET:
      "Acceptance Criteria are objectively met (no AC_NOT_MET). Remaining gaps are quality-only and reported below (policy `ac` does not auto-fix them).",
    READY_FOR_MERGE: "QA returned READY_FOR_MERGE.",
    MAX_ITERATIONS:
      "Hit the iteration cap before reaching the policy threshold. A human should review the remaining gaps.",
    TOKEN_BUDGET:
      "Token budget exhausted before reaching the policy threshold. A human should review the remaining gaps.",
    LOOP_NO_DIFF:
      "The fix loop made no diff (stagnation guard). Manual intervention required.",
    LOOP_FAILED:
      "The fix loop phase failed. A human should investigate before merging.",
    NO_IMPLEMENTATION:
      "Zero-diff worktree — there is nothing to certify (#534 guard).",
    UNCOMMITTED_ONLY:
      "The worktree has uncommitted changes but no commits (#879 guard). Uncommitted work cannot rebase, push, or become a PR — commit it, then re-run the gate.",
    NO_VERDICT:
      "QA ran but produced no verdict (deferred one-shot turn or unparseable output) — there is nothing to certify (#534/#853 guard). The implementation may exist; re-run the gate once QA emits a verdict.",
  };

  const lines: string[] = [];
  lines.push(`## sequant ready — Issue #${result.issueNumber}`);
  lines.push("");
  lines.push(`**${headline}**`);
  lines.push("");
  lines.push(`- **Policy:** \`${result.policy}\``);
  lines.push(`- **Final verdict:** ${result.finalVerdict ?? "(none)"}`);
  lines.push(
    `- **Stop reason:** ${result.reason} — ${reasonText[result.reason]}`,
  );
  lines.push(`- **QA passes:** ${result.iterations}`);
  lines.push(`- **Tokens used:** ${result.tokensUsed.toLocaleString()}`);
  lines.push(
    `- **Final state:** \`${result.issueStatus}\` (never auto-merged)`,
  );
  lines.push("");

  lines.push("### Auto-fixed");
  if (result.autoFixed.length === 0) {
    lines.push("- None");
  } else {
    for (const item of result.autoFixed) lines.push(`- ${item}`);
  }
  lines.push("");

  lines.push("### Remaining / accepted gaps");
  if (result.remaining.length === 0) {
    lines.push("- None");
  } else {
    for (const item of result.remaining) {
      const tag = item.nonGoal ? " _(Non-Goal — report-only)_" : "";
      lines.push(`- ${item.description}${tag}`);
    }
  }
  lines.push("");

  lines.push(
    "> The human merge gate is intentional: `sequant ready` never merges. Review the gaps above, then merge manually when satisfied.",
  );

  return lines.join("\n");
}

/**
 * Drive the policy-bounded `qa → loop → qa` ready gate.
 */
export async function runReadyGate(
  opts: RunReadyGateOptions,
): Promise<ReadyResult> {
  const {
    issueNumber,
    worktreePath,
    policy,
    maxIterations,
    tokenBudget,
    nonGoals = [],
  } = opts;
  const readTokensUsed = opts.readTokensUsed ?? defaultReadTokensUsed;
  const classifyChangesFn = opts.classifyChangesFn ?? classifyExecChanges;
  const snapshotFn = opts.snapshotFn ?? snapshotLoopProgress;

  // #697: run a phase while emitting live-progress events around it. `iteration`
  // is the 1-based QA-pass index so the renderer can render `loop N/M`. Emits
  // `failed` (and re-throws) if the runner itself throws so the catch path in
  // ready.ts disposes a renderer that already reflects the failed cell.
  const runPhaseTracked = async (
    phase: "qa" | "loop",
    config: ExecutionConfig,
    iteration: number,
  ): Promise<PhaseResult> => {
    opts.onProgress?.(opts.issueNumber, phase, "start", { iteration });
    let phaseResult: PhaseResult;
    try {
      phaseResult = await opts.runPhase(phase, config, worktreePath);
    } catch (err) {
      opts.onProgress?.(opts.issueNumber, phase, "failed", {
        iteration,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    opts.onProgress?.(
      opts.issueNumber,
      phase,
      phaseResult.success === false ? "failed" : "complete",
      {
        iteration,
        durationSeconds: phaseResult.durationSeconds,
        error: phaseResult.success === false ? phaseResult.error : undefined,
      },
    );
    return phaseResult;
  };

  let iterations = 0;
  let finalVerdict: QaVerdict | null = null;
  const autoFixed: string[] = [];
  let remaining: ReadyGapItem[] = [];
  let tokensUsed = 0;
  // #915: escalated (base, escalated) tiers, one entry per QA-pass dispatch
  // that actually escalated. Populated at the two dispatch sites below.
  const effortEscalations: EscalationRecord[] = [];

  const finish = (reason: ReadyTerminalReason): ReadyResult => {
    const ready = reason === "AC_MET" || reason === "READY_FOR_MERGE";
    const issueStatus: IssueStatus = ready
      ? "waiting_for_human_merge"
      : "blocked";
    const result: ReadyResult = {
      issueNumber,
      policy,
      ready,
      reason,
      issueStatus,
      iterations,
      finalVerdict,
      autoFixed,
      remaining,
      tokensUsed,
      report: "",
      effortEscalations,
    };
    result.report = formatReadyReport(result);
    return result;
  };

  const budgetExceeded = (): boolean =>
    typeof tokenBudget === "number" &&
    tokenBudget > 0 &&
    tokensUsed >= tokenBudget;

  // Loop is bounded by maxIterations QA passes. Each iteration: run QA, check
  // the policy threshold + #534 guards, and (if not stopping) run one fix loop.
  while (iterations < maxIterations) {
    if (budgetExceeded()) {
      return finish("TOKEN_BUDGET");
    }

    iterations++;

    // #915: iterations > 1 means this QA pass is a retry of a prior
    // unsatisfied verdict — the ready-gate's retry signal.
    const qaEscalation = withEscalatedEffort(
      buildPhaseConfig(opts, { fullQa: true }),
      "qa",
      iterations > 1,
    );
    if (qaEscalation.record) effortEscalations.push(qaEscalation.record);

    const qaResult = await runPhaseTracked(
      "qa",
      qaEscalation.config,
      iterations,
    );
    tokensUsed = readTokensUsed(worktreePath);

    const verdict = qaResult.verdict ?? null;

    // #534 guard: a null verdict is never "ready". #853: report it as
    // NO_VERDICT, not NO_IMPLEMENTATION — a deferred/unparseable QA turn says
    // nothing about whether an implementation exists, and the misleading label
    // sent debuggers to the wrong place (same class as the phase-executor
    // "unparseable verdict" split).
    if (!verdict) {
      return finish("NO_VERDICT");
    }
    // #534/#879 guard: a worktree with no commits is never "ready". Split by
    // cause so the report is not misleading: `none` is the empty-branch class
    // (#529/#570), `uncommitted` is a dirty tree whose work cannot become a PR
    // until committed (#879). `commits`/`unknown` continue (unknown fails open).
    const changes = classifyChangesFn(worktreePath);
    if (changes.kind === "none") {
      return finish("NO_IMPLEMENTATION");
    }
    if (changes.kind === "uncommitted") {
      return finish("UNCOMMITTED_ONLY");
    }

    finalVerdict = verdict;
    const gaps = qaResult.summary?.gaps ?? [];
    remaining = classifyGaps(gaps, nonGoals);

    // Policy threshold reached → stop at the human merge gate.
    if (isAtThreshold(policy, verdict)) {
      return finish(
        verdict === "READY_FOR_MERGE" ? "READY_FOR_MERGE" : "AC_MET",
      );
    }

    // Not at threshold and out of iterations → clean halt, needs human.
    if (iterations >= maxIterations) {
      return finish("MAX_ITERATIONS");
    }
    if (budgetExceeded()) {
      return finish("TOKEN_BUDGET");
    }

    // Run one fix loop. In `ac` mode we only reach here on AC_NOT_MET, so the
    // gaps are AC gaps — feeding them via failedAcs keeps the loop scoped to
    // the AC boundary (quality gaps are never fixed under `ac`). Non-Goal-
    // touching findings are excluded from what we ask the loop to fix.
    const fixableGaps = remaining
      .filter((g) => !g.nonGoal)
      .map((g) => g.description);

    const before = snapshotFn(worktreePath);
    // #915: iterations > 1 means this fix pass follows a QA pass that was
    // itself a retry — the same ready-gate retry signal as the qa dispatch
    // above.
    const loopEscalation = withEscalatedEffort(
      buildPhaseConfig(opts, {
        lastVerdict: verdict,
        failedAcs: fixableGaps.join("; ") || undefined,
        promptContext: buildLoopContext(policy, verdict, fixableGaps),
      }),
      "loop",
      iterations > 1,
    );
    if (loopEscalation.record) effortEscalations.push(loopEscalation.record);

    const loopResult = await runPhaseTracked(
      "loop",
      loopEscalation.config,
      iterations,
    );
    tokensUsed = readTokensUsed(worktreePath);

    if (!loopResult.success) {
      return finish("LOOP_FAILED");
    }

    const after = snapshotFn(worktreePath);
    const progress = compareLoopProgress(before, after);
    if (!progress.progressed) {
      return finish("LOOP_NO_DIFF");
    }

    // The loop produced a diff — record what it was asked to fix and re-QA.
    for (const g of fixableGaps) {
      if (!autoFixed.includes(g)) autoFixed.push(g);
    }
  }

  // Iteration cap reached without an explicit stop above (defensive).
  return finish("MAX_ITERATIONS");
}

/**
 * Build the prompt context handed to the `/loop` phase. Mirrors the
 * batch-executor's `buildLoopContext` shape but scopes the instruction to the
 * gate policy so `ac` runs do not chase quality-only gaps.
 */
function buildLoopContext(
  policy: ReadyPolicy,
  verdict: QaVerdict,
  fixableGaps: string[],
): string {
  const parts: string[] = [];
  parts.push(`Ready gate (#683) — policy: ${policy}`);
  parts.push(`QA Verdict: ${verdict}`);
  if (policy === "ac") {
    parts.push(
      "Scope: fix ONLY the unmet Acceptance Criteria below. Do NOT address quality/polish gaps or anything touching the issue's Non-Goals — those are deliberately deferred under the `ac` policy.",
    );
  } else {
    parts.push(
      "Scope: drive the work toward READY_FOR_MERGE by addressing the gaps below.",
    );
  }
  if (fixableGaps.length > 0) {
    parts.push("Gaps to address:");
    for (const g of fixableGaps) parts.push(`- ${g}`);
  }
  return parts.join("\n");
}
