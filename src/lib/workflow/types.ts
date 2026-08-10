/**
 * Core types for workflow execution
 */

import { z } from "zod";
import type { AiderSettings } from "../settings.js";
import type { LogWriter } from "./log-writer.js";
import type { StateManager } from "./state-manager.js";
import type { ShutdownManager } from "../shutdown.js";
import type { WorktreeInfo } from "./worktree-manager.js";
import type { SequantError } from "../errors.js";
import type { ErrorCategory } from "./error-classifier.js";
// Type-only import — erased at compile, so the ready-gate ⇄ types cycle is
// purely nominal (ready-gate.ts imports these types back, also type-only).
import type { ReadyResult } from "./ready-gate.js";

// Importing the registry triggers its side-effect registrations (built-ins
// live at the bottom of phase-registry.ts), guaranteeing the registry is
// populated before any PhaseSchema parse runs.
import { phaseRegistry, getPhaseNames } from "./phase-registry.js";

// Re-export the emitter types so external consumers can import them from
// the workflow types barrel without reaching into the implementation file (#504).
export type {
  WorkflowEventEmitter,
  WorkflowEvents,
  WorkflowEventListener,
  IssueEventStatus,
  BaseEventPayload,
  RunEventPayload,
  PhaseStartedPayload,
  PhaseCompletedPayload,
  PhaseFailedPayload,
  IssueStatusChangedPayload,
  QaVerdictPayload,
  ProgressPayload,
} from "./event-emitter.js";

/**
 * Canonical Zod schema for all workflow phases.
 *
 * Backed by the phase registry. `PhaseSchema.parse(name)` succeeds iff
 * `phaseRegistry.has(name)`. The set of valid phases is the registry's
 * keys at the time of parsing — registration happens at module load,
 * so for normal runtime use the set is fixed by the time any code parses.
 *
 * This replaces the prior `z.enum([...])` literal. The set of valid names
 * is identical for the 9 built-in phases; the only observable behavior
 * change is that `PhaseSchema.options` is no longer available — use
 * `getPhaseNames()` from `phase-registry.ts` instead.
 */
export const PhaseSchema = z
  .string()
  .refine((name) => phaseRegistry.has(name), {
    error: (issue) =>
      `Unknown phase "${String(issue.input)}". Available: ${getPhaseNames().join(", ")}`,
  });

/**
 * Available workflow phases. Widened from a string-literal union to `string`
 * after the registry migration — exhaustiveness checking on `switch (phase)`
 * is now a runtime concern (see the comment in phase-executor.ts where the
 * only relevant switch lives).
 */
export type Phase = string;

/**
 * Lifecycle hook for pausing the run renderer's live zone while verbose
 * Claude streaming writes through stdout, then resuming after the agent
 * call completes. Replaces the legacy `PhaseSpinner` argument (#618).
 *
 * Lives in the workflow types barrel so the cli-ui layer can implement it
 * without the workflow layer reaching back into cli-ui (#656).
 */
export interface PhasePauseHandle {
  pause(): void;
  resume(): void;
  /**
   * #647 AC-3: print a notice line (e.g., retry/fallback message) without
   * breaking log-update's cursor model. Implementations clear the live zone,
   * write the line through the renderer's own stdout channel, then redraw.
   * In quiet / non-TTY paths this degrades to a plain write.
   */
  appendNotice(message: string): void;
}

/**
 * Default phases for workflow execution
 */
export const DEFAULT_PHASES: Phase[] = ["spec", "exec", "qa"];

/**
 * Configuration for workflow execution
 */
