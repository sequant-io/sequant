/**
 * Batch execution and dependency handling for sequant run.
 *
 * Contains functions for fetching issue metadata, parsing and sorting
 * dependencies, splitting issues into batches, reading environment-based
 * configuration, and orchestrating the execution of individual issues
 * (including quality-loop retries, checkpoint commits, rebasing, and PR
 * creation).
 */

import chalk from "chalk";
import { spawnSync } from "child_process";
import { createPhaseLogFromTiming, LogWriter } from "./log-writer.js";
import {
  Phase,
  ExecutionConfig,
  PhaseResult,
  IssueResult,
  type RunOptions,
  type IssueExecutionContext,
  type BatchExecutionContext,
  type ProgressCallback,
  type PhasePauseHandle,
} from "./types.js";
import type { ShutdownManager } from "../shutdown.js";
import {
  classifyError,
  errorTypeToCategory,
  type ErrorCategory,
} from "./error-classifier.js";
import type { ErrorContext } from "./run-log-schema.js";
import {
  getGitDiffStats,
  getCommitHash,
  resolveDiffBase,
} from "./git-diff-utils.js";
import {
  createCheckpointCommit,
  rebaseBeforePR,
  createPR,
  readCacheMetrics,
  filterResumedPhases,
} from "./worktree-manager.js";
import {
  AUTO_WAIT_BUFFER_MS,
  createAutoWaitLedger,
  executePhaseWithRetry,
  isWindowExhaustedRateLimit,
} from "./phase-executor.js";
import { BillingError, RateLimitError, resetsAtToMs } from "../errors.js";
import type { StateManager } from "./state-manager.js";
import { parseBodyDependencyMarkers } from "./dependency-markers.js";
import type { ResumeHandle } from "./drivers/index.js";
import {
  detectPhasesFromLabels,
  parseRecommendedWorkflow,
  determinePhasesForIssue,
  DOCS_LABELS,
} from "./phase-mapper.js";
import {
  activateRelay,
  deactivateRelay,
  type ActivationResult,
} from "../relay/activation.js";
import { getSettings } from "../settings.js";
import { GitHubProvider } from "./platforms/github.js";
import {
  runReadyGate,
  parseNonGoals,
  type ReadyResult,
  type ReadyPhaseRunner,
} from "./ready-gate.js";

// Re-export types moved to types.ts (#402)
export type {
  RunOptions,
  ProgressCallback,
  IssueExecutionContext,
  BatchExecutionContext,
} from "./types.js";

/**
 * Emit a structured progress line to stderr for MCP progress notifications.
 * Only emits when running under an orchestrator (e.g., MCP server).
 * The MCP handler parses these lines to send `notifications/progress`.
 *
 * @param issue - GitHub issue number
 * @param phase - Phase name (e.g., "spec", "exec", "qa")
 * @param event - Phase lifecycle event: "start", "complete", or "failed"
 * @param extra - Optional fields: durationSeconds (on complete), error (on failed)
 */

/**
 * Wrap an `ExecutionConfig` with the runtime liveness hooks:
 * - `onActivity` — re-emits each agent-output ping as an `"activity"` progress
 *   event for the dashboard (#543).
 * - `onAutoWait` — re-emits each auto-wait tick as a `"waiting"` progress
 *   event so the renderer and heartbeat can show the pause and its wake time
 *   (#804 AC-7). Under `SEQUANT_ORCHESTRATOR` it additionally emits throttled
 *   `SEQUANT_PROGRESS` waiting lines (#860): an MCP-driven wait was previously
 *   invisible on the JSON channel — indistinguishable from a hang — AND was
 *   killed by the MCP inactivity timeout, which resets on progress lines.
 *   Optionally notifies `onWaitTransition` on wait start/end so the caller
 *   can persist the wait to issue state (`sequant status` truthfulness).
 *
 * Returns the input config unchanged when there is no consumer at all (no
 * `onProgress`, no orchestrator channel, no transition callback), so plain
 * non-TUI runs pay no overhead.
 *
 * @internal Exported for testing only
 */
export function withActivityHook(
  base: ExecutionConfig,
  issueNumber: number,
  phase: string,
  onProgress: ProgressCallback | undefined,
  onWaitTransition?: (wakeAtMs: number | null) => void,
): ExecutionConfig {
  const orchestrated = Boolean(process.env.SEQUANT_ORCHESTRATOR);
  if (!onProgress && !orchestrated && !onWaitTransition) return base;

  // Throttle the orchestrator waiting lines: the wait ticks every ~15s, and
  // one JSON line per minute is enough to keep the MCP inactivity timeout
  // alive (it resets on every SEQUANT_PROGRESS line) without bloating the
  // captured stderr over a multi-hour pause.
  let lastWaitLineAt = 0;
  let waitAnnounced = false;

  return {
    ...base,
    onActivity: (text: string) => {
      try {
        onProgress?.(issueNumber, phase, "activity", { text });
      } catch {
        // Activity events must never disrupt the run.
      }
    },
    onAutoWait: (notice) => {
      try {
        onProgress?.(issueNumber, phase, "waiting", {
          text: notice.message,
          // Omitted on the terminal notice — its absence is what tells the
          // consumers to clear the waiting state.
          wakeAtMs: notice.done ? undefined : notice.wakeAtMs,
        });
      } catch {
        // Liveness notices must never disrupt the run.
      }
      try {
        if (notice.done) {
          if (waitAnnounced) {
            waitAnnounced = false;
            lastWaitLineAt = 0;
            emitProgressLine(issueNumber, phase, "waiting", {
              remainingMs: 0,
            });
            onWaitTransition?.(null);
          }
        } else {
          if (!waitAnnounced) {
            waitAnnounced = true;
            onWaitTransition?.(notice.wakeAtMs);
          }
          const now = Date.now();
          if (now - lastWaitLineAt >= AUTO_WAIT_PROGRESS_LINE_INTERVAL_MS) {
            lastWaitLineAt = now;
            emitProgressLine(issueNumber, phase, "waiting", {
              wakeAtMs: notice.wakeAtMs,
              remainingMs: notice.remainingMs,
            });
          }
        }
      } catch {
        // Liveness notices must never disrupt the run.
      }
    },
  };
}

/**
 * Cadence of orchestrator-channel waiting lines during an auto-wait (#860).
 * See {@link withActivityHook}.
 *
 * @internal Exported for testing only
 */
export const AUTO_WAIT_PROGRESS_LINE_INTERVAL_MS = 60_000;

/**
 * Build enriched prompt context for the /loop phase from a failed phase result (#488).
 * Passes QA verdict, failed ACs, and error directly so the /loop skill doesn't need
 * to reconstruct context from GitHub comments (which fails in subprocess).
 *
 * @internal Exported for testing only
 */
export function buildLoopContext(failedResult: PhaseResult): string {
  const parts: string[] = [`Previous phase "${failedResult.phase}" failed.`];

  if (failedResult.verdict) {
    parts.push(`QA Verdict: ${failedResult.verdict}`);
  }

  if (failedResult.summary?.gaps?.length) {
    parts.push(
      `QA Gaps:\n${failedResult.summary.gaps.map((gap) => `- ${gap}`).join("\n")}`,
    );
  }

  if (failedResult.summary?.suggestions?.length) {
    parts.push(
      `Suggestions:\n${failedResult.summary.suggestions.map((s) => `- ${s}`).join("\n")}`,
    );
  }

  if (failedResult.error) {
    parts.push(`Error: ${failedResult.error}`);
  }

  // Include tail of output for additional context (truncated to avoid prompt bloat)
  if (failedResult.output) {
    const tail = failedResult.output.slice(-2000);
    parts.push(`Last output:\n${tail}`);
  }

  return parts.join("\n\n");
}

