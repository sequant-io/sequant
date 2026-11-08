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
  formatEvidenceBundle,
  type EvidenceBundle,
  type DivergenceIterationRecord,
} from "./divergence-halt.js";
import type {
  QaVerdict,
  GapFinding,
  GapCategory,
  GapAction,
} from "./run-log-schema.js";
import type { ReadyPolicy } from "../settings.js";
import type { IssueStatus } from "./state-schema.js";
import {
  snapshotLoopProgress,
  compareLoopProgress,
  type LoopProgressSnapshot,
} from "./qa-stagnation.js";
import { classifyExecChanges, type ExecChangeState } from "./phase-executor.js";
import { readWorktreeTokenUsage } from "./token-utils.js";

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
  | "NO_VERDICT"
  /**
   * #995 (#971 AC-4): an agent declared the spec impossible as written. The
   * gate halts without another fix pass — a retry cannot un-contradict a
   * spec.
   */
  | "SPEC_DIVERGENCE";

/** A single gap surfaced by QA, classified for the report. */
export interface ReadyGapItem {
  /** Gap description as surfaced by QA. */
  description: string;
  /**
   * True when this finding overlaps one of the issue's Non-Goals. In `ac`
   * mode these are explicitly report-only (never fed to the fix loop).
   */
  nonGoal: boolean;
  /**
   * Structured taxonomy fields from the `SEQUANT_QA_GAPS` marker (#937),
   * present only when this gap's description matched a marker finding.
   * A gap surfaced only via the legacy prose scrape carries none of these.
   */
  category?: GapCategory;
  evidence?: string;
  recommendedAction?: GapAction;
  affectedAcs?: string[];
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
   * #995: the formatted evidence bundle, present only on a
   * `SPEC_DIVERGENCE` halt. Carried as
   * rendered text rather than as the structured bundle because the gate's one
   * output channel is `report`, and every other field here is already
   * report-shaped.
   */
  haltBundle?: string;
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
  /**
   * The caller's fully-resolved `ExecutionConfig` — the single channel through
   * which every execution-shaped setting reaches the gate's phases (#863).
   *
   * Required, deliberately: an optional field with a hardcoded fallback would
   * rebuild the exact silent-default this field exists to delete. Before #863
   * the gate took a flat bag of one-off primitives (`phaseTimeout`, `mcp`,
   * `mcpAllowlist`, `verbose`, `phasePolicies`, `effortEscalation`), and
   * `buildPhaseConfig` hardcoded everything the bag did not carry. That made
   * `ready-gate.ts` a *second* `ExecutionConfig` producer that silently
   * defaulted every field `config-resolver.ts` later grew — `agent` and
   * `aiderSettings` most damagingly, so an aider-configured project ran its
   * main phases on aider and its gate on claude-code (#833's drift class,
   * previously patched per-field at #914 / #915 / #936).
   *
   * Both callers now resolve this through `buildExecutionConfig`
   * (`commands/ready.ts`) or pass the parent run's own resolved config
   * (`batch-executor.ts`), so there is exactly one producer. The gate keeps
   * only the six gate-semantic overrides in {@link buildPhaseConfig}; every
   * other key is inherited. `execution-config-parity.test.ts` fails if that
   * ever drifts again.
   */
  config: ExecutionConfig;
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
   * Persist the final gap report as an issue comment when the gate reaches
   * a terminal state with a QA verdict (#937 AC-4) — callers wire this to
   * `GitHubProvider.postComment`. Best-effort: a failure here is caught and
   * reported through {@link RunReadyGateOptions.log}, never failing the gate
   * itself — `result.report` (returned to the caller either way) is the
   * primary channel.
   */
  postReport?: (body: string) => Promise<void>;
  /** Warning sink for non-fatal failures (#1315); defaults to `console.warn`. */
  log?: (message: string) => void;
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
 * Parse the issue body's Non-Goals sections into a list of bullet items —
 * the shared scanner in `../non-goals.ts` (#1474), re-exported here for the
 * gate's callers.
 *
 * @internal Exported for testing only.
 */
export { parseNonGoals } from "../non-goals.js";

/**
 * Classify each gap description for the report, enriching with structured
 * taxonomy fields (#937) when the gap matches a `SEQUANT_QA_GAPS` marker
 * finding. `findings` are matched to `gaps` by description (trimmed,
 * case-folded) since `parseQaSummary` already unions marker findings into
 * `gaps` in document order — every marker finding's description is present.
 */
function classifyGaps(
  gaps: string[],
  nonGoals: string[],
  findings?: GapFinding[],
): ReadyGapItem[] {
  const byDescription = new Map(
    (findings ?? []).map((f) => [f.description.trim().toLowerCase(), f]),
  );
  return gaps.map((g) => {
    const finding = byDescription.get(g.trim().toLowerCase());
    return {
      description: g,
      nonGoal: finding?.nonGoal ?? gapTouchesNonGoals(g, nonGoals),
      ...(finding && {
        category: finding.category,
        evidence: finding.evidence,
        recommendedAction: finding.recommendedAction,
        ...(finding.affectedAcs && { affectedAcs: finding.affectedAcs }),
      }),
    };
  });
}

function defaultReadTokensUsed(worktreePath: string): number {
  // #986: the one worktree-anchored helper both `run` and the gate read
  // through. `cleanup: false` is the gate's side of that seam — the engine
  // polls cumulatively across QA passes, so deleting the files mid-loop
  // would zero its own budget accounting.
  return readWorktreeTokenUsage(worktreePath, { cleanup: false }).tokensUsed;
}

/**
 * Gate-semantic overrides applied on top of the caller's resolved config
 * (#863). These six keys — and only these — are the gate's own judgement;
 * every other `ExecutionConfig` field is inherited from `opts.config`.
 *
 * The gate dispatches one phase at a time against a worktree it already owns,
 * so it does not run a phase *list*, does not drive its own quality loop (it
 * IS the loop), and is never the concurrency layer.
 *
 * `execution-config-parity.test.ts` mirrors this set as its allowlist and
 * fails if a seventh key quietly joins it.
 *
 * @internal Exported for testing only.
 */
export const GATE_CONFIG_OVERRIDES = {
  phases: [],
  qualityLoop: false,
  sequential: true,
  concurrency: 1,
  parallel: false,
  dryRun: false,
} satisfies Partial<ExecutionConfig>;

/**
 * Build the `ExecutionConfig` for a single ready-gate phase.
 *
 * Inherits the caller's fully-resolved config wholesale and overrides only
 * {@link GATE_CONFIG_OVERRIDES}. Before #863 this function hardcoded a value
 * for every field it knew about, which made it a *second* `ExecutionConfig`
 * producer that silently defaulted everything `config-resolver.ts` grew
 * afterwards — `agent`, `aiderSettings`, `retry`, `skipVerification`,
 * `noSmartTests`, `autoWaitMinutes`, `relayEnabled`, `isolateParallel` and
 * `issueType`. See {@link RunReadyGateOptions.config}.
 *
 * `extra` carries per-dispatch state only (`fullQa`, `lastVerdict`,
 * `failedAcs`, `promptContext`) — never resolved settings.
 *
 * @internal Exported for testing only (`execution-config-parity.test.ts`).
 */
export function buildPhaseConfig(
  opts: RunReadyGateOptions,
  extra: Partial<ExecutionConfig>,
): ExecutionConfig {
  return {
    ...opts.config,
    ...GATE_CONFIG_OVERRIDES,
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
    SPEC_DIVERGENCE:
      "An agent declared the spec impossible as written (#995 escape hatch). The gate halted — another pass cannot resolve a contradiction in the criteria. Reconcile the acceptance criteria with the repository, then re-run.",
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
      const tags = [
        item.category && item.recommendedAction
          ? `\`${item.category} · ${item.recommendedAction}\``
          : undefined,
        item.nonGoal ? "_(Non-Goal — report-only)_" : undefined,
      ].filter(Boolean);
      const suffix = tags.length > 0 ? ` ${tags.join(" ")}` : "";
      lines.push(`- ${item.description}${suffix}`);
    }
  }
  lines.push("");

  // #995: a halt's evidence belongs in the report, not only in the
  // stop-reason sentence — the SHAs tried are what let a human adjudicate
  // the halt without replaying the run.
  if (result.haltBundle) {
    lines.push("### Ladder halt evidence");
    lines.push("");
    lines.push("```");
    lines.push(result.haltBundle);
    lines.push("```");
    lines.push("");
  }

  lines.push(
    "> The human merge gate is intentional: `sequant ready` never merges. Review the gaps above, then merge manually when satisfied.",
  );
  lines.push("");
  lines.push(formatReadyGapsMarker(result.remaining));

  return lines.join("\n");
}

/**
 * Render `remaining` as a `SEQUANT_QA_GAPS` marker so the persisted ready
 * report (#937 AC-4) carries the same machine-readable channel `/qa` itself
 * emits — only items that came from a structured finding (have a
 * `category`) round-trip; legacy prose-only gaps are already in the prose
 * list above and are not re-encoded here.
 */
function formatReadyGapsMarker(remaining: ReadyGapItem[]): string {
  const findings: GapFinding[] = remaining
    .filter(
      (
        g,
      ): g is ReadyGapItem & {
        category: GapCategory;
        evidence: string;
        recommendedAction: GapAction;
      } =>
        g.category !== undefined &&
        g.evidence !== undefined &&
        g.recommendedAction !== undefined,
    )
    .map((g) => ({
      category: g.category,
      evidence: g.evidence,
      description: g.description,
      recommendedAction: g.recommendedAction,
      ...(g.affectedAcs && { affectedAcs: g.affectedAcs }),
      ...(g.nonGoal && { nonGoal: g.nonGoal }),
    }));
  return `<!-- SEQUANT_QA_GAPS: ${JSON.stringify({ findings })} -->`;
}

/**
 * #697: run a phase while emitting live-progress events around it. `iteration`
 * is the 1-based QA-pass index so the renderer can render `loop N/M`. Emits
 * `failed` (and re-throws) if the runner itself throws so the catch path in
 * ready.ts disposes a renderer that already reflects the failed cell.
 */
async function runReadyPhaseTracked(
  opts: RunReadyGateOptions,
  phase: "qa" | "loop",
  config: ExecutionConfig,
  iteration: number,
): Promise<PhaseResult> {
  opts.onProgress?.(opts.issueNumber, phase, "start", { iteration });
  let phaseResult: PhaseResult;
  try {
    phaseResult = await opts.runPhase(phase, config, opts.worktreePath);
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
}

/** #995: assemble the bundle for a gate-side `SPEC_DIVERGENCE` halt. */
function buildReadyHaltBundle(
  history: {
    issueNumber: number;
    iterationRecords: DivergenceIterationRecord[];
  },
  phase: string,
  declared?: { acs?: string; message?: string },
): EvidenceBundle {
  const { issueNumber, iterationRecords } = history;
  return {
    issueNumber,
    phase,
    reason: "SPEC_DIVERGENCE",
    shasTried: [
      ...new Set(
        iterationRecords
          .map((r) => r.sha)
          .filter((sha): sha is string => Boolean(sha)),
      ),
    ],
    iterations: [...iterationRecords],
    escalationHistory: [],
    declaredAcs: declared?.acs ?? "",
    ...(declared?.message ? { message: declared.message } : {}),
  };
}

/** The gate's accumulated state at the moment it stops. */
interface ReadyGateSnapshot {
  iterations: number;
  finalVerdict: QaVerdict | null;
  autoFixed: string[];
  remaining: ReadyGapItem[];
  tokensUsed: number;
  haltBundle: EvidenceBundle | null;
}

/** Build the terminal result, render its report and (#937 AC-4) post it. */
async function finishReadyGate(
  opts: RunReadyGateOptions,
  reason: ReadyTerminalReason,
  snapshot: ReadyGateSnapshot,
): Promise<ReadyResult> {
  const { issueNumber, policy } = opts;
  const {
    iterations,
    finalVerdict,
    autoFixed,
    remaining,
    tokensUsed,
    haltBundle,
  } = snapshot;
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
    ...(haltBundle ? { haltBundle: formatEvidenceBundle(haltBundle) } : {}),
  };
  result.report = formatReadyReport(result);

  // #937 AC-4: persist the gap report as an issue comment once the gate
  // reaches a terminal state carrying a QA verdict. `finalVerdict === null`
  // covers NO_IMPLEMENTATION/UNCOMMITTED_ONLY/NO_VERDICT and the guard
  // TOKEN_BUDGET check before the first QA pass — none of those have a gap
  // report worth persisting. Best-effort: a post failure must never fail
  // the gate — `result.report` (returned either way) is the primary
  // channel, same rationale as `sequant ready`'s existing state-persistence
  // try/catch.
  if (result.finalVerdict !== null && opts.postReport) {
    try {
      await opts.postReport(result.report);
    } catch (error) {
      // Non-fatal — see comment above — but never silent (#1315).
      const warn = opts.log ?? ((m: string) => console.warn(m));
      warn(
        `Failed to post ready-gate report for #${issueNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return result;
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

  const runPhaseTracked = (
    phase: "qa" | "loop",
    config: ExecutionConfig,
    iteration: number,
  ): Promise<PhaseResult> =>
    runReadyPhaseTracked(opts, phase, config, iteration);

  let iterations = 0;
  let finalVerdict: QaVerdict | null = null;
  const autoFixed: string[] = [];
  let remaining: ReadyGapItem[] = [];
  let tokensUsed = 0;
  /** #995: per-iteration replay material for a halt's evidence bundle. */
  const iterationRecords: DivergenceIterationRecord[] = [];
  /** #995: set alongside a `SPEC_DIVERGENCE` `finish(...)`, rendered into the report. */
  let haltBundle: EvidenceBundle | null = null;

  /** #995: assemble the bundle for a gate-side `SPEC_DIVERGENCE` halt. */
  const buildBundle = (
    phase: string,
    declared?: { acs?: string; message?: string },
  ): EvidenceBundle =>
    buildReadyHaltBundle({ issueNumber, iterationRecords }, phase, declared);

  const finish = (reason: ReadyTerminalReason): Promise<ReadyResult> =>
    finishReadyGate(opts, reason, {
      iterations,
      finalVerdict,
      autoFixed,
      remaining,
      tokensUsed,
      haltBundle,
    });

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

    const qaResult = await runPhaseTracked(
      "qa",
      buildPhaseConfig(opts, { fullQa: true }),
      iterations,
    );
    tokensUsed = readTokensUsed(worktreePath);

    // #995 (#971 AC-4): the escape hatch, checked before the verdict guards.
    // A QA turn that declared the criteria impossible has said something more
    // useful than "no parseable verdict", and reporting it as NO_VERDICT would
    // send the reader to debug a verdict regex.
    //
    // Reachability, stated plainly so the next reader does not have to
    // rediscover it: **no skill currently instructs a `qa` agent to emit the
    // marker** — AC-4 scoped the skill guidance to `exec` and `loop`, and this
    // branch fires only if a QA agent emits it unprompted. It is kept rather
    // than dropped because `batch-executor.ts`'s run-path check is
    // phase-agnostic (it reads `result.specDivergence` for every phase in the
    // chain, `qa` included); deleting this would make the two paths disagree
    // about the same input. Documenting the escape hatch in the `qa` skill is
    // the change that would make both reachable, and it is deliberately out of
    // #995's scope — the `qa` skill's one-shot contract requires a
    // `### Verdict:` line from a closed four-value set, so adding a fifth exit
    // is a design decision, not a gap fill.
    if (qaResult.specDivergence) {
      haltBundle = buildBundle("qa", qaResult.specDivergence);
      return finish("SPEC_DIVERGENCE");
    }

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
    remaining = classifyGaps(gaps, nonGoals, qaResult.summary?.findings);

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
    // touching findings are excluded from what we ask the loop to fix, as are
    // `SEQUANT_QA_GAPS` findings explicitly marked `document` or
    // `pause_for_human` (#937 AC-3) — a gap with no `recommendedAction` (the
    // legacy prose-only path) is still treated as fixable, unchanged from
    // pre-#937 behavior.
    const fixableGaps = remaining
      .filter(
        (g) =>
          !g.nonGoal &&
          g.recommendedAction !== "document" &&
          g.recommendedAction !== "pause_for_human",
      )
      .map((g) => g.description);

    const before = snapshotFn(worktreePath);
    const loopResult = await runPhaseTracked(
      "loop",
      buildPhaseConfig(opts, {
        lastVerdict: verdict,
        failedAcs: fixableGaps.join("; ") || undefined,
        promptContext: buildLoopContext(policy, verdict, fixableGaps),
      }),
      iterations,
    );
    tokensUsed = readTokensUsed(worktreePath);

    // #995 (#971 AC-4): checked before the LOOP_FAILED guard — a fix pass that
    // declared the criteria impossible did not "fail", it reported. Reporting
    // it as LOOP_FAILED would point the human at the loop skill.
    if (loopResult.specDivergence) {
      haltBundle = buildBundle("loop", loopResult.specDivergence);
      return finish("SPEC_DIVERGENCE");
    }

    if (!loopResult.success) {
      return finish("LOOP_FAILED");
    }

    const after = snapshotFn(worktreePath);
    const progress = compareLoopProgress(before, after);
    if (!progress.progressed) {
      return finish("LOOP_NO_DIFF");
    }
    iterationRecords.push({ iteration: iterations, sha: after.sha, verdict });

    // Record what the loop was asked to fix and re-QA.
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