export interface ExecutionConfig {
  /** Phases to execute */
  phases: Phase[];
  /** Timeout per phase in seconds */
  phaseTimeout: number;
  /** Enable quality loop mode */
  qualityLoop: boolean;
  /** Max iterations for quality loop */
  maxIterations: number;
  /** Skip verification after exec */
  skipVerification: boolean;
  /** Run issues sequentially */
  sequential: boolean;
  /** Max concurrent issues in parallel mode (default: 3) */
  concurrency: number;
  /** Suppress per-issue spinners and console output (set true when running issues concurrently) */
  parallel: boolean;
  /** Verbose output */
  verbose: boolean;
  /** Disable smart test detection */
  noSmartTests: boolean;
  /** Dry run mode - don't actually execute */
  dryRun: boolean;
  /** Enable MCP servers in headless mode (true by default, false if --no-mcp flag used) */
  mcp: boolean;
  /**
   * Enable automatic retry with MCP fallback.
   * When true (default), failed phases are retried with MCP disabled.
   * When false (--no-retry flag), no retry attempts are made.
   */
  retry?: boolean;
  /**
   * Agent driver to use for phase execution.
   * Default: "claude-code"
   */
  agent?: string;
  /**
   * Isolate parallel agent groups in separate worktrees.
   * Propagated as SEQUANT_ISOLATE_PARALLEL env var to exec skill.
   */
  isolateParallel?: boolean;
  /**
   * Aider-specific configuration. Passed to AiderDriver when agent is "aider".
   */
  aiderSettings?: AiderSettings;
  /**
   * Issue type detected from labels (e.g., "docs").
   * Propagated as SEQUANT_ISSUE_TYPE env var to skills.
   */
  issueType?: string;
  /**
   * Additional context appended to the phase prompt.
   * Used by the quality loop to pass QA findings directly to the /loop skill
   * so it doesn't need to reconstruct context from GitHub comments.
   */
  promptContext?: string;
  /**
   * Last QA verdict from a preceding phase.
   * Propagated as SEQUANT_LAST_VERDICT env var to skills.
   */
  lastVerdict?: string;
  /**
   * Failed AC descriptions from a preceding QA phase.
   * Propagated as SEQUANT_FAILED_ACS env var to skills.
   */
  failedAcs?: string;
  /**
   * Runtime callback invoked when the agent driver emits a chunk of output
   * during phase execution (#543). Used by the multi-issue TUI to enrich
   * `nowLine` with sub-phase activity. Not serialized — set per-call by the
   * orchestrator. The phase executor throttles calls to ~10 Hz so the TUI's
   * poll budget is preserved.
   */
  onActivity?: (text: string) => void;
  /**
   * Runtime callback invoked while an auto-wait (#804) is in progress, once
   * per tick plus once when it ends. Used to keep the renderer and the `-q`
   * heartbeat showing the wait and its wake time, so a multi-hour pause reads
   * as deliberate rather than as the silent stall of #574. Not serialized —
   * set per-call by the orchestrator, like {@link onActivity}.
   */
  onAutoWait?: (notice: AutoWaitNotice) => void;
  /**
   * Enable interactive relay (#383). When true, phase-executor sets
   * `SEQUANT_RELAY=true` in the agent environment so the PostToolUse hook
   * starts polling `<worktree>/.sequant/relay/inbox.jsonl` for user messages.
   * Default: false (opt-in for the initial rollout).
   */
  relayEnabled?: boolean;
  /**
   * Force full-weight (standalone) QA even under an orchestrator (#683).
   * When true, the phase executor sets `SEQUANT_FULL_QA=1` in the agent
   * environment for the `qa` phase. The QA skill honors this flag by running
   * its standalone branch-freshness / process-state pre-flight checks even
   * though `SEQUANT_ORCHESTRATOR` is also set. Used by `sequant ready` so its
   * QA pass does NOT skip the checks that catch the #318/#529/#570 class.
   */
  fullQa?: boolean;
  /**
   * Run the post-QA ready gate after the standard phases succeed (#817).
   *
   * When true, `runIssueWithLogging` invokes the existing `sequant ready`
   * engine (`runReadyGate`) at the PR seam — before rebase/PR so the gate's
   * auto-fix commits land in the PR — driving the issue to the configured
   * `settings.ready.policy` threshold. It NEVER merges: the run terminates with
   * the issue in `waiting_for_human_merge` (ready) or `blocked` (guard halt).
   * Default off; when unset the run path is byte-identical to pre-#817.
   */
  readyGate?: boolean;
  /**
   * Total wait budget, in minutes, for auto-waiting out an exhausted
   * rate-limit window (#804). `0` (the default) disables auto-wait entirely,
   * preserving the #761/#799 halt behavior byte-for-byte.
   *
   * When a phase fails with a window-exhausted `RateLimitError` whose reset
   * lies within the remaining budget, the executor sleeps until the reset and
   * retries the phase instead of returning the failure. Named for the
   * *behavior* (waiting), not the mechanism, so it survives a future move from
   * in-process sleep to out-of-process rescheduling.
   *
   * This is a TOTAL budget across the issue, not a per-occurrence allowance —
   * see {@link AutoWaitLedger}.
   */
  autoWaitMinutes?: number;
  /**
   * Resolved per-phase `model`/`effort` overrides (#914), keyed by phase
   * name. Merged from `settings.run.phases` and the CLI's `--models`/
   * `--efforts` flags via `resolvePhasePolicies` (CLI > settings > absent) —
   * see `config-resolver.ts`. Absent/empty by default: `phase-executor.ts`
   * only sets `AgentExecutionConfig.model`/`.effort` when a phase has an
   * entry here, so an unconfigured run reaches the SDK unchanged.
   */
  phasePolicies?: Record<string, { model?: string; effort?: string }>;
  /**
   * Evidence-based effort escalation on quality-loop retries (#915). CLI >
   * settings > absent (`false`), resolved by `buildExecutionConfig`
   * (`config-resolver.ts`) and `ready-gate.ts`'s `buildPhaseConfig` — the same
   * two producers `phasePolicies` uses, so this cannot drift from that one
   * (#833 class). Consumed only at dispatch time by
   * `effort-escalation.ts`'s `withEscalatedEffort`, never baked statically
   * into `phasePolicies` here — escalation is per-execution, not per-run.
   */
  effortEscalation?: boolean;
}