export function emitProgressLine(
  issue: number,
  phase: string,
  event: "start" | "complete" | "failed" | "waiting" = "start",
  extra?: {
    durationSeconds?: number;
    error?: string;
    iteration?: number;
    wakeAtMs?: number;
    remainingMs?: number;
  },
): void {
  if (!process.env.SEQUANT_ORCHESTRATOR) return;
  const payload: Record<string, unknown> = { issue, phase, event };
  if (extra?.durationSeconds !== undefined) {
    payload.durationSeconds = extra.durationSeconds;
  }
  if (extra?.error !== undefined) {
    payload.error = extra.error;
  }
  // #624 Item 3: surface the outer-loop iteration so MCP consumers (and the
  // renderer) can label retried events as `(attempt N/M)` / `loop N/M`.
  if (extra?.iteration !== undefined) {
    payload.iteration = extra.iteration;
  }
  // #860: auto-wait liveness. `wakeAtMs` is present while waiting and absent
  // on the terminal notice (`remainingMs: 0`), mirroring the in-process
  // ProgressCallback convention. Every line — waiting included — resets the
  // MCP inactivity timeout (prefix-matched in spawnAsync), which is what
  // keeps a legitimate multi-hour pause from being killed as "no progress".
  if (extra?.wakeAtMs !== undefined) {
    payload.wakeAtMs = extra.wakeAtMs;
  }
  if (extra?.remainingMs !== undefined) {
    payload.remainingMs = extra.remainingMs;
  }
  const line = `SEQUANT_PROGRESS:${JSON.stringify(payload)}\n`;
  process.stderr.write(line);
}

/**
 * Emit the current run's UUID on stderr so MCP callers can look up the exact
 * log file produced by this subprocess instead of relying on a fuzzy time
 * filter (#631). Gated on `SEQUANT_ORCHESTRATOR` so CLI users see nothing.
 *
 * Must be called before `emitProgressLine` to satisfy AC-1.
 */
export function emitRunIdLine(runId: string): void {
  if (!process.env.SEQUANT_ORCHESTRATOR) return;
  process.stderr.write(`SEQUANT_RUN_ID:${runId}\n`);
}

export async function getIssueInfo(
  issueNumber: number,
): Promise<{ title: string; labels: string[] }> {
  try {
    const result = spawnSync(
      "gh",
      ["issue", "view", String(issueNumber), "--json", "title,labels"],
      { stdio: "pipe" },
    );

    if (result.status === 0) {
      const data = JSON.parse(result.stdout.toString());
      return {
        title: data.title || `Issue #${issueNumber}`,
        labels: Array.isArray(data.labels)
          ? data.labels.map((l: { name: string }) => l.name)
          : [],
      };
    }
  } catch {
    // Ignore errors, use defaults
  }

  return { title: `Issue #${issueNumber}`, labels: [] };
}

/**
 * Parse dependencies from issue body and labels
 * Returns array of issue numbers this issue depends on
 */
export function parseDependencies(issueNumber: number): number[] {
  try {
    const result = spawnSync(
      "gh",
      ["issue", "view", String(issueNumber), "--json", "body,labels"],
      { stdio: "pipe" },
    );

    if (result.status !== 0) return [];

    const data = JSON.parse(result.stdout.toString());
    const dependencies: number[] = [];

    // Parse from body: line-leading "Depends on: #123" / "**Depends on**: #123".
    // Delegates to the shared, hardened parser (#767): mid-sentence prose,
    // in-fence examples, and inline-code mentions are ignored, and the `#` is
    // required. Honors ONLY `depends on` — the sorter must not start reordering
    // on `blocked by`, which would be a new silent-reorder class (#762 Open Q #3).
    if (data.body) {
      dependencies.push(
        ...parseBodyDependencyMarkers(data.body, ["depends on"]),
      );
    }

    // Parse from labels: "depends-on/123" or "depends-on-123"
    if (data.labels && Array.isArray(data.labels)) {
      for (const label of data.labels) {
        const labelName = label.name || label;
        const labelMatch = labelName.match(/depends-on[-/](\d+)/i);
        if (labelMatch) {
          dependencies.push(parseInt(labelMatch[1], 10));
        }
      }
    }

    return [...new Set(dependencies)]; // Remove duplicates
  } catch {
    return [];
  }
}

/**
 * Sort issues by dependencies (topological sort)
 * Issues with no dependencies come first, then issues that depend on them
 */
export function sortByDependencies(issueNumbers: number[]): number[] {
  // Build dependency graph
  const dependsOn = new Map<number, number[]>();
  for (const issue of issueNumbers) {
    const deps = parseDependencies(issue);
    // Only include dependencies that are in our issue list
    dependsOn.set(
      issue,
      deps.filter((d) => issueNumbers.includes(d)),
    );
  }

  // Topological sort using Kahn's algorithm
  const inDegree = new Map<number, number>();
  for (const issue of issueNumbers) {
    inDegree.set(issue, 0);
  }
  for (const deps of dependsOn.values()) {
    for (const dep of deps) {
      inDegree.set(dep, (inDegree.get(dep) || 0) + 1);
    }
  }

  // Note: inDegree counts how many issues depend on each issue
  // We want to process issues that have no dependencies first,
  // so dependent issues come after their prerequisites
  const sorted: number[] = [];
  const queue: number[] = [];

  // Start with issues that have no dependencies
  for (const issue of issueNumbers) {
    const deps = dependsOn.get(issue) || [];
    if (deps.length === 0) {
      queue.push(issue);
    }
  }

  const visited = new Set<number>();
  while (queue.length > 0) {
    const issue = queue.shift()!;
    if (visited.has(issue)) continue;
    visited.add(issue);
    sorted.push(issue);

    // Find issues that depend on this one
    for (const [other, deps] of dependsOn.entries()) {
      if (deps.includes(issue) && !visited.has(other)) {
        // Check if all dependencies of 'other' are satisfied
        const allDepsSatisfied = deps.every((d) => visited.has(d));
        if (allDepsSatisfied) {
          queue.push(other);
        }
      }
    }
  }

  // Add any remaining issues (circular dependencies or unvisited)
  for (const issue of issueNumbers) {
    if (!visited.has(issue)) {
      sorted.push(issue);
    }
  }

  return sorted;
}

/**
 * Parse batch arguments into groups of issues
 */
export function parseBatches(batchArgs: string[]): number[][] {
  return batchArgs.map((batch) =>
    batch
      .split(/\s+/)
      .map((n) => parseInt(n, 10))
      .filter((n) => !isNaN(n)),
  );
}

/**
 * Parse environment variables for CI configuration
 */
export function getEnvConfig(): Partial<RunOptions> {
  const config: Partial<RunOptions> = {};

  if (process.env.SEQUANT_QUALITY_LOOP === "true") {
    config.qualityLoop = true;
  }

  if (process.env.SEQUANT_MAX_ITERATIONS) {
    const maxIter = parseInt(process.env.SEQUANT_MAX_ITERATIONS, 10);
    if (!isNaN(maxIter)) {
      config.maxIterations = maxIter;
    }
  }

  if (process.env.SEQUANT_SMART_TESTS === "false") {
    config.noSmartTests = true;
  }

  if (process.env.SEQUANT_TESTGEN === "true") {
    config.testgen = true;
  }

  if (process.env.SEQUANT_SECURITY_REVIEW === "true") {
    config.securityReview = true;
  }

  // #804: the env layer for --auto-wait. `resolveRunOptions` does NOT route
  // through the `ConfigResolver` class (it uses `??` chains + this function),
  // so numeric coercion is explicit here rather than free via `coerceEnvValue`.
  // Non-numeric and negative values are ignored so a typo cannot silently
  // enable an unbounded wait.
  if (process.env.SEQUANT_AUTO_WAIT_MINUTES) {
    const autoWait = parseInt(process.env.SEQUANT_AUTO_WAIT_MINUTES, 10);
    if (!isNaN(autoWait) && autoWait >= 0) {
      config.autoWaitMinutes = autoWait;
    }
  }

  return config;
}