/**
 * A single liveness notice emitted during an auto-wait (#804 AC-7).
 */
export interface AutoWaitNotice {
  /** Issue the wait belongs to. */
  issueNumber: number;
  /** Phase whose retry is being waited for. */
  phase: string;
  /** Epoch ms at which the wait ends (reset + buffer). */
  wakeAtMs: number;
  /** Ms remaining at the time of this notice. `0` on the final notice. */
  remainingMs: number;
  /**
   * Display string, already formatted. Built from `formatRateLimitMessage`
   * plus the wake time — never by re-appending `resetsAt` to an
   * already-formatted driver message (the #799 doubled-string trap).
   */
  message: string;
  /** True on the terminal notice, once the wait has ended or been aborted. */
  done: boolean;
}

/**
 * Default execution configuration
 */
export const DEFAULT_CONFIG: ExecutionConfig = {
  phases: DEFAULT_PHASES,
  phaseTimeout: 1800,
  qualityLoop: false,
  maxIterations: 3,
  skipVerification: false,
  sequential: false,
  concurrency: 3,
  parallel: false,
  verbose: false,
  noSmartTests: false,
  dryRun: false,
  mcp: true,
  retry: true,
  autoWaitMinutes: 0,
};

// Re-export QaVerdict from run-log-schema (single source of truth)
import type { QaVerdict, QaSummary } from "./run-log-schema.js";
export type { QaVerdict, QaSummary } from "./run-log-schema.js";

/**
 * Result of executing a single phase
 */
export interface PhaseResult {
  phase: Phase;
  success: boolean;
  durationSeconds?: number;
  error?: string;
  /**
   * Typed error with structured cause data, propagated from the driver's
   * `AgentPhaseResult.structuredError` (#732). When present, the retry logic
   * prefers it over stderr-regex classification and uses its type to gate the
   * MCP fallback (a `BillingError` skips the misleading retry — #592).
   */
  structuredError?: SequantError;
  /**
   * Set when the phase hit its turn cap (`error_max_turns`), propagated from the
   * driver's `AgentPhaseResult.capped` (#733/#739). A capped phase is
   * incomplete-but-not-hard-failed: the partial work in `output` is preserved
   * rather than discarded, and the retry logic treats it like the `BillingError`
   * skip (#732) — a retry cannot un-cap a turn limit. Additive/optional, same
   * shape as `structuredError?`; existing consumers are unaffected.
   */
  capped?: boolean;
  /** Captured output from the phase (used for parsing spec recommendations) */
  output?: string;
  /** Parsed QA verdict (only for qa phase) */
  verdict?: QaVerdict;
  /** Condensed QA summary with AC coverage (#434) */
  summary?: QaSummary;
  /** Last N lines of stderr captured from the agent process (#447) */
  stderrTail?: string[];
  /** Last N lines of stdout captured from the agent process (#447) */
  stdoutTail?: string[];
  /** Process exit code from the agent driver (#447) */
  exitCode?: number;
  /**
   * Set when this execution's effort was escalated one tier above its
   * resolved base (#915) — a quality-loop retry with `effortEscalation`
   * enabled. Additive/optional, same shape as `capped?`/`structuredError?`;
   * absent on every non-escalated execution.
   */
  escalatedEffort?: { base: string; escalated: string };
}

/**
 * Result of executing all phases for an issue
 */
export interface IssueResult {
  issueNumber: number;
  success: boolean;
  phaseResults: PhaseResult[];
  abortReason?: string;
  loopTriggered?: boolean;
  durationSeconds?: number;
  /** PR number if created after successful QA */
  prNumber?: number;
  /** PR URL if created after successful QA */
  prUrl?: string;
  /**
   * Set when PR creation was attempted after passing QA but failed (#879).
   * A failed `createPR` used to be a non-fatal yellow warning while the issue
   * still reported success — so a run could "pass" while producing no PR. When
   * present, `success` is false and the run summary counts the issue as failed
   * with this string as the reason.
   */
  prCreationError?: string;
  /**
   * Set when PR creation was skipped because the branch carried zero commits
   * ahead of its base (#920) — a phase-restricted run (e.g. `--phases spec`)
   * that implemented nothing has no deliverable to open a PR for, and
   * attempting one would only fail with GitHub's "No commits between main and
   * …" error. Distinct from {@link IssueResult.prCreationError}: this is not
   * a failure — `success` stays whatever the phases produced.
   */
  prSkippedReason?: string;
  /**
   * Set when the issue was skipped because another sequant session holds
   * the per-issue lock (#625). Surfaced in the summary as
   * `locked by PID <n>`. When present, `success` is false and the issue
   * was not executed.
   */
  locked?: {
    pid: number;
    hostname: string;
    startedAt: string;
    command: string;
  };
  /**
   * Set true when the chain-mode checkpoint commit could not be written after
   * this link passed QA (#760). The link's own work is done, but the recovery
   * point resume depends on is missing — surfaced prominently so a later resume
   * failing fast (AC-3) is expected, not surprising.
   */
  checkpointFailed?: boolean;
  /**
   * Bounded-enum classification of the failure that halted this issue (#761
   * AC-7), derived from the last non-loop failing phase's `structuredError`
   * (preferred) or stderr-regex classification. Carried into
   * `.sequant/metrics.json` — enum only, never a message string (metrics
   * privacy contract). Absent on success.
   */
  failureCategory?: ErrorCategory;
  /**
   * Outcome of the post-QA ready gate (#817), present only when the run was
   * invoked with `--ready-gate` and the gate actually ran (i.e. the standard
   * phases succeeded). Carries the terminal reason, the persisted issue status
   * (`waiting_for_human_merge` / `blocked` — never merged), and the rendered
   * report the summary and PR body surface. Absent on runs without the flag.
   */
  readyGate?: ReadyResult;
  /**
   * Why the ready gate did NOT run, when `--ready-gate` was requested but the
   * gate threw (#817). Mutually exclusive with {@link IssueResult.readyGate}.
   *
   * A gate crash is deliberately non-fatal — the phase work is already
   * committed and the PR still opens — but it must not be silent. Without this
   * field a run whose gate died is byte-identical in the summary to one that
   * never asked for a gate, so the user believes a second look happened when it
   * did not. The summary renders this as an explicit "gate did not run" line.
   */
  readyGateError?: string;
}

/**
 * CLI options for the run command, merged with settings and env config.
 * Moved from batch-executor.ts for use in IssueExecutionContext (#402).
 */