/**
 * Record an issue's completion in the run log in ONE place (#879): PR info, the
 * PR-failure status flip, then finalize. Extracted so every batch loop shares a
 * single completion sequence and cannot drift.
 *
 * The #879 defect was exactly such a drift: `markIssueFailed` was wired into
 * `executeBatch`'s loop, but the live `sequant run` path is
 * `RunOrchestrator.executeOneIssue`, which called `setPRInfo` + `completeIssue`
 * without it — so a real run left the run-log status at `success` on a
 * PR-creation failure. Both call sites now go through this helper.
 *
 * A PR-creation failure occurs after every phase has been logged, so
 * `deriveIssueLogStatus` (last run at phase-log time) leaves the issue at
 * `success`; the flip here is what counts it under `failed`. Safe post-hoc:
 * no further phase is logged before `completeIssue`.
 */
export function recordIssueCompletion(
  logWriter: LogWriter,
  result: IssueResult,
  issueNumber?: number,
): void {
  if (result.prNumber && result.prUrl) {
    logWriter.setPRInfo(result.prNumber, result.prUrl, issueNumber);
  }
  if (result.prCreationError) {
    logWriter.markIssueFailed(issueNumber);
  }
  logWriter.completeIssue(issueNumber);
}

/**
 * @deprecated No live caller — `sequant run` executes issues via
 * `RunOrchestrator.executeOneIssue`; this survives only as a
 * `commands/run-compat` re-export. Do not build a new execution loop on it:
 * any path that completes an issue MUST go through
 * {@link recordIssueCompletion}, or the #879 status-drift returns (a
 * completion path that skips the PR-failure flip logs a failed issue as
 * `success`). Slated for removal with the run-compat surface.
 */
export async function executeBatch(
  issueNumbers: number[],
  batchCtx: BatchExecutionContext,
): Promise<IssueResult[]> {
  const {
    config,
    options,
    issueInfoMap,
    worktreeMap,
    logWriter,
    stateManager,
    shutdownManager,
    packageManager,
    baseBranch,
    onProgress,
    onPhasePlan,
    phasePauseHandle,
  } = batchCtx;
  const results: IssueResult[] = [];

  for (const issueNumber of issueNumbers) {
    // Check if shutdown was triggered
    if (shutdownManager?.shuttingDown) {
      break;
    }

    const issueInfo = issueInfoMap.get(issueNumber) ?? {
      title: `Issue #${issueNumber}`,
      labels: [],
    };
    const worktreeInfo = worktreeMap.get(issueNumber);

    // Start issue logging
    if (logWriter) {
      logWriter.startIssue(issueNumber, issueInfo.title, issueInfo.labels);
    }

    const ctx: IssueExecutionContext = {
      issueNumber,
      title: issueInfo.title,
      labels: issueInfo.labels,
      config,
      options,
      services: { logWriter, stateManager, shutdownManager },
      worktree: worktreeInfo
        ? { path: worktreeInfo.path, branch: worktreeInfo.branch }
        : undefined,
      packageManager,
      baseBranch,
      onProgress,
      onPhasePlan,
      phasePauseHandle,
    };
    const result = await runIssueWithLogging(ctx);
    results.push(result);

    // Record PR info, flip status on PR failure (#879), and finalize — all via
    // the shared helper so this loop and the orchestrator path cannot drift.
    if (logWriter) {
      recordIssueCompletion(logWriter, result, issueNumber);
    }
  }

  return results;
}

/**
 * Derive the bounded-enum failure category for a failed issue (#761 AC-7).
 *
 * Scans for the LAST non-loop failing phase — the same reverse scan
 * `toIssueSummary` uses (#766), so the recorded category and the displayed
 * failure reason describe the same attempt. Prefers the driver's structured
 * cause over stderr-regex classification (#732). Returns only the enum value;
 * message strings never leave this function (metrics privacy contract).
 *
 * @internal Exported for testing
 */
export function deriveFailureCategory(
  phaseResults: PhaseResult[],
): ErrorCategory | undefined {
  const failedPhase = [...phaseResults]
    .reverse()
    .find((p) => !p.success && p.phase !== "loop");
  if (!failedPhase) return undefined;
  const typedError =
    failedPhase.structuredError ??
    classifyError(failedPhase.stderrTail ?? [], failedPhase.exitCode);
  return errorTypeToCategory(typedError);
}

/**
 * "Halt, don't loop" predicate for the outer `-Q` quality loop (#799).
 *
 * A billing / out-of-credits failure (`BillingError`) or a window-exhausted
 * rate limit (reset hours away, per `isWindowExhaustedRateLimit`) cannot be
 * recovered by re-running the phase — every retry re-spawns into the same
 * closed window and, worse, mislabels the halt as a downstream
 * `QA completed without a parseable verdict`. Mirrors the `haltedByCap` (#739)
 * treatment: surface the real cause and halt so the user resumes once credits
 * or the rate-limit window are restored.
 *
 * A transient / metadata-absent rate limit is NOT a halt: it returns false and
 * keeps today's outer-loop behavior (the inner retry ladder in `phase-executor`
 * handles its backoff, per #761 AC-4/AC-9).
 *
 * @internal Exported for testing
 */
export function isBillingOrWindowHalt(result: PhaseResult): boolean {
  return isBillingHalt(result) || isWindowHalt(result);
}

/**
 * The billing half of {@link isBillingOrWindowHalt} (#804 AC-8).
 *
 * Split out because the two causes stopped being interchangeable once
 * `--auto-wait` existed: a closed window can now reopen on its own, while
 * out-of-credits cannot — credits are purchased, not waited out. Callers that
 * need to reason about recoverability must be able to tell them apart.
 *
 * @internal Exported for testing
 */
export function isBillingHalt(result: PhaseResult): boolean {
  return result.structuredError instanceof BillingError;
}

/**
 * The rate-limit-window half of {@link isBillingOrWindowHalt} (#804 AC-8).
 *
 * NOTE — this predicate needed no behavioral change for auto-wait, and that is
 * a deliberate finding rather than an oversight. AC-8 anticipated that a phase
 * which waits and then succeeds would still halt the `-Q` loop. It cannot:
 * every call site (`:~700` spec, `:~1030` progress label, `:~1150` halt flag)
 * sits inside the `else` of an `if (result.success)`, so a successful
 * post-wait result never reaches this predicate at all. When auto-wait does
 * NOT fire — the default, an exhausted budget, or a spent wait bound — the
 * result is still a failure carrying a window-exhausted `RateLimitError`, and
 * halting is then the correct outcome (#799 behavior, preserved exactly).
 *
 * @internal Exported for testing
 */
export function isWindowHalt(result: PhaseResult): boolean {
  return isWindowExhaustedRateLimit(result.structuredError);
}

/**
 * Human-readable halt reason for a billing / rate-limit-window failure (#799
 * AC-3). Surfaces the driver's real cause verbatim — `result.error` is already
 * the well-formatted message the driver built via `formatRateLimitMessage`
 * (`Out of credits` for billing, `Rate limited — resets at <local time>` for a
 * throttle with a known reset), so the phase-failed line and run summary name
 * the actual cause instead of a downstream `QA completed without a parseable
 * verdict`.
 *
 * Do NOT re-append `resetsAt` here: the rate-limit message already carries the
 * reset time, and doing so produced a doubled, timezone-inconsistent string
 * (`… resets at 07-24 14:32 — resets at 2026-…Z`). Credits failures carry no
 * reset time by design (they need purchasing, not a window wait).
 *
 * @internal Exported for testing
 */
export function billingHaltReason(result: PhaseResult): string {
  return result.error ?? "Out of credits";
}

/**
 * Epoch ms after which a waitable-window halt can be re-entered (#892 AC-1):
 * the window's `resetsAt` normalized to ms plus the same buffer auto-wait
 * applies (`AUTO_WAIT_BUFFER_MS`), so in-process waits and durable halts wake
 * on the same clock. Returns `null` when the result carries no future-reset
 * rate-limit window — callers must then skip the `windowHalt` write rather
 * than invent a resume time.
 *
 * @internal Exported for testing
 */