export interface RunOptions {
  phases?: string;
  sequential?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  timeout?: number;
  logJson?: boolean;
  noLog?: boolean;
  logPath?: string;
  qualityLoop?: boolean;
  /**
   * #705: hidden `-q` alias for the quality loop. Commander 14 allows only one
   * short flag per Option, so `-q` lives on its own `--quality-loop-alias`
   * Option and `runCommand` ORs it into `qualityLoop` before any consumer reads
   * it. `-q` no longer maps to `--quiet` (which moved to `-s`).
   */
  qualityLoopAlias?: boolean;
  maxIterations?: number;
  batch?: string[];
  smartTests?: boolean;
  noSmartTests?: boolean;
  testgen?: boolean;
  securityReview?: boolean;
  autoDetectPhases?: boolean;
  /** Enable automatic worktree creation for issue isolation */
  worktreeIsolation?: boolean;
  /** Suppress version warnings and non-essential output */
  quiet?: boolean;
  /** Chain issues: each branches from previous (requires --sequential) */
  chain?: boolean;
  /**
   * Stacked PRs: each non-first PR targets its predecessor branch instead of
   * `main`. Implies --chain. The final PR still targets `main` so partial
   * progress can land without the whole stack. (#605)
   */
  stacked?: boolean;
  /**
   * Wait for QA pass before starting next issue in chain mode.
   * When enabled, the chain pauses if QA fails, preventing downstream issues
   * from building on potentially broken code.
   */
  qaGate?: boolean;
  /**
   * Make `--chain` content pre-flight warnings fatal (#762).
   * By default the pre-flight (missing AC section, dependency-order and
   * file-overlap-order contradictions, closed issues) only warns. When true,
   * any warning aborts the run BEFORE the first worktree is provisioned.
   */
  strictPreflight?: boolean;
  /**
   * Base branch for worktree creation.
   * Resolution priority: this CLI flag → settings.run.defaultBase → 'main'
   */
  base?: string;
  /**
   * Disable MCP servers in headless mode.
   * When true, MCPs are not passed to the SDK (faster/cheaper runs).
   * Resolution priority: this CLI flag → settings.run.mcp → default (true)
   */
  noMcp?: boolean;
  /**
   * Total minutes willing to wait for an exhausted rate-limit window to reopen
   * before halting (#804). `0` (default) keeps today's immediate halt.
   * Resolution priority: this CLI flag → SEQUANT_AUTO_WAIT_MINUTES →
   * settings.run.autoWaitMinutes → default (0).
   */
  autoWaitMinutes?: number;
  /**
   * Resume from last completed phase.
   * Reads phase markers from GitHub issue comments and skips completed phases.
   */
  resume?: boolean;
  /**
   * Disable automatic retry with MCP fallback.
   * When true, no retry attempts are made on phase failure.
   * Useful for debugging to see the actual failure without retry masking it.
   */
  noRetry?: boolean;
  /**
   * Skip pre-PR rebase onto the base branch.
   * When true, branches are not rebased before creating the PR.
   * Use when you want to preserve branch state or handle rebasing manually.
   */
  noRebase?: boolean;
  /**
   * Skip PR creation after successful QA.
   * When true, branches are pushed but no PR is created.
   * Useful for manual workflows where PRs are created separately.
   */
  noPr?: boolean;
  /**
   * Force re-execution of issues even if they have completed status.
   * Bypasses the pre-flight state guard that skips completed issues — see
   * `isCompletedIssueStatus` (completed-status.ts) for exactly which statuses
   * that covers, and why `blocked` is not one of them.
   */
  force?: boolean;
  /**
   * Analyze run results and suggest workflow improvements.
   * Displays observations about timing patterns, phase mismatches, and
   * actionable suggestions after the summary output.
   */
  reflect?: boolean;
  /**
   * Max concurrent issues in parallel mode (default: 3).
   * Only applies when --sequential is not set.
   */
  concurrency?: number;
  /**
   * Agent driver for phase execution.
   * Default: "claude-code"
   */
  agent?: string;
  /**
   * Isolate parallel agent groups in separate worktrees.
   * When true, each agent in a parallel group gets its own sub-worktree.
   * Resolution priority: CLI flag → settings.agents.isolateParallel → false
   */
  isolateParallel?: boolean;
  /**
   * #705: the boxed Ink dashboard is the default on a TTY. Set via `--no-tui`,
   * which Commander surfaces as `options.tui === false` to opt out to the
   * line-based phase-matrix renderer. Non-TTY / piped output auto-degrades, and
   * `--quiet`/`-s` suppresses the renderer entirely regardless of this flag.
   * Resolution: `tuiEnabled = options.tui !== false && isTTY && !quiet`.
   */
  tui?: boolean;
  /**
   * #705: now a hidden no-op alias — the boxed Ink TUI is the default, so
   * `--experimental-tui` only parses for backward compatibility and no longer
   * gates rendering. Kept so existing scripts/muscle-memory don't break.
   *
   * INTENTIONALLY INERT — do not delete (#810). A dead-surface sweep of
   * `RunOptions` will correctly observe that nothing branches on this field.
   * That is the design, not a defect: the flag's whole job is to parse and do
   * nothing, so scripts written against #705 keep working. Its inertness is
   * asserted, not incidental — `run-flags.test.ts` ("--experimental-tui is a
   * no-op"), `cli.integration.test.ts` (hidden from `--help`, still parses),
   * and `run-tui.integration.test.ts` all pin it. Contrast `reuseWorktrees`,
   * removed in #810: that field had no flag, no consumer, and no test, so it
   * promised behavior nothing delivered. The distinction is a flag deliberately
   * kept parseable versus a type field nobody could ever reach.
   */
  experimentalTui?: boolean;
  /**
   * With `--force`, SIGTERM the prior PID holding the per-issue lock
   * before claiming it. Only acts on same-host alive PIDs. (#625)
   */
  signalOther?: boolean;
  /**
   * Interactive relay (#383). Set via `--no-relay`, which Commander surfaces as
   * `options.relay = false`. When `false`, the PostToolUse hook is not
   * activated and `sequant prompt` cannot reach this run.
   * Resolution priority: this CLI flag → settings.run.relay → default (true).
   */
  relay?: boolean;
  /**
   * Run the post-QA ready gate after the standard phases succeed (#817). Set via
   * `--ready-gate`. When true, the run drives the issue to the configured
   * `settings.ready.policy` threshold through the existing `sequant ready`
   * engine before creating the PR, then STOPS at the human merge gate — it never
   * merges. Off by default; opt-in only, so an unset flag leaves the run path
   * (including the #749 break-to-PR behavior) unchanged. Reuses `ready`'s policy
   * and bounds wholesale — no new settings accompany this flag.
   */
  readyGate?: boolean;
  /**
   * Per-phase model override (#914). Either a bare value applied to every
   * phase (`--models sonnet`) or a comma list of `phase=model` pairs
   * (`--models spec=fable,exec=sonnet`). Parsed and merged with
   * `settings.run.phases` by `resolvePhasePolicies` (CLI > settings >
   * absent) into `ExecutionConfig.phasePolicies`. Malformed specs fail fast
   * at the Commander option boundary via `cli-flags.ts`.
   */
  models?: string;
  /**
   * Per-phase reasoning-effort override (#914). Same grammar as {@link
   * models} (bare value or comma list of `phase=effort` pairs); each value
   * validates against the SDK's closed `low|medium|high|xhigh|max` enum.
   */
  efforts?: string;
  /**
   * Evidence-based effort escalation on quality-loop retries (#915). Set via
   * `--escalate-effort`. When true, a retried phase execution resolves one
   * effort tier above its configured/inherited base for that execution only
   * — see `effort-escalation.ts`. Default `false`: escalation raises token
   * spend, so an unset flag leaves every run byte-identical to pre-#915.
   */
  escalateEffort?: boolean;
}

/**
 * CLI arguments for run command
 */
export interface RunCommandOptions {
  issues: number[];
  phases?: string;
  sequential?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  timeout?: number;
  maxIterations?: number;
  qualityLoop?: boolean;
}

/**
 * Batch of issues to run together
 */
export interface IssueBatch {
  batchNumber: number;
  issues: number[];
}

/**
 * Result of a batch execution
 */
export interface BatchResult {
  batchNumber: number;
  issueResults: IssueResult[];
  success: boolean;
}

/**
 * Callback type for per-phase progress updates.
 * Used by parallel mode in run.ts to render phase status to the terminal.
 *
 * `extra.iteration` (#624 Item 3): outer quality-loop iteration. Threaded
 * through to the renderer as `(attempt N/M)` on retried phase events and
 * `loop N/M` on loop-phase live-zone status cells.
 *
 * `"activity"` (#543): sub-phase activity ping. `extra.text` carries a short
 * one-line snippet (e.g. last line of agent output) for the dashboard's
 * `nowLine`. Fires at most ~10 Hz from the phase executor.
 *
 * `"waiting"` (#804): an auto-wait for a rate-limit window is in progress.
 * `extra.text` is the display message and `extra.wakeAtMs` the wake time;
 * a `"waiting"` event WITHOUT `wakeAtMs` is the terminal notice that clears
 * the waiting state. Unlike `"activity"`, this must reach both display paths
 * — a multi-hour pause with no signal is the #574 complaint at 60x scale.
 */