export function windowHaltResumeAtMs(result: PhaseResult): number | null {
  if (!isWindowHalt(result)) return null;
  const err = result.structuredError;
  if (!(err instanceof RateLimitError)) return null;
  const resetsAt = err.metadata.resetsAt;
  if (typeof resetsAt !== "number") return null;
  return resetsAtToMs(resetsAt) + AUTO_WAIT_BUFFER_MS;
}

/**
 * Persist or clear the durable `windowHalt` record for a phase result (#892).
 *
 * A waitable-window failure writes `resumeAt` (preserving any re-entry count);
 * every other outcome — success, or a failure whose cause is not a waitable
 * window — clears the record so `sequant resume` never re-enters on a stale
 * or non-waitable halt. Never throws: state bookkeeping must not mask the
 * phase result it describes.
 */
async function recordWindowHaltState(
  stateManager: StateManager | null | undefined,
  issueNumber: number,
  phase: string,
  result: PhaseResult,
): Promise<void> {
  if (!stateManager) return;
  try {
    const resumeAtMs = result.success ? null : windowHaltResumeAtMs(result);
    if (resumeAtMs !== null) {
      await stateManager.updateWindowHalt(issueNumber, phase, resumeAtMs);
    } else {
      await stateManager.clearWindowHalt(issueNumber);
    }
  } catch {
    // State tracking errors shouldn't stop execution
  }
}

/**
 * Arguments for {@link runReadyGateForIssue}. Deliberately a flat primitive
 * bag rather than the full `IssueExecutionContext` so the helper stays cheap to
 * unit-test in isolation.
 */
interface ReadyGateForIssueArgs {
  issueNumber: number;
  worktreePath: string;
  config: ExecutionConfig;
  shutdownManager?: ShutdownManager;
  phasePauseHandle?: PhasePauseHandle;
  onProgress?: ProgressCallback;
  log: (message: string) => void;
  /** @internal Injected for testing — defaults to the real engine. */
  runGate?: typeof runReadyGate;
  /** @internal Injected for testing — defaults to on-disk settings. */
  getSettingsFn?: typeof getSettings;
  /** @internal Injected for testing — defaults to a real GitHubProvider. */
  fetchBody?: (issueNumber: number) => string | null;
}

/**
 * Run the post-QA ready gate (#817) for a single issue at the run path's
 * post-success / pre-PR seam.
 *
 * Mirrors `src/commands/ready.ts`'s driver: resolve the policy from
 * `settings.ready.policy` (no per-run override — AC-4 forbids new surface),
 * parse the issue's Non-Goals for report-only classification, wrap
 * `executePhaseWithRetry` as the gate's phase runner, and delegate the whole
 * qa→loop→qa loop to `runReadyGate`. The token budget stays disabled (parity
 * with `sequant ready` invoked without `--budget`); the `maxIterations` cap
 * already bounds cost.
 *
 * A gate failure is non-fatal: the standard-phase work is already committed to
 * the worktree, so we log a warning and fall through to normal PR creation
 * rather than aborting the run (the issue then keeps its `ready_for_merge`
 * status — the run has degraded to a standard run, and nothing about the work
 * is actually blocked).
 *
 * The failure is returned rather than swallowed. A dropped gate must not be
 * invisible: the caller opted in with `--ready-gate`, so a run whose gate never
 * executed has to look different in the summary from one that gated cleanly —
 * otherwise a crashed gate is indistinguishable from an approved one, and the
 * whole point of the flag (a second look actually happened) is silently lost.
 */
async function runReadyGateForIssue(
  args: ReadyGateForIssueArgs,
): Promise<{ result?: ReadyResult; error?: string }> {
  const {
    issueNumber,
    worktreePath,
    config,
    shutdownManager,
    phasePauseHandle,
    onProgress,
    log,
  } = args;
  const runGate = args.runGate ?? runReadyGate;
  const getSettingsFn = args.getSettingsFn ?? getSettings;
  const fetchBody =
    args.fetchBody ??
    ((n: number) => new GitHubProvider().fetchIssueBodySync(String(n)));

  try {
    const settings = await getSettingsFn();
    const policy = settings.ready.policy;

    // Non-Goals feed the gate's report-only classification (ac mode never
    // auto-fixes Non-Goal-touching findings). Best-effort — an unavailable
    // body just yields no Non-Goals.
    const body = fetchBody(issueNumber);
    const nonGoals = body ? parseNonGoals(body) : [];

    // The gate's phase runner: same executePhaseWithRetry wrapper ready.ts
    // uses, bound to this issue's worktree, shutdown manager, and pause handle.
    const runPhase: ReadyPhaseRunner = (phase, phaseConfig, wt) =>
      executePhaseWithRetry(
        issueNumber,
        phase,
        phaseConfig,
        undefined,
        wt,
        shutdownManager,
        phasePauseHandle,
      );

    log(
      chalk.blue(
        `\n  Ready gate (#817) — policy: ${policy}, max iterations: ${config.maxIterations}`,
      ),
    );

    const result = await runGate({
      issueNumber,
      worktreePath,
      policy,
      maxIterations: config.maxIterations,
      // AC-4: budget stays disabled on the run path (parity with `ready` sans
      // `--budget`); maxIterations bounds cost.
      tokenBudget: undefined,
      nonGoals,
      phaseTimeout: config.phaseTimeout,
      mcp: config.mcp,
      verbose: config.verbose,
      runPhase,
      onProgress,
    });

    log(
      result.ready
        ? chalk.green(
            `  ✓ Ready gate: ${result.reason} — awaiting human merge (never merged)`,
          )
        : chalk.yellow(
            `  ⚠️  Ready gate halted: ${result.reason} — needs human review`,
          ),
    );

    return { result };
  } catch (err) {
    // Non-fatal: keep the run going to PR with the standard status, but hand
    // the reason back so the summary can say the gate did NOT run.
    const error = err instanceof Error ? err.message : String(err);
    log(
      chalk.yellow(
        `  ⚠️  Ready gate failed for #${issueNumber}: ${error} — continuing to PR without the gate.`,
      ),
    );
    return { error };
  }
}

export async function runIssueWithLogging(
  ctx: IssueExecutionContext,
): Promise<IssueResult> {
  // Destructure context for use throughout the function
  const {
    issueNumber,
    config,
    options,
    title: issueTitle,
    labels,
    services: { logWriter, stateManager, shutdownManager },
    worktree,
    chain,
    packageManager,
    baseBranch,
    onProgress,
    onPhasePlan,
    phasePauseHandle,
  } = ctx;
  const worktreePath = worktree?.path;
  const branch = worktree?.branch;
  const chainMode = chain?.enabled;
  const isLastInChain = chain?.isLast;
  const startTime = Date.now();
  const phaseResults: PhaseResult[] = [];
  let loopTriggered = false;
  // Cross-phase resume token, driver-tagged and cwd-bound (#674).
  let resumeHandle: ResumeHandle | undefined;
  // #804 AC-6: ONE ledger for the whole issue. Created here rather than inside
  // `executePhaseWithRetry` because the bound and the budget are per-issue —
  // a per-phase ledger would silently grant every phase its own full budget.
  const autoWaitLedger = createAutoWaitLedger(config.autoWaitMinutes);

  // In parallel mode, suppress per-issue terminal output to prevent interleaving.
  // The caller (run.ts) handles progress display via updateProgress().
  const log = config.parallel ? () => {} : console.log.bind(console);

  log(chalk.blue(`\n  Issue #${issueNumber}`));
  if (worktreePath) {
    log(chalk.gray(`    Worktree: ${worktreePath}`));
  }

  // Initialize state tracking for this issue
  if (stateManager) {
    try {
      const existingState = await stateManager.getIssueState(issueNumber);
      if (!existingState) {
        await stateManager.initializeIssue(issueNumber, issueTitle, {
          worktree: worktreePath,
          branch,
          qualityLoop: config.qualityLoop,
          maxIterations: config.maxIterations,
        });
      } else {
        // Update worktree info if it changed
        if (worktreePath && branch) {
          await stateManager.updateWorktreeInfo(
            issueNumber,
            worktreePath,
            branch,
          );
        }
      }
    } catch (error) {
      // State tracking errors shouldn't stop execution
      if (config.verbose) {
        log(chalk.yellow(`    !  State tracking error: ${error}`));
      }
    }
  }

  // #860: persist auto-wait transitions to issue state so `sequant status`
  // reports "waiting until <wake>" instead of an hours-stale in-progress
  // phase. Fire-and-forget — state bookkeeping must never disturb the wait
  // it describes.
  const makeWaitTransition = (
    phase: string,
  ): ((wakeAtMs: number | null) => void) | undefined =>
    stateManager
      ? (wakeAtMs) => {
          void stateManager
            .updateAutoWait(issueNumber, phase, wakeAtMs)
            .catch(() => {
              // Never let state bookkeeping disturb a live wait.
            });
        }
      : undefined;

  // Activate relay (#383) if enabled. Tolerates errors — relay must never
  // block the underlying run.
  let relayActivation: ActivationResult | null = null;
  if (config.relayEnabled && !config.dryRun) {
    try {
      relayActivation = await activateRelay(issueNumber, {
        worktreePath,
        stateManager: stateManager ?? null,
      });
      if (relayActivation.warning && config.verbose) {
        log(chalk.yellow(`    !  Relay: ${relayActivation.warning}`));
      } else if (relayActivation.activated && config.verbose) {
        log(
          chalk.gray(
            `    Relay active — use \`sequant prompt ${issueNumber} "<msg>"\` to nudge`,
          ),
        );
      }
    } catch (err) {
      if (config.verbose) {
        log(chalk.yellow(`    !  Relay activation failed: ${err}`));
      }
    }
  }

  // Determine phases for this specific issue
  let phases: Phase[];
  let detectedQualityLoop = false;
  let specAlreadyRan = false;

  if (options.autoDetectPhases) {
    // #533: Always run spec to get recommended workflow.
    // The prior bug/docs shortcut (skip spec → exec → qa) was removed because
    // bug and docs issues often contain design decisions (scope boundaries,
    // edge cases, test-strategy shifts) that benefit from a spec pass.
    log(chalk.gray(`    Running spec to determine workflow...`));

    // RunRenderer (#618) owns spec progress via emitProgressLine + onProgress.
    // The legacy PhaseSpinner produced duplicate lines for single-issue runs.
    emitProgressLine(issueNumber, "spec", "start");
    try {
      onProgress?.(issueNumber, "spec", "start");
    } catch {
      /* progress errors must not halt */
    }

    // Track spec phase start in state
    if (stateManager) {
      try {
        await stateManager.updatePhaseStatus(
          issueNumber,
          "spec",
          "in_progress",
        );
      } catch {
        // State tracking errors shouldn't stop execution
      }
    }

    const specStartTime = new Date();
    // Note: spec runs in main repo (not worktree) for planning
    const specResult = await executePhaseWithRetry(
      issueNumber,
      "spec",
      withActivityHook(
        config,
        issueNumber,
        "spec",
        onProgress,
        makeWaitTransition("spec"),
      ),
      resumeHandle,
      worktreePath, // Will be ignored for spec (non-isolated phase)
      shutdownManager,
      phasePauseHandle,
      undefined, // executePhaseFn — use the default
      undefined, // delayFn — use the default
      autoWaitLedger, // #804: shared across every phase of this issue
    );
    const specEndTime = new Date();

    if (specResult.resumeHandle) {
      resumeHandle = specResult.resumeHandle;
      // Persist resume token + originCwd for cross-process resume (#674).
      if (stateManager) {
        try {
          await stateManager.updateResumeHandle(
            issueNumber,
            specResult.resumeHandle,
          );
        } catch {
          // State tracking errors shouldn't stop execution
        }
      }
    }

    phaseResults.push(specResult);
    specAlreadyRan = true;

    // Emit completion/failure progress event (AC-8)
    const specDurationSec = Math.round(
      (specEndTime.getTime() - specStartTime.getTime()) / 1000,
    );
    if (specResult.success) {
      const extra = { durationSeconds: specDurationSec };
      emitProgressLine(issueNumber, "spec", "complete", extra);
      try {
        onProgress?.(issueNumber, "spec", "complete", extra);
      } catch {
        /* progress errors must not halt */
      }
    } else {
      // Mirror the main phase loop (#739/#799): a turn-capped spec phase surfaces
      // the distinct "partial output preserved" signal, and a billing /
      // rate-limit-window failure names the real cause — so both are recognizable
      // on the spec path too (it has its own failure handling, separate from the
      // main loop). The spec phase already halts on any failure via the early
      // return below; routing billing through billingHaltReason only keeps the
      // message/fallback symmetric with the main loop.
      const extra = {
        error: specResult.capped
          ? "turn cap reached — partial output preserved (resume to continue)"
          : isBillingOrWindowHalt(specResult)
            ? billingHaltReason(specResult)
            : (specResult.error ?? "unknown"),
      };
      emitProgressLine(issueNumber, "spec", "failed", extra);
      try {
        onProgress?.(issueNumber, "spec", "failed", extra);
      } catch {
        /* progress errors must not halt */
      }
    }

    // Log spec phase result
    // Note: Spec runs in main repo, not worktree, so no git diff stats
    if (logWriter) {
      // Build errorContext from captured stderr/stdout tails (#447). Prefer
      // the driver's structured cause (#761 AC-6) — stderr-regex
      // classification never sees the SDK's rate-limit/billing signals.
      let specErrorContext: ErrorContext | undefined;
      if (!specResult.success && specResult.stderrTail) {
        const specError =
          specResult.structuredError ??
          classifyError(specResult.stderrTail ?? [], specResult.exitCode);
        specErrorContext = {
          stderrTail: specResult.stderrTail ?? [],
          stdoutTail: specResult.stdoutTail ?? [],
          exitCode: specResult.exitCode,
          category: errorTypeToCategory(specError),
          errorType: specError.name,
          errorMetadata: specError.metadata,
          isRetryable: specError.isRetryable,
        };
      }
      const phaseLog = createPhaseLogFromTiming(
        "spec",
        issueNumber,
        specStartTime,
        specEndTime,
        specResult.success
          ? "success"
          : specResult.error?.includes("Timeout")
            ? "timeout"
            : "failure",
        {
          error: specResult.error,
          // Mark a turn-capped spec phase distinctly in the log (#739), matching
          // the main phase loop: status stays "failure" but `capped` flags it.
          capped: specResult.capped,
          errorContext: specErrorContext,
        },
      );
      logWriter.logPhase(phaseLog);
    }

    // Track spec phase completion in state
    if (stateManager) {
      try {
        const phaseStatus = specResult.success ? "completed" : "failed";
        await stateManager.updatePhaseStatus(issueNumber, "spec", phaseStatus, {
          error: specResult.error,
          // Mark a turn-capped spec halt distinctly in state (#739), matching
          // the run-log marker — status stays "failed", `capped` flags it.
          capped: specResult.capped,
        });
      } catch {
        // State tracking errors shouldn't stop execution
      }
    }

    // Durable halt-and-resume (#892 AC-1): a waitable-window spec halt writes
    // `resumeAt` so `sequant resume` can re-enter after the window reopens.
    await recordWindowHaltState(stateManager, issueNumber, "spec", specResult);

    if (!specResult.success) {
      const durationSeconds = (Date.now() - startTime) / 1000;
      // Archive relay state on early exit (spec failure).
      if (relayActivation) {
        try {
          await deactivateRelay(issueNumber, {
            phase: "spec",
            startedAt: relayActivation.startedAt,
            worktreePath,
            stateManager: stateManager ?? null,
          });
        } catch {
          /* swallow */
        }
      }
      return {
        issueNumber,
        success: false,
        phaseResults,
        durationSeconds,
        loopTriggered: false,
        failureCategory: deriveFailureCategory(phaseResults),
      };
    }

    // Parse recommended workflow from spec output
    const parsedWorkflow = specResult.output
      ? parseRecommendedWorkflow(specResult.output)
      : null;

    if (parsedWorkflow) {
      // Remove spec from phases since we already ran it
      phases = parsedWorkflow.phases.filter((p) => p !== "spec");
      detectedQualityLoop = parsedWorkflow.qualityLoop;
      log(
        chalk.gray(
          `    Spec recommends: ${phases.join(" → ")}${detectedQualityLoop ? " (quality loop)" : ""}`,
        ),
      );
    } else {
      // Fall back to label-based detection
      log(
        chalk.yellow(
          `    Could not parse spec recommendation, using label-based detection`,
        ),
      );
      const detected = detectPhasesFromLabels(labels);
      phases = detected.phases.filter((p) => p !== "spec");
      detectedQualityLoop = detected.qualityLoop;
      log(chalk.gray(`    Fallback: ${phases.join(" → ")}`));
    }
  } else {
    // Use explicit phases with adjustments
    phases = determinePhasesForIssue(config.phases, labels, options);
    if (phases.length !== config.phases.length) {
      log(chalk.gray(`    Phases adjusted: ${phases.join(" → ")}`));
    }
  }

  // Resume: filter out completed phases if --resume flag is set
  if (options.resume) {
    const resumeResult = filterResumedPhases(issueNumber, phases, true);
    if (resumeResult.skipped.length > 0) {
      log(
        chalk.gray(
          `    Resume: skipping completed phases: ${resumeResult.skipped.join(", ")}`,
        ),
      );
      phases = resumeResult.phases;
    }
    // Also skip spec if it was auto-detected as completed
    if (
      specAlreadyRan &&
      resumeResult.skipped.length === 0 &&
      resumeResult.phases.length === 0
    ) {
      log(chalk.gray(`    Resume: all phases already completed`));
    }
  }

  // Add testgen phase if requested (and spec was in the phases)
  if (
    options.testgen &&
    (phases.includes("spec") || specAlreadyRan) &&
    !phases.includes("testgen")
  ) {
    // Insert testgen at the beginning if spec already ran, otherwise after spec
    if (specAlreadyRan) {
      phases.unshift("testgen");
    } else {
      const specIndex = phases.indexOf("spec");
      if (specIndex !== -1) {
        phases.splice(specIndex + 1, 0, "testgen");
      }
    }
  }

  // Add security-review phase if requested (and spec was in the phases).
  // Idempotent vs label-based auto-detection — only inserts if not present.
  if (
    options.securityReview &&
    (phases.includes("spec") || specAlreadyRan) &&
    !phases.includes("security-review")
  ) {
    if (specAlreadyRan) {
      phases.unshift("security-review");
    } else {
      const specIndex = phases.indexOf("spec");
      if (specIndex !== -1) {
        phases.splice(specIndex + 1, 0, "security-review");
      }
    }
  }

  // #672 AC-2: surface the resolved phase pipeline to the renderer so it can
  // seed pending cells for every phase before any one of them fires. This
  // runs once per issue after all phase-list mutations (auto-detect, resume
  // filter, testgen/security-review insertion). The full pipeline for the row
  // is `spec` (if it already ran) plus the remaining `phases` array.
  if (onPhasePlan) {
    const fullPlan = specAlreadyRan ? ["spec", ...phases] : [...phases];
    try {
      onPhasePlan(issueNumber, fullPlan);
    } catch {
      /* renderer wiring errors must not halt execution */
    }
  }

  // Build per-issue config with issue type metadata for skill env propagation
  const lowerLabelsForType = labels.map((l) => l.toLowerCase());
  const issueIsDocs = lowerLabelsForType.some((label) =>
    DOCS_LABELS.some((docsLabel) => label === docsLabel),
  );
  const issueConfig: ExecutionConfig = issueIsDocs
    ? { ...config, issueType: "docs" }
    : config;

  let iteration = 0;
  const useQualityLoop = config.qualityLoop || detectedQualityLoop;
  const maxIterations = useQualityLoop ? config.maxIterations : 1;
  let completedSuccessfully = false;
  // Set when a phase hits its turn cap (#739): halt the outer quality-loop
  // retry too, not just the inner /loop spawn — re-running a capped phase
  // would only cap again, and "surface + halt" means the user resumes.
  let haltedByCap = false;
  // Set when a phase fails with a billing / out-of-credits error or a
  // window-exhausted rate limit (#799): like the turn cap, re-running the phase
  // (or spawning /loop) cannot succeed while the window is closed, so halt the
  // outer quality loop and let the user resume once credits/window are restored.
  let haltedByBilling = false;

  while (iteration < maxIterations) {
    iteration++;

    if (useQualityLoop && iteration > 1) {
      log(
        chalk.yellow(
          `    Quality loop iteration ${iteration}/${maxIterations}`,
        ),
      );
      loopTriggered = true;
    }

    let phasesFailed = false;

    for (let phaseIdx = 0; phaseIdx < phases.length; phaseIdx++) {
      const phase = phases[phaseIdx];

      // RunRenderer (#618) owns phase progress via emitProgressLine + onProgress.
      // #624 Item 3: surface the outer-loop iteration on every retried phase
      // event so the renderer can label them `(attempt N/M)`. First-attempt
      // events still get `iteration: 1` so the data flow is uniform; the
      // renderer's `formatRetrySuffix` suppresses the suffix when iteration ≤ 1.
      const phaseExtra: { iteration: number } = { iteration };
      emitProgressLine(issueNumber, phase, "start", phaseExtra);
      try {
        onProgress?.(issueNumber, phase, "start", phaseExtra);
      } catch {
        /* progress errors must not halt */
      }

      // Track phase start in state
      if (stateManager) {
        try {
          await stateManager.updatePhaseStatus(
            issueNumber,
            phase as Phase,
            "in_progress",
          );
        } catch {
          // State tracking errors shouldn't stop execution
        }
      }

      const phaseStartTime = new Date();
      const result = await executePhaseWithRetry(
        issueNumber,
        phase,
        withActivityHook(
          issueConfig,
          issueNumber,
          phase,
          onProgress,
          makeWaitTransition(phase),
        ),
        resumeHandle,
        worktreePath,
        shutdownManager,
        phasePauseHandle,
        undefined, // executePhaseFn — use the default
        undefined, // delayFn — use the default
        autoWaitLedger, // #804: shared across every phase of this issue
      );
      const phaseEndTime = new Date();

      // Capture resume handle for subsequent phases (#674).
      if (result.resumeHandle) {
        resumeHandle = result.resumeHandle;
        if (stateManager) {
          try {
            await stateManager.updateResumeHandle(
              issueNumber,
              result.resumeHandle,
            );
          } catch {
            // State tracking errors shouldn't stop execution
          }
        }
      }

      phaseResults.push(result);

      // Emit completion/failure progress event (AC-8)
      const phaseDurationSec = Math.round(
        (phaseEndTime.getTime() - phaseStartTime.getTime()) / 1000,
      );
      if (result.success) {
        const extra = { durationSeconds: phaseDurationSec, iteration };
        emitProgressLine(issueNumber, phase, "complete", extra);
        try {
          onProgress?.(issueNumber, phase, "complete", extra);
        } catch {
          /* progress errors must not halt */
        }
      } else {
        // A turn-capped phase is incomplete-but-not-hard-failed (#739): surface a
        // distinct "partial output preserved" signal instead of a generic failure
        // reason, so the user knows the run halted on a recoverable cap (and can
        // resume) rather than on a genuine error. The partial `result.output` is
        // already preserved in `phaseResults` (pushed above) and the phase log
        // (`capped` flag below); the run still halts cleanly at the `break` below.
        const extra = {
          error: result.capped
            ? "turn cap reached — partial output preserved (resume to continue)"
            : isBillingOrWindowHalt(result)
              ? // Billing / rate-limit-window halt (#799): name the real cause so
                // the run summary doesn't cascade into a downstream
                // `QA completed without a parseable verdict`.
                billingHaltReason(result)
              : (result.error ?? "unknown"),
          iteration,
        };
        emitProgressLine(issueNumber, phase, "failed", extra);
        try {
          onProgress?.(issueNumber, phase, "failed", extra);
        } catch {
          /* progress errors must not halt */
        }
      }

      // Log phase result with observability data (AC-1, AC-2, AC-3, AC-7)
      if (logWriter) {
        // Resolve the diff base once (#878): worktrees branch from
        // origin/<base>, so both the diff stats and the phase-commit check
        // must compare against the resolved ref, not the local branch name.
        const resolvedDiffBase = worktreePath
          ? resolveDiffBase(worktreePath, baseBranch ?? "main")
          : undefined;

        // Capture git diff stats for worktree phases (AC-1, AC-3)
        const diffStats =
          worktreePath && resolvedDiffBase
            ? getGitDiffStats(worktreePath, resolvedDiffBase)
            : undefined;

        // Capture commit hash after phase (AC-2) — undefined when the branch
        // never moved off its base, so a base tip is not logged as the
        // phase's commit (#878).
        const commitHash = worktreePath
          ? getCommitHash(worktreePath, resolvedDiffBase)
          : undefined;

        // Read cache metrics for QA phase (AC-7)
        const cacheMetrics =
          phase === "qa" ? readCacheMetrics(worktreePath) : undefined;

        // Build errorContext from captured stderr/stdout tails (#447, AC-7/AC-8).
        // Prefer the driver's structured cause (#761 AC-6) — stderr-regex
        // classification never sees the SDK's rate-limit/billing signals.
        let errorContext: ErrorContext | undefined;
        if (!result.success && result.stderrTail) {
          const typedError =
            result.structuredError ??
            classifyError(result.stderrTail ?? [], result.exitCode);
          errorContext = {
            stderrTail: result.stderrTail ?? [],
            stdoutTail: result.stdoutTail ?? [],
            exitCode: result.exitCode,
            category: errorTypeToCategory(typedError),
            errorType: typedError.name,
            errorMetadata: typedError.metadata,
            isRetryable: typedError.isRetryable,
          };
        }

        const phaseLog = createPhaseLogFromTiming(
          phase,
          issueNumber,
          phaseStartTime,
          phaseEndTime,
          result.success
            ? "success"
            : result.error?.includes("Timeout")
              ? "timeout"
              : "failure",
          {
            error: result.error,
            // Mark a turn-capped phase distinctly in the log (#739): status stays
            // "failure" (no new enum value) but `capped` flags it as recoverable.
            capped: result.capped,
            verdict: result.verdict,
            summary: result.summary,
            // Observability fields (AC-1, AC-2, AC-3, AC-7)
            filesModified: diffStats?.filesModified,
            fileDiffStats: diffStats?.fileDiffStats,
            commitHash,
            cacheMetrics,
            errorContext,
          },
        );
        logWriter.logPhase(phaseLog);
      }

      // Track phase completion in state
      if (stateManager) {
        try {
          const phaseStatus = result.success
            ? "completed"
            : result.error?.includes("Timeout")
              ? "failed"
              : "failed";
          await stateManager.updatePhaseStatus(
            issueNumber,
            phase as Phase,
            phaseStatus,
            {
              error: result.error,
              // Mark a turn-capped phase halt distinctly in state (#739),
              // matching the run-log marker — status stays "failed",
              // `capped` flags it as recoverable for the resume path.
              capped: result.capped,
            },
          );
        } catch {
          // State tracking errors shouldn't stop execution
        }
      }

      // Durable halt-and-resume (#892 AC-1): a waitable-window halt writes
      // `resumeAt`; success or a non-window failure clears any stale record.
      await recordWindowHaltState(stateManager, issueNumber, phase, result);

      if (result.success) {
        // Phase succeeded — RunRenderer (#618) updates state via onProgress.
      } else {
        phasesFailed = true;
        if (result.capped) {
          haltedByCap = true;
        }
        // Billing / rate-limit-window failure (#799): halt the outer quality
        // loop for the same reason as the turn cap — re-running the phase or
        // spawning /loop cannot succeed while credits/window are exhausted, and
        // doing so mislabels the halt as a downstream unparseable-verdict error.
        if (isBillingOrWindowHalt(result)) {
          haltedByBilling = true;
        }

        // If quality loop enabled, run loop phase to fix issues.
        // A turn-capped phase (#739) is incomplete, not a genuine quality
        // failure: skip the loop and halt cleanly ("surface + halt"). Spawning
        // /loop on partial output would act on incomplete work — exactly the
        // risk the capped path is meant to avoid. The user resumes instead.
        // A billing / rate-limit-window halt (#799) is skipped for the same
        // reason: /loop would re-spawn into the same closed window.
        if (
          useQualityLoop &&
          iteration < maxIterations &&
          !result.capped &&
          !haltedByBilling
        ) {
          // #624 Item 3 (AC-3.3): the loop phase carries the current outer
          // iteration so the live-zone status cell can show `loop N/M`.
          const loopStartExtra: { iteration: number } = { iteration };
          emitProgressLine(issueNumber, "loop", "start", loopStartExtra);
          try {
            onProgress?.(issueNumber, "loop", "start", loopStartExtra);
          } catch {
            /* progress errors must not halt */
          }

          // Build enriched config for loop phase with QA context (#488).
          // Pass verdict, failed ACs, and error directly so the /loop skill
          // doesn't need to reconstruct context from GitHub comments.
          const loopConfig: ExecutionConfig = {
            ...issueConfig,
            lastVerdict: result.verdict ?? undefined,
            failedAcs: result.summary?.gaps?.join("; ") ?? undefined,
            promptContext: buildLoopContext(result),
          };

          const loopStartTime = new Date();
          const loopResult = await executePhaseWithRetry(
            issueNumber,
            "loop",
            withActivityHook(
              loopConfig,
              issueNumber,
              "loop",
              onProgress,
              makeWaitTransition("loop"),
            ),
            resumeHandle,
            worktreePath,
            shutdownManager,
            phasePauseHandle,
            undefined, // executePhaseFn — use the default
            undefined, // delayFn — use the default
            autoWaitLedger, // #804: shared across every phase of this issue
          );
          const loopEndTime = new Date();
          phaseResults.push(loopResult);

          // #766: record the loop phase in the run log — spec (:655) and the
          // regular phases (:982) log via logWriter, but the loop was never
          // logged, so a loop that decided the card's verdict was absent from
          // the log you'd use to debug it (AC-6). Loop status never determines
          // the issue verdict (see deriveIssueLogStatus), but the entry with
          // phase/status/duration/error must exist.
          if (logWriter) {
            const loopPhaseLog = createPhaseLogFromTiming(
              "loop",
              issueNumber,
              loopStartTime,
              loopEndTime,
              loopResult.success
                ? "success"
                : loopResult.error?.includes("Timeout")
                  ? "timeout"
                  : "failure",
              {
                error: loopResult.error,
                capped: loopResult.capped,
              },
            );
            logWriter.logPhase(loopPhaseLog);
          }

          // Emit loop completion/failure progress event (AC-8)
          const loopDurationSec = Math.round(
            (loopEndTime.getTime() - loopStartTime.getTime()) / 1000,
          );
          if (loopResult.success) {
            const extra = { durationSeconds: loopDurationSec, iteration };
            emitProgressLine(issueNumber, "loop", "complete", extra);
            try {
              onProgress?.(issueNumber, "loop", "complete", extra);
            } catch {
              /* progress errors must not halt */
            }
          } else {
            const extra = { error: loopResult.error ?? "unknown", iteration };
            emitProgressLine(issueNumber, "loop", "failed", extra);
            try {
              onProgress?.(issueNumber, "loop", "failed", extra);
            } catch {
              /* progress errors must not halt */
            }
          }

          if (loopResult.resumeHandle) {
            resumeHandle = loopResult.resumeHandle;
          }

          if (loopResult.success) {
            // Continue to next iteration
            break;
          }
        }

        // Stop on first failure (if not in quality loop or loop failed)
        break;
      }
    }

    // If all phases passed, exit the loop
    if (!phasesFailed) {
      completedSuccessfully = true;
      break;
    }

    // A turn-capped phase (#739) halts the outer quality-loop retry as well —
    // re-running would only cap again; the partial work is already preserved.
    // A billing / rate-limit-window failure (#799) halts for the same reason:
    // the retry re-spawns into the same closed window and cannot progress.
    if (haltedByCap || haltedByBilling) {
      break;
    }

    // If we're not in quality loop mode, don't retry
    if (!config.qualityLoop) {
      break;
    }
  }

  const durationSeconds = (Date.now() - startTime) / 1000;
  // Success is determined by whether all phases completed in any iteration,
  // not whether all accumulated phase results passed (which would fail after loop recovery)
  const success = completedSuccessfully;

  // #817: opt-in post-QA ready gate. When the standard phases succeed AND
  // `--ready-gate` was passed, drive the existing `sequant ready` engine
  // (qa→loop→qa to the configured policy) against this worktree BEFORE
  // checkpoint/rebase/PR — so the gate's auto-fix commits land in the PR. The
  // engine NEVER merges; it terminates with the issue `waiting_for_human_merge`
  // (ready) or `blocked` (guard halt). Without the flag this block is skipped
  // entirely, keeping the run path byte-identical (AC-5).
  const readyGateOutcome =
    config.readyGate && success && worktreePath
      ? await runReadyGateForIssue({
          issueNumber,
          worktreePath,
          config,
          shutdownManager,
          phasePauseHandle,
          onProgress,
          log,
        })
      : undefined;
  const readyGateResult = readyGateOutcome?.result;
  // Surfaced separately from `readyGateResult` so a gate that *crashed* renders
  // differently in the summary from one that ran — a silently-skipped gate on a
  // run the user explicitly opted into is the failure mode worth naming.
  const readyGateError = readyGateOutcome?.error;

  // Update final issue status in state. When the gate ran it owns the terminal
  // status (never `ready_for_merge` — that would read as auto-merge-ready and
  // defeat the human merge gate the gate deliberately stops at).
  // Hoisted out of the `if (stateManager)` block below because the checkpoint
  // warning also has to name this status, and naming the wrong one is exactly
  // the #837 inaccuracy being fixed here.
  const finalStatus = readyGateResult
    ? readyGateResult.issueStatus
    : success
      ? "ready_for_merge"
      : "in_progress";
  if (stateManager) {
    try {
      await stateManager.updateIssueStatus(issueNumber, finalStatus);
    } catch {
      // State tracking errors shouldn't stop execution
    }
  }

  // Create checkpoint commit in chain mode after QA passes.
  // #760: chain resume rebases the next link onto this checkpoint, so a failure
  // here is not silent — warn prominently and record it on the result (AC-4).
  //
  // Note a completed status was already written above — `ready_for_merge`, or
  // `waiting_for_human_merge` when #817's `--ready-gate` owned the terminal
  // status (#837) — so a re-run reads this link as a completed prefix and does
  // NOT redo it. Its uncommitted work is therefore absent from the branch tip,
  // which `computeChainResumePlan` detects (dirty worktree → fail fast) rather
  // than wrong-basing the next link. The message states that outcome exactly:
  // the work must be committed, or --force.
  //
  // A gate that halted (`blocked`) is NOT a completed prefix, so that link is
  // re-executed on resume rather than skipped — see COMPLETED_STATUSES in
  // chain-resume.ts.
  let checkpointFailed = false;
  if (success && chainMode && worktreePath) {
    const checkpointOk = createCheckpointCommit(
      worktreePath,
      issueNumber,
      config.verbose,
      baseBranch,
    );
    if (!checkpointOk) {
      checkpointFailed = true;
      log(
        chalk.yellow(
          `  ⚠️  Checkpoint commit for #${issueNumber} could not be created — its uncommitted ` +
            `changes are NOT on branch ${branch ?? "the feature branch"}. #${issueNumber} stays ` +
            `${finalStatus}, so a re-run will skip it and refuse to resume the chain here until the ` +
            `work is committed in ${worktreePath} (or re-run with --force to redo the whole chain).`,
        ),
      );
    }
  }

  // Rebase onto the base branch before PR creation (unless --no-rebase)
  // This ensures the branch is up-to-date and prevents lockfile drift
  // AC-1: Non-chain mode rebases onto the base branch before PR
  // AC-2: Chain mode rebases only the final branch onto the base branch before PR
  //        (intermediate branches must stay based on their predecessor)
  const shouldRebase =
    success &&
    worktreePath &&
    !options.noRebase &&
    (!chainMode || isLastInChain);
  if (shouldRebase) {
    rebaseBeforePR(
      worktreePath,
      issueNumber,
      packageManager,
      config.verbose,
      baseBranch,
    );
  }

  // Create PR after successful QA + rebase (unless --no-pr)
  let prNumber: number | undefined;
  let prUrl: string | undefined;
  // #879: a PR-creation failure after passing QA must fail the run, not print a
  // warning and leave the issue at `success`. Recorded here and folded into the
  // returned `success` below.
  let prCreationError: string | undefined;
  const shouldCreatePR = success && worktreePath && branch && !options.noPr;
  if (shouldCreatePR) {
    // #605: under --stacked, target predecessor branch (only for non-first,
    // non-last issues). Last PR keeps `main` so partial progress can land.
    const stackOptions =
      chain?.predecessorBranch || chain?.stackManifest
        ? {
            prBase: chain.predecessorBranch,
            stackManifest: chain.stackManifest,
          }
        : undefined;
    // #749: surface a non-A+ qa verdict (e.g. AC_MET_BUT_NOT_A_PLUS) in the PR
    // body so a reviewer sees why the run broke to PR rather than reaching A+.
    const qaVerdict = phaseResults.find((p) => p.phase === "qa")?.verdict;
    const prResult = createPR(
      worktreePath,
      issueNumber,
      issueTitle,
      branch,
      config.verbose,
      labels,
      stackOptions,
      qaVerdict,
      // #817 AC-6: surface the ready-gate outcome in the PR body the same way
      // `sequant ready` reports it (threshold reached vs guard halt).
      readyGateResult?.report,
    );
    if (prResult.success && prResult.prNumber && prResult.prUrl) {
      prNumber = prResult.prNumber;
      prUrl = prResult.prUrl;

      // Update workflow state with PR info
      if (stateManager) {
        try {
          await stateManager.updatePRInfo(issueNumber, {
            number: prResult.prNumber,
            url: prResult.prUrl,
          });
        } catch {
          // State tracking errors shouldn't stop execution
        }
      }
    } else if (prResult.attempted && !prResult.success) {
      // #879: PR creation was attempted (branch/QA passed) but failed. This is
      // a run failure — the deliverable never reached GitHub.
      prCreationError = prResult.error ?? "PR creation failed";
    }
  }

  // Deactivate relay (#383) — archive inbox/outbox transcripts to
  // .sequant/logs/relay/ before worktree teardown (AC-D2). Never throws.
  if (relayActivation) {
    try {
      await deactivateRelay(issueNumber, {
        phase: phaseResults[phaseResults.length - 1]?.phase ?? "exec",
        startedAt: relayActivation.startedAt,
        worktreePath,
        stateManager: stateManager ?? null,
      });
    } catch (err) {
      if (config.verbose) {
        log(chalk.yellow(`    !  Relay deactivation failed: ${err}`));
      }
    }
  }

  // #879: fold a PR-creation failure into the issue's overall verdict. Phases
  // all passed, but the run did not deliver — report it as failed.
  const overallSuccess = success && !prCreationError;

  return {
    issueNumber,
    success: overallSuccess,
    phaseResults,
    durationSeconds,
    loopTriggered,
    prNumber,
    prUrl,
    prCreationError,
    checkpointFailed,
    failureCategory: overallSuccess
      ? undefined
      : deriveFailureCategory(phaseResults),
    // #817: present only when `--ready-gate` ran the gate; the summary renders
    // its terminal reason (AC-6).
    readyGate: readyGateResult,
    readyGateError,
  };
}