export type ProgressCallback = (
  issue: number,
  phase: string,
  event: "start" | "complete" | "failed" | "activity" | "waiting",
  extra?: {
    durationSeconds?: number;
    error?: string;
    iteration?: number;
    text?: string;
    /**
     * `"waiting"` (#804): epoch ms at which an auto-wait ends. Absent on the
     * terminal notice, which clears the waiting state.
     */
    wakeAtMs?: number;
  },
) => void;

/**
 * #672 AC-2: fired once per issue after the executor has resolved the final
 * phase pipeline (post auto-detect, post resume filter, post testgen /
 * security-review insertion). Lets the run renderer seed pending cells for
 * the full roadmap before any phase fires, so users see what is about to run
 * instead of phases appearing one at a time as they stream.
 *
 * Empty `phases` means "no plan known" — the renderer should fall back to
 * streaming-only display.
 */
export type PhasePlanCallback = (issue: number, phases: string[]) => void;

/**
 * Shared context for executing a batch of issues.
 * Replaces 11 positional parameters in executeBatch (#402).
 */
export interface BatchExecutionContext {
  config: ExecutionConfig;
  options: RunOptions;
  issueInfoMap: Map<number, { title: string; labels: string[] }>;
  worktreeMap: Map<number, WorktreeInfo>;
  logWriter: LogWriter | null;
  stateManager: StateManager | null;
  shutdownManager?: ShutdownManager;
  packageManager?: string;
  baseBranch?: string;
  onProgress?: ProgressCallback;
  /** #672 AC-2: forwarded to per-issue context so batch-executor can fire it
   * once the final phase pipeline is known. */
  onPhasePlan?: PhasePlanCallback;
  /**
   * Optional live-zone pause handle (#656). When set, the phase executor calls
   * `pause()` before forwarding verbose Claude SDK output to stdout and
   * `resume()` after the agent call completes — so the 1Hz live grid does not
   * collide with streaming text. Wired from the active `RunRenderer` at the
   * composition root in `run.ts`; left undefined for quiet/TUI modes.
   */
  phasePauseHandle?: PhasePauseHandle;
}

/**
 * Context object for executing a single issue through the workflow.
 * Replaces 15 positional parameters in runIssueWithLogging (#402).
 */
export interface IssueExecutionContext {
  /** GitHub issue number */
  issueNumber: number;
  /** Issue title for display and PR creation */
  title: string;
  /** GitHub labels for phase detection and issue type */
  labels: string[];
  /** Execution configuration (phases, timeouts, flags) */
  config: ExecutionConfig;
  /** CLI options merged with settings and env */
  options: RunOptions;
  /** Services used during execution */
  services: {
    logWriter: LogWriter | null;
    stateManager: StateManager | null;
    shutdownManager?: ShutdownManager;
  };
  /** Worktree info (when worktree isolation is enabled) */
  worktree?: {
    path: string;
    branch: string;
  };
  /** Chain mode settings */
  chain?: {
    enabled: boolean;
    isLast: boolean;
    /**
     * Stacked-PR base branch for this issue. Set only when --stacked is active
     * and this issue has a predecessor in the chain. When set, createPR targets
     * this branch instead of `main`. (#605)
     */
    predecessorBranch?: string;
    /**
     * Pre-rendered stack manifest line for the PR body, e.g.
     * `Part of stack: #100 → #101 (this) → #102`. Set only under --stacked.
     */
    stackManifest?: string;
  };
  /** Package manager name (e.g., "npm", "pnpm") */
  packageManager?: string;
  /** Base branch for rebase/PR (e.g., "main") */
  baseBranch?: string;
  /** Per-phase progress callback (used in parallel mode) */
  onProgress?: ProgressCallback;
  /** #672 AC-2: invoked once after the per-issue phase plan resolves. */
  onPhasePlan?: PhasePlanCallback;
  /**
   * Optional live-zone pause handle (#656). Forwarded to
   * `executePhaseWithRetry` so the renderer's `pause`/`resume` hooks fire
   * around verbose Claude streaming.
   */
  phasePauseHandle?: PhasePauseHandle;
}
