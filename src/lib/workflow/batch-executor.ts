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
import { createPhaseLogFromTiming, LogWriter } from "./log-writer.js";
import { latestPhaseResult, latestWhere } from "./latest-phase.js";
import { attributionFromPhases } from "./qa-verdict-attribution.js";
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
  type QaVerdict,
  type QaSummary,
} from "./types.js";
import { withEscalatedEffort } from "./effort-escalation.js";
import {
  withEscalatedModel,
  createLadderState,
  isLadderConfigured,
  effectiveModelTrigger,
  detectCapabilityBoundTrigger,
  formatEscalationTriggerLabel,
  type EscalationTrigger,
  type LadderState,
  type ModelEscalationRecord,
} from "./model-ladder.js";
import {
  formatEvidenceBundle,
  type EvidenceBundle,
  type DivergenceIterationRecord,
  type LadderHaltReason,
} from "./divergence-halt.js";

/**
 * Consecutive `divergence-suspect` iterations required before the run halts
 * (#995 / #971 AC-3).
 *
 * Two, not one. A single iteration that produced a diff and still failed QA is
 * the ordinary `AC_NOT_MET → /loop → re-QA` cycle — the quality loop working
 * as designed. Halting on the first would turn every normal second pass into a
 * dead run. Two in a row is the fingerprint AC-3 describes: plausible work that
 * keeps not converging, which a stronger model would only rediscover more
 * expensively.
 */
const DIVERGENCE_SUSPECT_HALT_THRESHOLD = 2;
import {
  snapshotLoopProgress,
  compareLoopProgress,
  type LoopProgressSnapshot,
} from "./qa-stagnation.js";
import type { ShutdownManager } from "../shutdown.js";
import {
  classifyError,
  errorTypeToCategory,
  type ErrorCategory,
} from "./error-classifier.js";
import type { ErrorContext, GapFinding } from "./run-log-schema.js";
import {
  getGitDiffStats,
  getCommitHash,
  resolveDiffBase,
} from "./git-diff-utils.js";
import {
  createCheckpointCommit,
  rebaseBeforePR,
  createPR,
  composeExecSummary,
  readCacheMetrics,
  filterResumedPhases,
} from "./worktree-manager.js";
import {
  AUTO_WAIT_BUFFER_MS,
  createAutoWaitLedger,
  type AutoWaitLedger,
  executePhaseWithRetry,
  hasExecChanges,
  isWindowExhaustedRateLimit,
  selectFixableGaps,
} from "./phase-executor.js";
import { BillingError, RateLimitError, resetsAtToMs } from "../errors.js";
import type { StateManager } from "./state-manager.js";
import { parseBodyDependencyMarkers } from "./dependency-markers.js";
import type { ResumeHandle } from "./drivers/index.js";
import { determinePhasesForIssue, DOCS_LABELS } from "./phase-mapper.js";
import { resolveSpecRecommendation } from "./spec-recommendation.js";
import {
  activateRelay,
  deactivateRelay,
  type ActivationResult,
} from "../relay/activation.js";
import { getSettings } from "../settings.js";
import { GhCommandError, GitHubProvider } from "./platforms/github.js";
import type { PlatformProvider } from "./platforms/platform-provider.js";
import {
  runReadyGate,
  parseNonGoals,
  type ReadyResult,
  type ReadyPhaseRunner,
} from "./ready-gate.js";
import { isCompletedIssueStatus } from "./completed-status.js";
import { bracketedConsoleLog } from "./notice.js";
import { noteSuppressed } from "./suppressed.js";
import { deliverReadFirstComment } from "./review-residue.post.js";
import {
  parseMutationMarkersFromExecOutput,
  type MutationMarker,
} from "./mutation-marker.js";
import {
  mutationMarkersFromState,
  readMutationState,
} from "./mutation-state.js";

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
      } catch (err) {
        // Activity events must never disrupt the run.
        noteSuppressed("progress", err, "onActivity");
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
      } catch (err) {
        // Liveness notices must never disrupt the run.
        noteSuppressed("progress", err, "waiting notice");
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
      } catch (err) {
        // Liveness notices must never disrupt the run.
        noteSuppressed("progress", err, "waiting line");
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

  // #937 AC-3: exclude findings marked `document`/`pause_for_human` — those
  // are QA-real but not something a fix loop should chase.
  const fixableGaps = selectFixableGaps(failedResult.summary);
  if (fixableGaps.length) {
    parts.push(`QA Gaps:\n${fixableGaps.map((gap) => `- ${gap}`).join("\n")}`);
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

/** gh's error for a number the repo has no issue or PR for (#1257). */
const ISSUE_NOT_FOUND_RE = /Could not resolve to an issue or pull request/i;

export async function getIssueInfo(
  issueNumber: number,
  provider: PlatformProvider = new GitHubProvider(),
): Promise<{
  title: string;
  labels: string[];
  notFound?: true;
  /** #1487: why the title could not be read (any gh failure but not-found) */
  error?: string;
}> {
  try {
    const issue = await provider.fetchIssue(String(issueNumber));
    return {
      title: issue.title || `Issue #${issueNumber}`,
      labels: issue.labels,
    };
  } catch (err) {
    // #1257 AC-5: tell "this issue doesn't exist" apart from every other gh
    // failure (offline, no auth, no remote), which keep the silent default.
    if (err instanceof GhCommandError && ISSUE_NOT_FOUND_RE.test(err.stderr)) {
      return { title: `Issue #${issueNumber}`, labels: [], notFound: true };
    }
    // Use defaults; the run warns with the reason (#1487)
    const error =
      err instanceof GhCommandError && err.stderr
        ? err.stderr
        : err instanceof Error
          ? err.message
          : String(err);
    return { title: `Issue #${issueNumber}`, labels: [], error };
  }
}

/**
 * The warning a non-dry run prints when an issue's title could not be read
 * (#1487), or `null` when it was read. The run still continues: worktree
 * setup finds the issue's branch by number, so the placeholder title only
 * names a branch that is created for the first time.
 */
export function issueTitleWarning(
  issueNumber: number,
  info: { error?: string },
): string | null {
  if (!info.error) return null;
  const reason = info.error.split("\n")[0];
  return (
    `  ⚠ Could not read the title of issue #${issueNumber} (gh: ${reason}). ` +
    `Using "Issue #${issueNumber}"; an existing branch for #${issueNumber} is still reused.`
  );
}

/**
 * Parse dependencies from issue body and labels
 * Returns array of issue numbers this issue depends on
 */
export function parseDependencies(
  issueNumber: number,
  provider: GitHubProvider = new GitHubProvider(),
): number[] {
  try {
    const data = provider.fetchIssueSync(String(issueNumber));
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
    for (const labelName of data.labels) {
      const labelMatch = labelName.match(/depends-on[-/](\d+)/i);
      if (labelMatch) {
        dependencies.push(parseInt(labelMatch[1], 10));
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
export function sortByDependencies(
  issueNumbers: number[],
  provider?: GitHubProvider,
): number[] {
  // Build dependency graph
  const dependsOn = new Map<number, number[]>();
  for (const issue of issueNumbers) {
    const deps = parseDependencies(issue, provider);
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
  // #1254: any failure no failed phase accounts for — a PR-creation failure,
  // a ladder halt, an abort before the phases — is forced to `failure`, and
  // its reason and evidence bundle go on the issue entry. A failed phase
  // already sets the status (`failure`, or `partial` on a timeout).
  const failedPhase = result.phaseResults.some(
    (p) => !p.success && p.phase !== "loop",
  );
  if (
    result.prCreationError ||
    result.evidenceBundle ||
    (!result.success && !failedPhase)
  ) {
    logWriter.markIssueFailed(issueNumber, {
      abortReason: result.abortReason,
      evidenceBundle: result.evidenceBundle,
    });
  }
  logWriter.completeIssue(issueNumber);
}

/**
 * @deprecated (remove in v2.22) No live caller — `sequant run` executes issues via
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
    worktreeRequired,
    worktreeFailures,
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
      worktreeRequired,
      worktreeError: worktreeFailures?.get(issueNumber),
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
  const failedPhase = latestWhere(
    phaseResults,
    (p) => !p.success && p.phase !== "loop",
  );
  if (!failedPhase) return undefined;
  const typedError =
    failedPhase.structuredError ??
    classifyError(failedPhase.stderrTail ?? [], failedPhase.exitCode);
  return errorTypeToCategory(typedError);
}

/**
 * The issue-level record of a ladder halt (#1254).
 *
 * A halt is the orchestrator's decision, not a phase failure, so
 * {@link deriveFailureCategory} finds nothing to classify — a halt where every
 * phase exited cleanly used to return `success: false` with no category and no
 * reason. Both `runIssueWithLogging` return sites spread this, so all four
 * producers (spec path, loop `SPEC_DIVERGENCE`, `DIVERGENCE_SUSPECT`,
 * `TOP_OF_LADDER`) are recorded through one owner. Reuses `abortReason` rather
 * than a halt-specific field (owner decision 2026-10-04).
 *
 * @internal Exported for testing
 */
export function ladderHaltOutcome(
  bundle: EvidenceBundle,
): Pick<IssueResult, "failureCategory" | "abortReason" | "evidenceBundle"> {
  const acs = bundle.declaredAcs?.trim();
  return {
    failureCategory: "ladder_halt",
    abortReason: `ladder halt: ${bundle.reason} in ${bundle.phase}${acs ? ` (${acs})` : ""}`,
    evidenceBundle: bundle,
  };
}

/**
 * How a finished phase is recorded — in state, the run-log phase row and the
 * progress event alike (#1254).
 *
 * A phase that declared `SPEC_DIVERGENCE` halted the run, so it is recorded as
 * failed whatever its exit status, with the declaration as its outcome. Every
 * writer reads this one decision; before #1254 each copied `result.success`,
 * so a clean-exit divergence read `completed` everywhere a reader looks.
 *
 * @internal Exported for testing
 */
export function phaseRecordFor(result: PhaseResult): {
  success: boolean;
  error?: string;
  outcome?: "SPEC_DIVERGENCE";
  divergenceAcs?: string;
} {
  if (!result.specDivergence) {
    return { success: result.success, error: result.error };
  }
  const acs = result.specDivergence.acs ?? "";
  return {
    success: false,
    error:
      result.error ??
      `SPEC_DIVERGENCE declared: ${acs.trim() || "(the agent named no AC)"}`,
    outcome: "SPEC_DIVERGENCE",
    divergenceAcs: acs,
  };
}

// Re-exported for the #1249 call sites and tests; the accessor lives in a leaf
// module so `mcp/tools` and `commands` need not import the orchestrator (#1245).
export { latestPhaseResult };

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
  } catch (err) {
    // State tracking errors shouldn't stop execution
    noteSuppressed("state", err, "window halt");
  }
}

/**
 * Build the comment body for a standard-qa-phase verdict post (#964).
 * Includes AC coverage and any gaps/suggestions from the parsed `QaSummary`,
 * plus a machine marker so a future dedup pass has an anchor.
 * @internal Exported for testing.
 */
export function buildQaVerdictComment(
  verdict: QaVerdict,
  summary: QaSummary | undefined,
  commitHash: string | undefined,
  iteration: number,
  attribution?: string,
): string {
  const lines: string[] = [`## QA Verdict: ${verdict}`];
  if (summary) {
    // #1073: a `0/N met` line under an AC_MET* verdict contradicts the verdict
    // and reads as a failure; when the parser found no counts (or counts that
    // cannot be reconciled with a passing verdict) omit the line rather than
    // print a wrong one.
    const passing =
      verdict === "READY_FOR_MERGE" || verdict.startsWith("AC_MET");
    const countsUsable =
      summary.acTotal > 0 && !(passing && summary.acMet === 0);
    if (countsUsable) {
      lines.push("", `AC coverage: ${summary.acMet}/${summary.acTotal} met`);
    }
    // #1194 AC-4: under NEEDS_VERIFICATION the pause_for_human findings get
    // their own section below, so they are left out of the gaps list (which
    // unions marker + prose text) instead of being printed twice.
    const pauseForHuman =
      verdict === "NEEDS_VERIFICATION"
        ? (summary.findings ?? []).filter(
            (f) => f.recommendedAction === "pause_for_human",
          )
        : [];
    const humanReview = new Set(pauseForHuman.map((f) => f.description));
    const gaps = summary.gaps.filter((g) => !humanReview.has(g));
    if (gaps.length > 0) {
      lines.push("", "**Gaps:**", ...gaps.map((g) => `- ${g}`));
    }
    if (summary.suggestions.length > 0) {
      lines.push(
        "",
        "**Suggestions:**",
        ...summary.suggestions.map((s) => `- ${s}`),
      );
    }
    // #1194 AC-4: NEEDS_VERIFICATION is the verdict where a human must act on
    // exactly what's unresolved — name the PENDING ACs and surface the findings
    // the model flagged as needing a human decision.
    if (verdict === "NEEDS_VERIFICATION") {
      if (summary.pendingAcIds && summary.pendingAcIds.length > 0) {
        lines.push(
          "",
          "**Pending ACs:**",
          ...summary.pendingAcIds.map((id) => `- ${id}`),
        );
      }
      if (pauseForHuman.length > 0) {
        lines.push(
          "",
          "**Needs human review:**",
          ...pauseForHuman.map((f) => `- ${f.description}`),
        );
      }
    }
  }
  lines.push(
    "",
    `<!-- SEQUANT_QA_VERDICT: ${JSON.stringify({
      verdict,
      commit: commitHash ?? null,
      iteration,
    })} -->`,
  );
  // #1521: the visible last line names the reviewer; the machine marker stays
  // above it (consumers match it by regex, not by position).
  if (attribution) lines.push("", attribution);
  return lines.join("\n");
}

/**
 * Post the qa-verdict comment for a standard (non-ready-gate) qa phase under
 * orchestrated `sequant run` (#964). This is the channel `qa/SKILL.md` §9
 * promises ("orchestrator handles aggregated summary") but batch-executor
 * never backed — a re-run producing a fresh, different verdict left a stale,
 * contradicted comment as the only externally-visible one.
 *
 * Best-effort: a post failure is caught and logged, never fails the run —
 * mirrors {@link runReadyGateForIssue}'s `postReport` contract (#937 AC-4).
 * @internal Exported for testing.
 */
export async function postQaVerdictComment(
  issueNumber: number,
  verdict: QaVerdict,
  summary: QaSummary | undefined,
  commitHash: string | undefined,
  iteration: number,
  log: (msg: string) => void,
  postComment: (issueNumber: number, body: string) => Promise<void> = (
    n,
    body,
  ) => new GitHubProvider().postComment(String(n), body),
  attribution?: string,
): Promise<void> {
  try {
    const body = buildQaVerdictComment(
      verdict,
      summary,
      commitHash,
      iteration,
      attribution,
    );
    await postComment(issueNumber, body);
  } catch (err) {
    log(`    !  Failed to post QA verdict comment: ${err}`);
  }
}

/**
 * Arguments for {@link runReadyGateForIssue}. Narrower than the full
 * `IssueExecutionContext` so the helper stays cheap to unit-test in isolation
 * — but `config` is the whole resolved `ExecutionConfig`, deliberately.
 *
 * It used to be unpacked into a flat primitive bag on the way to the gate, and
 * that is precisely how #863 happened: `agent`/`aiderSettings` were never in
 * the bag, so an aider-configured run put its main phases on aider and its
 * gate silently on claude-code. The config travels whole now.
 */
interface ReadyGateForIssueArgs {
  issueNumber: number;
  worktreePath: string;
  config: ExecutionConfig;
  shutdownManager?: ShutdownManager;
  phasePauseHandle?: PhasePauseHandle;
  onProgress?: ProgressCallback;
  log: (message: string) => void;
  /** Warning channel (#1342); survives parallel mode. Defaults to `log`. */
  warn?: (message: string) => void;
  /** @internal Injected for testing — defaults to the real engine. */
  runGate?: typeof runReadyGate;
  /** @internal Injected for testing — defaults to on-disk settings. */
  getSettingsFn?: typeof getSettings;
  /** @internal Injected for testing — defaults to a real GitHubProvider. */
  fetchBody?: (issueNumber: number) => string | null;
  /** @internal Injected for testing — defaults to a real GitHubProvider. */
  postComment?: (issueNumber: number, body: string) => Promise<void>;
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
  const warn = args.warn ?? log;
  const runGate = args.runGate ?? runReadyGate;
  const getSettingsFn = args.getSettingsFn ?? getSettings;
  const fetchBody =
    args.fetchBody ??
    ((n: number) => new GitHubProvider().fetchIssueBodySync(String(n)));
  const postComment =
    args.postComment ??
    ((n: number, body: string) =>
      new GitHubProvider().postComment(String(n), body));

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
      // #863: hand the gate the parent run's own resolved config, whole. The
      // gate applies only its six gate-semantic overrides on top.
      config,
      runPhase,
      onProgress,
      // #937 AC-4: persist the final gap report as an issue comment.
      postReport: (body) => postComment(issueNumber, body),
      log,
    });

    if (result.ready) {
      log(
        chalk.green(
          `  ✓ Ready gate: ${result.reason} — awaiting human merge (never merged)`,
        ),
      );
    } else {
      warn(`  ⚠️  Ready gate halted: ${result.reason} — needs human review`);
    }

    return { result };
  } catch (err) {
    // Non-fatal: keep the run going to PR with the standard status, but hand
    // the reason back so the summary can say the gate did NOT run.
    const error = err instanceof Error ? err.message : String(err);
    warn(
      `  ⚠️  Ready gate failed for #${issueNumber}: ${error} — continuing to PR without the gate.`,
    );
    return { error };
  }
}

/**
 * #1507: the run-scoped values every stage of `runIssueWithLogging` reads.
 * Built once by `initIssueRun` and never written after; the stages pass it
 * explicitly, so there is no module state.
 */
interface IssueRunEnv {
  ctx: IssueExecutionContext;
  worktreePath: string | undefined;
  branch: string | undefined;
  startTime: number;
  /**
   * #804 AC-6: ONE ledger for the whole issue. Created here rather than inside
   * `executePhaseWithRetry` because the bound and the budget are per-issue —
   * a per-phase ledger would silently grant every phase its own full budget.
   */
  autoWaitLedger: AutoWaitLedger;
  log: (message: string) => void;
  warn: (message: string) => void;
  /** Per-issue config with issue type metadata for skill env propagation. */
  issueConfig: ExecutionConfig;
  relayActivation: ActivationResult | null;
}

/** #1507: the mutable, per-call state the stages of one issue run share. */
interface IssueRunState {
  phaseResults: PhaseResult[];
  loopTriggered: boolean;
  /** Cross-phase resume token, driver-tagged and cwd-bound (#674). */
  resumeHandle: ResumeHandle | undefined;
  phases: Phase[];
  detectedQualityLoop: boolean;
  specAlreadyRan: boolean;
  /** Per-iteration verdicts/SHAs replayed in a ladder halt's evidence bundle. */
  iterationRecords: DivergenceIterationRecord[];
  /** Every rung this issue actually spent — the bundle's "no rung was spent" proof. */
  modelEscalations: ModelEscalationRecord[];
  // Set when a phase hits its turn cap (#739): halt the outer quality-loop
  // retry too, not just the inner /loop spawn — re-running a capped phase
  // would only cap again, and "surface + halt" means the user resumes.
  haltedByCap: boolean;
  // Set when a phase fails with a billing / out-of-credits error or a
  // window-exhausted rate limit (#799): like the turn cap, re-running the phase
  // (or spawning /loop) cannot succeed while the window is closed, so halt the
  // outer quality loop and let the user resume once credits/window are restored.
  haltedByBilling: boolean;
  // #995 (#971 AC-3/4/9): set when the ladder halts instead of climbing — an
  // agent declared the spec impossible (`SPEC_DIVERGENCE`), the loop kept
  // producing diffs at a failing verdict (`DIVERGENCE_SUSPECT`), or a further
  // trigger arrived on the last rung (`TOP_OF_LADDER`). Like the turn cap and
  // the billing window, this suppresses the /loop spawn and breaks the outer
  // quality loop: none of the three can be resolved by running the same work
  // again, and two of them must not be resolved by running it on a stronger
  // model.
  haltedByDivergence: LadderHaltReason | null;
  /** The bundle printed and persisted at the halt. Null until one fires. */
  divergenceBundle: EvidenceBundle | null;
  /**
   * #995 (#971 AC-3): consecutive iterations classified `divergence-suspect`.
   * The halt fires at two, not one: a single divergence-suspect iteration is
   * the ORDINARY `AC_NOT_MET → /loop → re-QA` cycle, and halting on it would
   * break every quality loop in the product. Two in a row is the pattern the
   * AC names — plausible diffs that keep not converging.
   */
  consecutiveDivergenceSuspect: number;
  // #971: per-issue rung state for the model escalation ladder. Stickiness
  // lives here rather than in `ExecutionConfig` — the config is built once per
  // run and shared across every phase, so a rung baked into it would leak
  // (#915 AC-7's rationale). `createLadderState` is cheap and unconditional;
  // the ladder itself is off unless `config.modelLadder` is configured.
  ladderState: LadderState;
  /**
   * #971: the capability-bound trigger observed at the END of the previous
   * quality-loop iteration, consumed by this iteration's dispatches. `null`
   * on the first iteration and whenever the previous iteration produced a
   * diff — progress at a failing verdict is divergence-suspect, never a rung
   * (AC-3).
   */
  lastTrigger: EscalationTrigger | null;
  /**
   * #1520: the PR opened right after exec (#1247), kept so the Read-first
   * comment reaches it when the run ends at a failing verdict and the
   * post-QA PR update never runs.
   */
  earlyPr: { number: number; url: string } | null;
}

/** #1507: one outer quality-loop iteration, as its phase steps see it. */
interface IssueRunIteration {
  iteration: number;
  useQualityLoop: boolean;
  maxIterations: number;
  phasesFailed: boolean;
  /**
   * #995: the verdict this iteration ended on, for the evidence bundle.
   * Scoped to the iteration so a stale verdict from a previous pass cannot
   * be attributed to this one.
   */
  lastPhaseVerdict: string | undefined;
}

/** #1507: a phase the quality loop dispatched, handed to the recording step. */
interface DispatchedPhase {
  result: PhaseResult;
  dispatchConfig: ExecutionConfig;
  escalationRecord: ReturnType<typeof withEscalatedEffort>["record"];
  modelTrigger: EscalationTrigger | null;
  startTime: Date;
  endTime: Date;
}

function createIssueRunState(): IssueRunState {
  return {
    phaseResults: [],
    loopTriggered: false,
    resumeHandle: undefined,
    phases: [],
    detectedQualityLoop: false,
    specAlreadyRan: false,
    iterationRecords: [],
    modelEscalations: [],
    haltedByCap: false,
    haltedByBilling: false,
    haltedByDivergence: null,
    divergenceBundle: null,
    consecutiveDivergenceSuspect: 0,
    ladderState: createLadderState(),
    lastTrigger: null,
    earlyPr: null,
  };
}

/**
 * #860: persist auto-wait transitions to issue state so `sequant status`
 * reports "waiting until <wake>" instead of an hours-stale in-progress
 * phase. Fire-and-forget — state bookkeeping must never disturb the wait
 * it describes.
 */
function makeWaitTransition(
  env: IssueRunEnv,
  phase: string,
): ((wakeAtMs: number | null) => void) | undefined {
  const {
    issueNumber,
    services: { stateManager },
  } = env.ctx;
  return stateManager
    ? (wakeAtMs) => {
        void stateManager
          .updateAutoWait(issueNumber, phase, wakeAtMs)
          .catch((err) => {
            // Never let state bookkeeping disturb a live wait, but count it.
            noteSuppressed("state", err, "updateAutoWait");
          });
      }
    : undefined;
}

/**
 * Persist resume token + originCwd for cross-process resume (#674). `label`
 * is the call site's own `noteSuppressed` label.
 */
async function persistResumeHandle(
  stateManager: StateManager,
  issueNumber: number,
  handle: ResumeHandle,
  label: string,
): Promise<void> {
  try {
    await stateManager.updateResumeHandle(issueNumber, handle);
  } catch (err) {
    // State tracking errors shouldn't stop execution
    noteSuppressed("state", err, label);
  }
}

/**
 * Build errorContext from captured stderr/stdout tails (#447, AC-7/AC-8).
 * Prefer the driver's structured cause (#761 AC-6) — stderr-regex
 * classification never sees the SDK's rate-limit/billing signals.
 */
function buildPhaseErrorContext(result: PhaseResult): ErrorContext | undefined {
  if (result.success || !result.stderrTail) return undefined;
  const typedError =
    result.structuredError ??
    classifyError(result.stderrTail ?? [], result.exitCode);
  return {
    stderrTail: result.stderrTail ?? [],
    stdoutTail: result.stdoutTail ?? [],
    exitCode: result.exitCode,
    category: errorTypeToCategory(typedError),
    errorType: typedError.name,
    errorMetadata: typedError.metadata,
    isRetryable: typedError.isRetryable,
  };
}

/** The run-log status of a phase: `success`, `timeout` or `failure`. */
function phaseLogStatus(
  success: boolean,
  result: PhaseResult,
): "success" | "timeout" | "failure" {
  return success
    ? "success"
    : result.error?.includes("Timeout")
      ? "timeout"
      : "failure";
}

/**
 * #1604: the markers the worktree's mutation receipt certifies, one per AC.
 * A receipt that cannot be read adds none and says so: the PR body then
 * carries only what exec wrote, which QA's §6i still checks.
 */
function receiptMarkers(
  env: IssueRunEnv,
  worktreePath: string,
): MutationMarker[] {
  try {
    return mutationMarkersFromState(
      readMutationState(worktreePath, env.ctx.issueNumber),
    );
  } catch (err) {
    noteSuppressed("state", err, "batch-executor:receiptMarkers");
    env.warn(
      `    !  Mutation receipt for #${env.ctx.issueNumber} unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

// #1247: the one call site of `createPR` (the only PR producer under the
// orchestrator). It runs after each successful exec pass, so a PR exists
// while qa reads the PR body, and again after QA, where `createPR`'s update
// path adds the QA note and the ready-gate report to the same PR.
async function openOrUpdatePR(
  env: IssueRunEnv,
  state: IssueRunState,
  prPath: string,
  prBranch: string,
  after: {
    qaVerdict?: string;
    readyGateReport?: string;
    followups?: GapFinding[];
  } = {},
): Promise<ReturnType<typeof createPR>> {
  const {
    issueNumber,
    config,
    title: issueTitle,
    labels,
    services: { stateManager },
    chain,
    baseBranch,
  } = env.ctx;
  const { phaseResults } = state;
  // #605: under --stacked, target predecessor branch (only for non-first,
  // non-last issues). The last PR targets the run's base (#1386: `--base`,
  // else the repo default) so partial progress can land.
  const stackOptions =
    chain?.predecessorBranch || chain?.stackManifest
      ? {
          prBase: chain.predecessorBranch,
          stackManifest: chain.stackManifest,
        }
      : undefined;
  // #1223 AC-2: surface exec's own `## Summary` in the PR body instead of
  // the placeholder text.
  // The latest exec pass: a quality-loop iteration re-runs exec, and the
  // first pass's summary describes code the loop has since changed.
  const latestExec = latestPhaseResult(phaseResults, "exec");
  const execOutput = latestExec?.output;
  // #1247 AC-3: a run with no exec pass (qa-only re-run) falls back to the
  // summary the last exec pass recorded on the issue's state.
  // #1246 AC-1: "QA has run" means QA reviewed the latest exec. In this run
  // that is a qa result after the last exec result: a quality-loop
  // iteration's after-exec update (`[exec, qa, loop, exec]`) is unreviewed.
  // A qa completed by an earlier run (state) counts only when this run ran
  // no exec (`--resume` past qa, a qa-only re-run): an exec re-run puts code
  // on the PR that the earlier qa never saw.
  const lastIndexOf = (phase: Phase): number => {
    for (let i = phaseResults.length - 1; i >= 0; i--) {
      if (phaseResults[i].phase === phase) return i;
    }
    return -1;
  };
  const qaCoversLatestExec = lastIndexOf("qa") > lastIndexOf("exec");
  let execSummary: string | undefined;
  let priorQaCompleted = false;
  if (!latestExec && stateManager) {
    try {
      const issueState = await stateManager.getIssueState(issueNumber);
      execSummary = issueState?.execSummary;
      priorQaCompleted = issueState?.phases?.qa?.status === "completed";
    } catch (err) {
      // State read errors fall back to the placeholder text and count as
      // "QA has not run" — the note errs toward flagging an unreviewed PR.
      noteSuppressed("state", err, "getIssueState");
    }
  }
  // #1246 AC-1: a PR from a run QA has not reviewed says so. Distinct from
  // `ranQa` in `settleIssueStatus` (#1233 status), which deliberately ignores
  // prior runs.
  const qaNotRun =
    qaCoversLatestExec || priorQaCompleted
      ? undefined
      : {
          phasesRun: [
            ...new Set(
              phaseResults
                .map((p) => p.phase)
                .filter((phase) => phase !== "loop"),
            ),
          ],
        };
  // #1297 AC-3: say so when the body will be the placeholder.
  // #1311 AC-3: name the length of the exec output used, so "exec wrote
  // nothing" and "exec wrote a summary the extractor missed" read
  // differently. `warn`, not `log`: `log` is a no-op in parallel mode
  // (every MCP run), which hid this warning.
  // #1604: the receipt's markers reach the body without exec writing them.
  const mutationMarkers = receiptMarkers(env, prPath);
  if (
    !composeExecSummary(execOutput) &&
    !execSummary?.trim() &&
    mutationMarkers.length === 0
  ) {
    env.warn(
      `    !  PR body for #${issueNumber}: exec output (${execOutput?.length ?? 0} chars) has no Summary or mutation markers; using placeholder`,
    );
  }
  const prResult = createPR(
    prPath,
    issueNumber,
    issueTitle,
    prBranch,
    config.verbose,
    labels,
    stackOptions,
    after.qaVerdict,
    after.readyGateReport,
    // #1197: closing-keyword mode + its label override, resolved once by
    // buildExecutionConfig from settings.run.prIssueLink/prNoCloseLabel.
    config.prIssueLink,
    config.prNoCloseLabel,
    {
      // #1386: the same resolved base worktree creation and
      // `rebaseBeforePR` received; `createPR` resolves the PR target from it.
      baseBranch,
      execOutput,
      execSummary,
      followups: after.followups,
      qaNotRun,
      mutationMarkers,
    },
  );
  if (prResult.success && prResult.prNumber && prResult.prUrl && stateManager) {
    try {
      await stateManager.updatePRInfo(issueNumber, {
        number: prResult.prNumber,
        url: prResult.prUrl,
      });
    } catch (err) {
      // State tracking errors shouldn't stop execution
      noteSuppressed("state", err, "updatePRInfo");
    }
  }
  return prResult;
}

/**
 * #995: assemble the evidence bundle for a ladder halt.
 *
 * Reads only state the issue run already keeps, so a halt costs no extra
 * `git` call on top of the ladder's existing per-iteration snapshot. The
 * `escalationHistory` it hands over is the live `modelEscalations` array —
 * empty on a `SPEC_DIVERGENCE` or `DIVERGENCE_SUSPECT` halt, which is what
 * makes "no rung was spent" a fact in the record rather than a claim in a
 * comment (#971 AC-3/AC-4).
 *
 * #1250: shared with the spec path, so a spec-phase SPEC_DIVERGENCE halt
 * reuses the one bundle builder. Both arrays are still empty at spec time —
 * the "no SHA tried, no rung spent" record.
 */
function buildBundle(
  issueNumber: number,
  state: IssueRunState,
  reason: LadderHaltReason,
  phase: string,
  declared?: { acs?: string; message?: string },
): EvidenceBundle {
  return {
    issueNumber,
    phase,
    reason,
    shasTried: [
      ...new Set(
        state.iterationRecords
          .map((r) => r.sha)
          .filter((sha): sha is string => Boolean(sha)),
      ),
    ],
    iterations: [...state.iterationRecords],
    escalationHistory: [...state.modelEscalations],
    // `declaredAcs` is present-but-empty when the agent halted without naming
    // an AC; the formatter reports that explicitly rather than omitting the
    // line, because AC-14 requires the halt output to name the AC.
    ...(reason === "SPEC_DIVERGENCE"
      ? { declaredAcs: declared?.acs ?? "" }
      : {}),
    ...(declared?.message ? { message: declared.message } : {}),
  };
}

/**
 * #1507: the run's setup — banner, the #1469 worktree-required guard, state
 * init and relay activation. Returns `aborted` when the guard fails the
 * issue before any phase runs.
 */
async function initIssueRun(
  ctx: IssueExecutionContext,
): Promise<{ env: IssueRunEnv } | { aborted: IssueResult }> {
  const {
    issueNumber,
    config,
    title: issueTitle,
    labels,
    services: { stateManager },
    worktree,
    worktreeRequired,
    worktreeError,
    phasePauseHandle,
  } = ctx;
  const worktreePath = worktree?.path;
  const branch = worktree?.branch;
  const startTime = Date.now();
  const autoWaitLedger = createAutoWaitLedger(config.autoWaitMinutes);

  // In parallel mode, suppress per-issue terminal output to prevent interleaving.
  // The caller (run.ts) handles progress display via updateProgress().
  const log = config.parallel ? () => {} : console.log.bind(console);
  // Warnings are not progress (#1342): they must survive parallel mode, which
  // is every MCP run. Routed through the renderer's notice channel so a live
  // TUI zone is not corrupted by a raw stdout write (#655, #647).
  const warn = (message: string): void =>
    bracketedConsoleLog(phasePauseHandle, chalk.yellow(message));

  log(chalk.blue(`\n  Issue #${issueNumber}`));
  if (worktreePath) {
    log(chalk.gray(`    Worktree: ${worktreePath}`));
  }

  // #1469: under isolation an issue without a worktree would run every phase
  // in the main checkout (the executor falls back to process.cwd()). Fail it
  // here, before state init and before any phase.
  if (worktreeRequired && !worktree) {
    const abortReason = `worktree provisioning failed: ${worktreeError ?? "no worktree was created"}`;
    bracketedConsoleLog(
      phasePauseHandle,
      chalk.red(`  ✖ #${issueNumber}: ${abortReason}`),
    );
    return {
      aborted: {
        issueNumber,
        success: false,
        phaseResults: [],
        durationSeconds: (Date.now() - startTime) / 1000,
        loopTriggered: false,
        abortReason,
      },
    };
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
        warn(`    !  State tracking error: ${error}`);
      }
    }
  }

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
        warn(`    !  Relay: ${relayActivation.warning}`);
      } else if (relayActivation.activated && config.verbose) {
        log(
          chalk.gray(
            `    Relay active — use \`sequant prompt ${issueNumber} "<msg>"\` to nudge`,
          ),
        );
      }
    } catch (err) {
      if (config.verbose) {
        warn(`    !  Relay activation failed: ${err}`);
      }
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

  return {
    env: {
      ctx,
      worktreePath,
      branch,
      startTime,
      autoWaitLedger,
      log,
      warn,
      issueConfig,
      relayActivation,
    },
  };
}

/** The spec phase's result and its dispatch timing. */
interface DispatchedSpec {
  result: PhaseResult;
  startTime: Date;
  endTime: Date;
}

/**
 * #1507: the auto-detect path — run spec, record its outcome, and resolve
 * the phase plan from its recommendation. Returns an `IssueResult` when spec
 * halts the issue.
 */
async function runSpecStage(
  env: IssueRunEnv,
  state: IssueRunState,
): Promise<IssueResult | undefined> {
  const spec = await dispatchSpecPhase(env, state);
  const halted = await recordSpecOutcome(env, state, spec);
  if (halted) return halted;
  resolvePhasesFromSpec(env, state, spec.result);
  return undefined;
}

async function dispatchSpecPhase(
  env: IssueRunEnv,
  state: IssueRunState,
): Promise<DispatchedSpec> {
  const {
    issueNumber,
    config,
    services: { stateManager, shutdownManager },
    onProgress,
    phasePauseHandle,
  } = env.ctx;
  // #533: Always run spec to get recommended workflow.
  // The prior bug/docs shortcut (skip spec → exec → qa) was removed because
  // bug and docs issues often contain design decisions (scope boundaries,
  // edge cases, test-strategy shifts) that benefit from a spec pass.
  env.log(chalk.gray(`    Running spec to determine workflow...`));

  // RunRenderer (#618) owns spec progress via emitProgressLine + onProgress.
  // The legacy PhaseSpinner produced duplicate lines for single-issue runs.
  emitProgressLine(issueNumber, "spec", "start");
  try {
    onProgress?.(issueNumber, "spec", "start");
  } catch (err) {
    /* progress errors must not halt */
    noteSuppressed("progress", err, "spec start");
  }

  // Track spec phase start in state
  if (stateManager) {
    try {
      await stateManager.updatePhaseStatus(issueNumber, "spec", "in_progress");
    } catch (err) {
      // State tracking errors shouldn't stop execution
      noteSuppressed("state", err, "spec in_progress");
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
      makeWaitTransition(env, "spec"),
    ),
    state.resumeHandle,
    env.worktreePath, // Will be ignored for spec (non-isolated phase)
    shutdownManager,
    phasePauseHandle,
    undefined, // executePhaseFn — use the default
    undefined, // delayFn — use the default
    env.autoWaitLedger, // #804: shared across every phase of this issue
  );
  const specEndTime = new Date();

  if (specResult.resumeHandle) {
    state.resumeHandle = specResult.resumeHandle;
    if (stateManager) {
      await persistResumeHandle(
        stateManager,
        issueNumber,
        specResult.resumeHandle,
        "spec resume handle",
      );
    }
  }

  state.phaseResults.push(specResult);
  state.specAlreadyRan = true;
  return { result: specResult, startTime: specStartTime, endTime: specEndTime };
}

/**
 * Records the spec phase (progress, run log, state, window halt) and decides
 * whether it halts the issue. Returns the halting `IssueResult`, if any.
 */
async function recordSpecOutcome(
  env: IssueRunEnv,
  state: IssueRunState,
  spec: DispatchedSpec,
): Promise<IssueResult | undefined> {
  const {
    issueNumber,
    config,
    services: { logWriter, stateManager },
    onProgress,
  } = env.ctx;
  const {
    result: specResult,
    startTime: specStartTime,
    endTime: specEndTime,
  } = spec;
  const { phaseResults } = state;
  // #1254: one decision for the progress event, run-log row and state.
  const specRecord = phaseRecordFor(specResult);

  // Emit completion/failure progress event (AC-8)
  const specDurationSec = Math.round(
    (specEndTime.getTime() - specStartTime.getTime()) / 1000,
  );
  if (specRecord.success) {
    const extra = { durationSeconds: specDurationSec };
    emitProgressLine(issueNumber, "spec", "complete", extra);
    try {
      onProgress?.(issueNumber, "spec", "complete", extra);
    } catch (err) {
      /* progress errors must not halt */
      noteSuppressed("progress", err, "spec complete");
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
          : (specRecord.error ?? "unknown"),
    };
    emitProgressLine(issueNumber, "spec", "failed", extra);
    try {
      onProgress?.(issueNumber, "spec", "failed", extra);
    } catch (err) {
      /* progress errors must not halt */
      noteSuppressed("progress", err, "spec failed");
    }
  }

  // Log spec phase result
  // Note: Spec runs in main repo, not worktree, so no git diff stats
  if (logWriter) {
    const phaseLog = createPhaseLogFromTiming(
      "spec",
      issueNumber,
      specStartTime,
      specEndTime,
      phaseLogStatus(specRecord.success, specResult),
      {
        error: specRecord.error,
        // Mark a turn-capped spec phase distinctly in the log (#739), matching
        // the main phase loop: status stays "failure" but `capped` flags it.
        capped: specResult.capped,
        errorContext: buildPhaseErrorContext(specResult),
        // #1198 AC-1: resolved model (from modelUsage) and the pre-resolution
        // policy value, when a role: policy was configured for this phase.
        model: specResult.resolvedModel,
        requestedModel: config.phasePolicies?.["spec"]?.requestedModel,
      },
    );
    logWriter.logPhase(phaseLog);
  }

  // Track spec phase completion in state
  if (stateManager) {
    try {
      const phaseStatus = specRecord.success ? "completed" : "failed";
      await stateManager.updatePhaseStatus(issueNumber, "spec", phaseStatus, {
        error: specRecord.error,
        // Mark a turn-capped spec halt distinctly in state (#739), matching
        // the run-log marker — status stays "failed", `capped` flags it.
        capped: specResult.capped,
        outcome: specRecord.outcome,
        divergenceAcs: specRecord.divergenceAcs,
      });
    } catch (err) {
      // State tracking errors shouldn't stop execution
      noteSuppressed("state", err, "spec phase status");
    }
  }

  // Durable halt-and-resume (#892 AC-1): a waitable-window spec halt writes
  // `resumeAt` so `sequant resume` can re-enter after the window reopens.
  await recordWindowHaltState(stateManager, issueNumber, "spec", specResult);

  // #1250: spec declared the issue's prescribed lever wrong
  // (`SPEC_DIVERGENCE`). Print the bundle and halt before exec — the same
  // halt the phase loop applies (#995). Outside the success split for the
  // same reason: a spec that declares divergence and still emits a valid
  // `SEQUANT_SPEC` passes the #1193 guard and would otherwise reach exec.
  const specBundle = specResult.specDivergence
    ? buildBundle(
        issueNumber,
        state,
        "SPEC_DIVERGENCE",
        "spec",
        specResult.specDivergence,
      )
    : null;
  if (specBundle) {
    env.warn(formatEvidenceBundle(specBundle));
  }

  if (!specResult.success || specResult.specDivergence) {
    const durationSeconds = (Date.now() - env.startTime) / 1000;
    // Archive relay state on early exit (spec failure).
    if (env.relayActivation) {
      try {
        await deactivateRelay(issueNumber, {
          phase: "spec",
          startedAt: env.relayActivation.startedAt,
          worktreePath: env.worktreePath,
          stateManager: stateManager ?? null,
        });
      } catch (err) {
        /* swallow */
        noteSuppressed("cleanup", err, "deactivateRelay spec");
      }
    }
    return {
      issueNumber,
      success: false,
      phaseResults,
      durationSeconds,
      loopTriggered: false,
      // #1254: a halt records its reason and bundle, not an empty category.
      ...(specBundle
        ? ladderHaltOutcome(specBundle)
        : { failureCategory: deriveFailureCategory(phaseResults) }),
    };
  }
  return undefined;
}

function resolvePhasesFromSpec(
  env: IssueRunEnv,
  state: IssueRunState,
  specResult: PhaseResult,
): void {
  const {
    issueNumber,
    labels,
    services: { logWriter },
  } = env.ctx;
  const { log, warn } = env;
  // Resolve the spec→run phase recommendation through the ordered chain
  // comment-marker → comment-prose → chat-text → label-fallback (#921).
  // Chat-text parsing alone is nondeterministic: the spec agent's plan
  // comment is the durable artifact, but the old code only ever looked at
  // ephemeral chat output, silently dropping recommended phases (e.g.
  // testgen) whenever the agent posted the plan via a body file (#814).
  const resolved = resolveSpecRecommendation({
    chatOutput: specResult.output ?? "",
    issueNumber,
    labels,
  });
  // `resolveSpecRecommendation` already excludes "spec" regardless of
  // which step in the chain produced the result.
  const phases = resolved.phases;
  const detectedQualityLoop = resolved.qualityLoop;
  state.phases = phases;
  state.detectedQualityLoop = detectedQualityLoop;
  if (logWriter) {
    logWriter.setSpecRecommendation(
      { source: resolved.source, phases, qualityLoop: detectedQualityLoop },
      issueNumber,
    );
  }
  if (resolved.source === "marker") {
    log(
      chalk.gray(
        `    Spec recommends (marker): ${phases.join(" → ")}${detectedQualityLoop ? " (quality loop)" : ""}`,
      ),
    );
  } else if (resolved.source === "comment-prose") {
    log(
      chalk.gray(
        `    Spec recommends (comment): ${phases.join(" → ")}${detectedQualityLoop ? " (quality loop)" : ""}`,
      ),
    );
  } else if (resolved.source === "chat") {
    log(
      chalk.gray(
        `    Spec recommends (chat): ${phases.join(" → ")}${detectedQualityLoop ? " (quality loop)" : ""}`,
      ),
    );
  } else {
    warn(
      `    Could not parse spec recommendation, using label-based detection`,
    );
    log(chalk.gray(`    Fallback: ${phases.join(" → ")}`));
  }
}

/**
 * #1507: the phase-list mutations that follow phase selection — the resume
 * filter, testgen/security-review insertion — and the `onPhasePlan` report.
 */
function finalizePhasePlan(env: IssueRunEnv, state: IssueRunState): void {
  const { issueNumber, options, onPhasePlan } = env.ctx;
  const { log } = env;
  const { specAlreadyRan } = state;

  // Resume: filter out completed phases if --resume flag is set
  if (options.resume) {
    const resumeResult = filterResumedPhases(issueNumber, state.phases, true);
    if (resumeResult.skipped.length > 0) {
      log(
        chalk.gray(
          `    Resume: skipping completed phases: ${resumeResult.skipped.join(", ")}`,
        ),
      );
      state.phases = resumeResult.phases;
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
  const { phases } = state;

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
    } catch (err) {
      /* renderer wiring errors must not halt execution */
      noteSuppressed("progress", err, "onPhasePlan");
    }
  }
}

/**
 * #1507: the outer quality loop. Returns whether every phase passed in some
 * iteration.
 */
async function runQualityLoop(
  env: IssueRunEnv,
  state: IssueRunState,
): Promise<boolean> {
  const { config, snapshotProgressFn } = env.ctx;
  const { worktreePath } = env;
  let iteration = 0;
  const useQualityLoop = config.qualityLoop || state.detectedQualityLoop;
  const maxIterations = useQualityLoop ? config.maxIterations : 1;
  let completedSuccessfully = false;
  /**
   * #971 AC-D2: the ladder needs a per-iteration progress snapshot, which
   * costs two `git` invocations. Gate it on a configured ladder so an
   * unconfigured run issues ZERO additional `git` calls per iteration and
   * stays byte-identical to pre-#971.
   */
  const ladderConfigured = isLadderConfigured(env.issueConfig);
  const takeSnapshot = snapshotProgressFn ?? snapshotLoopProgress;

  while (iteration < maxIterations) {
    iteration++;
    // #971: snapshot before this iteration's phases so the end-of-iteration
    // comparison can tell "produced nothing" (capability-bound) from
    // "produced a diff that still failed" (divergence-suspect).
    const iterationStartSnapshot =
      ladderConfigured && worktreePath ? takeSnapshot(worktreePath) : null;

    if (useQualityLoop && iteration > 1) {
      env.log(
        chalk.cyan(`    Quality loop iteration ${iteration}/${maxIterations}`),
      );
      state.loopTriggered = true;
    }

    const iter: IssueRunIteration = {
      iteration,
      useQualityLoop,
      maxIterations,
      phasesFailed: false,
      lastPhaseVerdict: undefined,
    };

    for (let phaseIdx = 0; phaseIdx < state.phases.length; phaseIdx++) {
      const step = await runPhaseStep(env, state, iter, state.phases[phaseIdx]);
      if (step === "break") break;
    }

    // Gated on a configured ladder, so an unconfigured run performs no
    // snapshot and issues no extra `git` calls (AC-D2).
    if (iterationStartSnapshot && worktreePath) {
      assessIterationProgress(
        env,
        state,
        iter,
        iterationStartSnapshot,
        takeSnapshot(worktreePath),
      );
    }

    // If all phases passed, exit the loop
    if (!iter.phasesFailed) {
      completedSuccessfully = true;
      break;
    }

    // A turn-capped phase (#739) halts the outer quality-loop retry as well —
    // re-running would only cap again; the partial work is already preserved.
    // A billing / rate-limit-window failure (#799) halts for the same reason:
    // the retry re-spawns into the same closed window and cannot progress.
    if (
      state.haltedByCap ||
      state.haltedByBilling ||
      state.haltedByDivergence !== null
    ) {
      break;
    }

    // If we're not in quality loop mode, don't retry
    if (!config.qualityLoop) {
      break;
    }
  }
  return completedSuccessfully;
}

/**
 * #1507: one phase of one iteration. `"break"` stops the iteration's phase
 * chain, exactly where the inline loop used to `break`.
 */
async function runPhaseStep(
  env: IssueRunEnv,
  state: IssueRunState,
  iter: IssueRunIteration,
  phase: Phase,
): Promise<"next" | "break"> {
  const dispatched = await dispatchLoopPhase(env, state, iter, phase);
  if (!dispatched) return "break";

  await recordLoopPhaseOutcome(env, state, iter, phase, dispatched);

  // #995 (#971 AC-4): print the bundle and stop the phase chain. Placed
  // AFTER the result was pushed, logged, and persisted, so the partial
  // work survives the halt (#739's ordering). Deliberately outside the
  // success/failure split: an agent that declares the spec impossible and
  // exits cleanly must halt the run just as surely as one that trips a
  // deliverable guard on the way out — the declaration is the signal, not
  // the exit status.
  if (
    state.haltedByDivergence === "SPEC_DIVERGENCE" &&
    state.divergenceBundle
  ) {
    iter.phasesFailed = true;
    env.warn(formatEvidenceBundle(state.divergenceBundle));
    return "break";
  }

  if (dispatched.result.success) {
    // Phase succeeded — RunRenderer (#618) updates state via onProgress.
    return "next";
  }
  await handlePhaseFailure(
    env,
    state,
    iter,
    dispatched.result,
    dispatched.modelTrigger,
  );
  // Stop on first failure. A /loop pass that succeeded also ends this
  // iteration's phase chain: the next iteration re-runs the phases.
  return "break";
}

/**
 * Emits the phase's start, applies effort/model escalation and dispatches
 * it. Returns `null` when the ladder halts at its top rung instead.
 */
async function dispatchLoopPhase(
  env: IssueRunEnv,
  state: IssueRunState,
  iter: IssueRunIteration,
  phase: Phase,
): Promise<DispatchedPhase | null> {
  const {
    issueNumber,
    config,
    services: { stateManager, shutdownManager },
    onProgress,
    phasePauseHandle,
  } = env.ctx;
  const { log } = env;
  const { iteration } = iter;

  // RunRenderer (#618) owns phase progress via emitProgressLine + onProgress.
  // #624 Item 3: surface the outer-loop iteration on every retried phase
  // event so the renderer can label them `(attempt N/M)`. First-attempt
  // events still get `iteration: 1` so the data flow is uniform; the
  // renderer's `formatRetrySuffix` suppresses the suffix when iteration ≤ 1.
  const phaseExtra: { iteration: number } = { iteration };
  emitProgressLine(issueNumber, phase, "start", phaseExtra);
  try {
    onProgress?.(issueNumber, phase, "start", phaseExtra);
  } catch (err) {
    /* progress errors must not halt */
    noteSuppressed("progress", err, "phase start");
  }

  // Track phase start in state
  if (stateManager) {
    try {
      await stateManager.updatePhaseStatus(issueNumber, phase, "in_progress");
    } catch (err) {
      // State tracking errors shouldn't stop execution
      noteSuppressed("state", err, "phase in_progress");
    }
  }

  // #915: iteration > 1 is the outer quality-loop's retry signal — the
  // same condition that triggers the "Quality loop iteration" log line
  // above. This loop re-runs the WHOLE `phases` list on every iteration
  // (it does not resume from the specific phase that failed), so the
  // escalation is per RETRIED ITERATION, not per specific-phase-that-
  // previously-failed: every phase dispatched while iteration > 1
  // escalates, including one that already succeeded on iteration 1 (e.g.
  // exec re-running alongside a retried qa). `withEscalatedEffort` is a
  // no-op (returns the input config by reference) whenever escalation is
  // off or this is the first attempt.
  //
  // #971 AC-5, enforced structurally rather than by convention. Both
  // halves come from ONE value, `modelTrigger`:
  //
  // - "retry 1 escalates effort only": `effectiveModelTrigger` withholds
  //   the trigger until retry 2, so the first retry leaves the effort
  //   bump enabled and spends the cheap rung — the ladder's own cost
  //   argument, applied to #915's rung.
  // - "never both on one iteration": from retry 2 on, an active trigger
  //   disables the effort bump and spends a model rung instead.
  //
  // Written this way, "effort and model both changed on one iteration" is
  // unrepresentable rather than merely untested.
  const modelTrigger = effectiveModelTrigger(state.lastTrigger, iteration - 1);
  const { config: effortConfig, record: escalationRecord } =
    withEscalatedEffort(
      withActivityHook(
        env.issueConfig,
        issueNumber,
        phase,
        onProgress,
        makeWaitTransition(env, phase),
      ),
      phase,
      iteration > 1 && modelTrigger === null,
    );
  if (escalationRecord && config.verbose) {
    log(
      chalk.gray(
        `    effort: ${escalationRecord.base} → ${escalationRecord.escalated} (loop retry)`,
      ),
    );
  }
  // #971: apply the ladder for THIS dispatch. A no-op returning the input
  // config by reference whenever no ladder is configured, no trigger
  // arrived and no sticky rung has been reached, or the phase's `--models`
  // pin is off-ladder (AC-7).
  const {
    config: dispatchConfig,
    record: modelRecord,
    topOfLadder: phaseTopOfLadder,
  } = withEscalatedModel(effortConfig, phase, modelTrigger, state.ladderState);
  if (modelRecord) state.modelEscalations.push(modelRecord);
  if (modelRecord && config.verbose) {
    log(
      chalk.gray(
        `    model: ${modelRecord.base} → ${modelRecord.escalated} (${formatEscalationTriggerLabel(modelRecord.trigger)} retry)`,
      ),
    );
  }

  // #995 (#971 AC-9): a capability-bound trigger arrived and the phase is
  // already on the last rung. Before #995 this flag was produced and
  // consumed by nothing — the run simply looped again on the same model,
  // which is the one thing the evidence says will not work. Halt with the
  // bundle instead of dispatching.
  if (phaseTopOfLadder) {
    state.haltedByDivergence = "TOP_OF_LADDER";
    state.divergenceBundle = buildBundle(
      issueNumber,
      state,
      "TOP_OF_LADDER",
      phase,
    );
    env.warn(formatEvidenceBundle(state.divergenceBundle));
    iter.phasesFailed = true;
    return null;
  }

  const phaseStartTime = new Date();
  // #982: qa never resumes the implementer's session (first pass and
  // any post-loop re-QA alike) — the fresh-session QA study found the
  // resumed reviewer starts anchored to the author's transcript. This is
  // the only site that can dispatch qa; see #982 spec for the sibling-site
  // scan (ready-gate already undefined, spec-only, loop).
  const result = await executePhaseWithRetry(
    issueNumber,
    phase,
    dispatchConfig,
    phase === "qa" ? undefined : state.resumeHandle,
    env.worktreePath,
    shutdownManager,
    phasePauseHandle,
    undefined, // executePhaseFn — use the default
    undefined, // delayFn — use the default
    env.autoWaitLedger, // #804: shared across every phase of this issue
  );
  const phaseEndTime = new Date();

  // Capture resume handle for subsequent phases (#674). qa's own handle
  // is never captured (#982): the driver builds a handle for the fresh
  // qa session too, and whatever phase runs next resumes the LAST
  // captured handle. Without this guard that next phase — `loop` on a
  // quality-loop retry, or the retried exec when no loop runs — would
  // resume qa's fresh session, which holds the reviewer's transcript
  // and none of the implementer's. With it, loop (and through loop, the
  // retried exec) resume exec's session as before #982; loop still gets
  // the verdict via SEQUANT_LAST_VERDICT/SEQUANT_FAILED_ACS (#488).
  // Disclosed in the CHANGELOG: pre-#982 loop resumed the exec+qa
  // session; now it resumes the exec session only.
  if (result.resumeHandle && phase !== "qa") {
    state.resumeHandle = result.resumeHandle;
    if (stateManager) {
      await persistResumeHandle(
        stateManager,
        issueNumber,
        result.resumeHandle,
        "phase resume handle",
      );
    }
  }

  return {
    result,
    dispatchConfig,
    escalationRecord,
    modelTrigger,
    startTime: phaseStartTime,
    endTime: phaseEndTime,
  };
}

/**
 * Records a dispatched phase: the result, its progress event, the qa verdict
 * comment, the run log, state, the post-exec PR and the window-halt record.
 */
async function recordLoopPhaseOutcome(
  env: IssueRunEnv,
  state: IssueRunState,
  iter: IssueRunIteration,
  phase: Phase,
  dispatched: DispatchedPhase,
): Promise<void> {
  const {
    issueNumber,
    options,
    services: { stateManager },
    onProgress,
    baseBranch,
    postComment: injectedPostComment,
  } = env.ctx;
  const { worktreePath, branch, warn } = env;
  const { iteration } = iter;
  const { result, escalationRecord, dispatchConfig } = dispatched;
  const { phaseResults } = state;

  // #995 (#971 AC-4): the escape hatch. The agent declared an AC
  // impossible as written, so no retry was dispatched (`phase-executor`
  // short-circuits) and no rung is spent here either. Recorded BEFORE the
  // result is pushed so the halt is visible even if a later step throws;
  // the break itself happens in `runPhaseStep`, after the result is
  // preserved and the failure events are emitted, so the partial work is
  // not lost — the same "surface + halt" ordering the turn cap (#739) uses.
  if (result.verdict) iter.lastPhaseVerdict = result.verdict;

  if (result.specDivergence) {
    state.haltedByDivergence = "SPEC_DIVERGENCE";
    state.divergenceBundle = buildBundle(
      issueNumber,
      state,
      "SPEC_DIVERGENCE",
      phase,
      result.specDivergence,
    );
  }

  phaseResults.push(
    escalationRecord
      ? {
          ...result,
          escalatedEffort: {
            base: escalationRecord.base,
            escalated: escalationRecord.escalated,
          },
        }
      : result,
  );

  // #1254: one decision for the progress event, run-log row and state.
  const record = phaseRecordFor(result);

  // Emit completion/failure progress event (AC-8)
  const phaseDurationSec = Math.round(
    (dispatched.endTime.getTime() - dispatched.startTime.getTime()) / 1000,
  );
  if (record.success) {
    const extra = { durationSeconds: phaseDurationSec, iteration };
    emitProgressLine(issueNumber, phase, "complete", extra);
    try {
      onProgress?.(issueNumber, phase, "complete", extra);
    } catch (err) {
      /* progress errors must not halt */
      noteSuppressed("progress", err, "phase complete");
    }
  } else {
    // A turn-capped phase is incomplete-but-not-hard-failed (#739): surface a
    // distinct "partial output preserved" signal instead of a generic failure
    // reason, so the user knows the run halted on a recoverable cap (and can
    // resume) rather than on a genuine error. The partial `result.output` is
    // already preserved in `phaseResults` (pushed above) and the phase log
    // (`capped` flag below); the run still halts cleanly in `runPhaseStep`.
    const extra = {
      error: result.capped
        ? "turn cap reached — partial output preserved (resume to continue)"
        : isBillingOrWindowHalt(result)
          ? // Billing / rate-limit-window halt (#799): name the real cause so
            // the run summary doesn't cascade into a downstream
            // `QA completed without a parseable verdict`.
            billingHaltReason(result)
          : (record.error ?? "unknown"),
      iteration,
    };
    emitProgressLine(issueNumber, phase, "failed", extra);
    try {
      onProgress?.(issueNumber, phase, "failed", extra);
    } catch (err) {
      /* progress errors must not halt */
      noteSuppressed("progress", err, "phase failed");
    }
  }

  // #964: post the verdict from a standard (non-ready-gate) qa phase.
  // qa/SKILL.md §9 promises "the orchestrator handles aggregated summary"
  // under SEQUANT_ORCHESTRATOR, but nothing backed that promise — a
  // re-run producing a fresh, different verdict left the stale prior
  // comment as the only externally-visible one. Gating on `result.verdict`
  // alone excludes turn-capped and unparseable-verdict phases (AC-4),
  // since a verdict is only set once one parsed. `result.success` is
  // deliberately absent (#1070): AC_NOT_MET is a failed phase carrying a
  // full findings payload, and it is the review that most needs posting.
  if (phase === "qa" && result.verdict) {
    const verdictDiffBase = worktreePath
      ? resolveDiffBase(worktreePath, baseBranch ?? "main")
      : undefined;
    const verdictCommitHash =
      worktreePath && verdictDiffBase
        ? getCommitHash(worktreePath, verdictDiffBase)
        : undefined;
    await postQaVerdictComment(
      issueNumber,
      result.verdict,
      result.summary,
      verdictCommitHash,
      iteration,
      warn,
      injectedPostComment,
      attributionFromPhases(phaseResults, dispatchConfig),
    );
  }

  logLoopPhaseResult(env, phase, dispatched, record);

  // Track phase completion in state
  if (stateManager) {
    try {
      const phaseStatus = record.success ? "completed" : "failed";
      await stateManager.updatePhaseStatus(issueNumber, phase, phaseStatus, {
        error: record.error,
        // Mark a turn-capped phase halt distinctly in state (#739),
        // matching the run-log marker — status stays "failed",
        // `capped` flags it as recoverable for the resume path.
        capped: result.capped,
        outcome: record.outcome,
        divergenceAcs: record.divergenceAcs,
      });
    } catch (err) {
      // State tracking errors shouldn't stop execution
      noteSuppressed("state", err, "phase status");
    }
  }

  // #1247 AC-3: keep exec's summary on the issue's state, so a later
  // qa-only run (exec → qa AC_NOT_MET → qa re-run) can still put it in
  // the PR body instead of the placeholder.
  if (stateManager && phase === "exec" && result.success) {
    try {
      await stateManager.updateExecSummary(
        issueNumber,
        composeExecSummary(result.output),
      );
    } catch (err) {
      // State tracking errors shouldn't stop execution
      noteSuppressed("state", err, "updateExecSummary");
    }
  }

  // #1247 AC-5 (owner decision, option B): open the PR as soon as exec
  // has committed work, so qa — which reads the mutation records, the AC
  // table and the test-plan boxes from the PR body — has a body to read.
  // A failure here only warns: the post-QA call retries and stays fatal
  // (#879). An exec that declared the spec impossible (`SPEC_DIVERGENCE`)
  // halts in `runPhaseStep` even on success, and opens no PR.
  if (
    phase === "exec" &&
    result.success &&
    !result.specDivergence &&
    worktreePath &&
    branch &&
    !options.noPr &&
    hasExecChanges(worktreePath)
  ) {
    const early = await openOrUpdatePR(env, state, worktreePath, branch);
    if (early.success && early.prNumber && early.prUrl) {
      state.earlyPr = { number: early.prNumber, url: early.prUrl };
    }
    if (early.attempted && !early.success) {
      warn(
        `    !  PR after exec failed (retried after QA): ${early.error ?? "unknown error"}`,
      );
    }
  }

  // Durable halt-and-resume (#892 AC-1): a waitable-window halt writes
  // `resumeAt`; success or a non-window failure clears any stale record.
  await recordWindowHaltState(stateManager, issueNumber, phase, result);
}

/** Log phase result with observability data (AC-1, AC-2, AC-3, AC-7). */
function logLoopPhaseResult(
  env: IssueRunEnv,
  phase: Phase,
  dispatched: DispatchedPhase,
  record: ReturnType<typeof phaseRecordFor>,
): void {
  const {
    issueNumber,
    config,
    services: { logWriter },
    baseBranch,
  } = env.ctx;
  const { worktreePath } = env;
  const { result } = dispatched;
  if (!logWriter) return;
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

  const phaseLog = createPhaseLogFromTiming(
    phase,
    issueNumber,
    dispatched.startTime,
    dispatched.endTime,
    phaseLogStatus(record.success, result),
    {
      error: record.error,
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
      errorContext: buildPhaseErrorContext(result),
      // #1198 AC-1: resolved model (from modelUsage) and the
      // pre-resolution policy value, when a role: policy was
      // configured for this phase.
      model: result.resolvedModel,
      requestedModel: config.phasePolicies?.[phase]?.requestedModel,
    },
  );
  logWriter.logPhase(phaseLog);
}

/**
 * A failed phase: set the halt flags and, when the quality loop may retry,
 * run the /loop fix pass. The caller stops the phase chain either way.
 */
async function handlePhaseFailure(
  env: IssueRunEnv,
  state: IssueRunState,
  iter: IssueRunIteration,
  result: PhaseResult,
  modelTrigger: EscalationTrigger | null,
): Promise<void> {
  iter.phasesFailed = true;
  if (result.capped) {
    state.haltedByCap = true;
  }
  // Billing / rate-limit-window failure (#799): halt the outer quality
  // loop for the same reason as the turn cap — re-running the phase or
  // spawning /loop cannot succeed while credits/window are exhausted, and
  // doing so mislabels the halt as a downstream unparseable-verdict error.
  if (isBillingOrWindowHalt(result)) {
    state.haltedByBilling = true;
  }

  // If quality loop enabled, run loop phase to fix issues.
  // A turn-capped phase (#739) is incomplete, not a genuine quality
  // failure: skip the loop and halt cleanly ("surface + halt"). Spawning
  // /loop on partial output would act on incomplete work — exactly the
  // risk the capped path is meant to avoid. The user resumes instead.
  // A billing / rate-limit-window halt (#799) is skipped for the same
  // reason: /loop would re-spawn into the same closed window.
  // A ladder halt (#995) skips the loop for the third time in this
  // family's history and for the same reason: /loop cannot un-contradict
  // a spec, cannot converge work that keeps failing at a new SHA, and
  // cannot climb a rung that does not exist.
  if (
    iter.useQualityLoop &&
    iter.iteration < iter.maxIterations &&
    !result.capped &&
    !state.haltedByBilling &&
    state.haltedByDivergence === null
  ) {
    await runLoopFixPhase(env, state, iter, result, modelTrigger);
  }
}

/** The /loop fix pass after a failed phase, fed the failed phase's QA context. */
async function runLoopFixPhase(
  env: IssueRunEnv,
  state: IssueRunState,
  iter: IssueRunIteration,
  result: PhaseResult,
  modelTrigger: EscalationTrigger | null,
): Promise<void> {
  const {
    issueNumber,
    config,
    services: { logWriter, shutdownManager },
    onProgress,
    phasePauseHandle,
  } = env.ctx;
  const { iteration } = iter;
  // #624 Item 3 (AC-3.3): the loop phase carries the current outer
  // iteration so the live-zone status cell can show `loop N/M`.
  const loopStartExtra: { iteration: number } = { iteration };
  emitProgressLine(issueNumber, "loop", "start", loopStartExtra);
  try {
    onProgress?.(issueNumber, "loop", "start", loopStartExtra);
  } catch (err) {
    /* progress errors must not halt */
    noteSuppressed("progress", err, "loop start");
  }

  // Build enriched config for loop phase with QA context (#488).
  // Pass verdict, failed ACs, and error directly so the /loop skill
  // doesn't need to reconstruct context from GitHub comments.
  // #937 AC-3: exclude `document`/`pause_for_human`-tagged findings
  // from what the loop is told to fix (same filter as ready-gate's
  // fixableGaps).
  const fixableGaps = selectFixableGaps(result.summary);
  const loopConfig: ExecutionConfig = {
    ...env.issueConfig,
    lastVerdict: result.verdict ?? undefined,
    failedAcs: fixableGaps.length ? fixableGaps.join("; ") : undefined,
    promptContext: buildLoopContext(result),
  };

  // #971 (spec sibling-site scan / OQ-6): this is the FOURTH
  // retry-dispatch site, and the one #915 never reached — it calls
  // `executePhaseWithRetry` without `withEscalatedEffort`. The ladder
  // is applied here too so the new mechanism is not born with the same
  // hole. (Backfilling #915's effort escalation here would change
  // #915's behaviour under a #971 PR, so it is deliberately left to a
  // follow-up.)
  const loopLadder = withEscalatedModel(
    loopConfig,
    "loop",
    modelTrigger,
    state.ladderState,
  );
  if (loopLadder.record) state.modelEscalations.push(loopLadder.record);
  if (loopLadder.record && config.verbose) {
    env.log(
      chalk.gray(
        `    model: ${loopLadder.record.base} → ${loopLadder.record.escalated} (${formatEscalationTriggerLabel(loopLadder.record.trigger)} retry)`,
      ),
    );
  }

  const loopStartTime = new Date();
  const loopResult = await executePhaseWithRetry(
    issueNumber,
    "loop",
    withActivityHook(
      loopLadder.config,
      issueNumber,
      "loop",
      onProgress,
      makeWaitTransition(env, "loop"),
    ),
    state.resumeHandle,
    env.worktreePath,
    shutdownManager,
    phasePauseHandle,
    undefined, // executePhaseFn — use the default
    undefined, // delayFn — use the default
    env.autoWaitLedger, // #804: shared across every phase of this issue
  );
  const loopEndTime = new Date();
  state.phaseResults.push(loopResult);

  // #766: record the loop phase in the run log — spec and the regular
  // phases log via logWriter, but the loop was never logged, so a loop that
  // decided the card's verdict was absent from the log you'd use to debug
  // it (AC-6). Loop status never determines the issue verdict (see
  // deriveIssueLogStatus), but the entry with phase/status/duration/error
  // must exist.
  if (logWriter) {
    const loopPhaseLog = createPhaseLogFromTiming(
      "loop",
      issueNumber,
      loopStartTime,
      loopEndTime,
      phaseLogStatus(loopResult.success, loopResult),
      {
        error: loopResult.error,
        capped: loopResult.capped,
        // #1198 AC-1: resolved model (from modelUsage) and the
        // pre-resolution policy value, when a role: policy was
        // configured for this phase.
        model: loopResult.resolvedModel,
        requestedModel: config.phasePolicies?.["loop"]?.requestedModel,
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
    } catch (err) {
      /* progress errors must not halt */
      noteSuppressed("progress", err, "loop complete");
    }
  } else {
    const extra = { error: loopResult.error ?? "unknown", iteration };
    emitProgressLine(issueNumber, "loop", "failed", extra);
    try {
      onProgress?.(issueNumber, "loop", "failed", extra);
    } catch (err) {
      /* progress errors must not halt */
      noteSuppressed("progress", err, "loop failed");
    }
  }

  if (loopResult.resumeHandle) {
    state.resumeHandle = loopResult.resumeHandle;
  }
}

/**
 * #971: close out an iteration's capability-bound assessment. Compare
 * the worktree against the snapshot taken before the iteration's phases
 * ran, and hand the verdict to the NEXT iteration's dispatches:
 *
 * - nothing produced → `LOOP_NO_DIFF`: the agent could not make a working
 *   change, which is the capability-bound fingerprint → escalate a rung.
 * - a diff was produced but the iteration still failed → divergence-
 *   suspect: a stronger model would rediscover the contradiction more
 *   expensively, so the trigger is cleared and the model stays constant
 *   (AC-3).
 */
function assessIterationProgress(
  env: IssueRunEnv,
  state: IssueRunState,
  iter: IssueRunIteration,
  iterationStartSnapshot: LoopProgressSnapshot,
  iterationEndSnapshot: LoopProgressSnapshot,
): void {
  const decision = detectCapabilityBoundTrigger({
    isRetry: true,
    loopProgress: compareLoopProgress(
      iterationStartSnapshot,
      iterationEndSnapshot,
    ),
  });
  state.lastTrigger = decision.trigger;

  // #995: replay material for the evidence bundle. Recorded on every
  // iteration (not only at a halt) because the bundle's job is to show
  // what was TRIED — a record assembled after the fact could only show
  // the last one.
  state.iterationRecords.push({
    iteration: iter.iteration,
    sha: iterationEndSnapshot.sha,
    ...(iter.lastPhaseVerdict ? { verdict: iter.lastPhaseVerdict } : {}),
  });

  // #995 (#971 AC-3): the divergence-suspect halt. Counted rather than
  // fired on sight — one iteration that produces a diff at a failing
  // verdict is the ordinary quality loop doing its job, and halting there
  // would break every `AC_NOT_MET → /loop → re-QA` cycle in the product,
  // ladder or no ladder. TWO CONSECUTIVE such iterations is the pattern
  // AC-3 names: plausible diffs that keep not converging, where a stronger
  // model would only rediscover the contradiction more expensively.
  //
  // Reachable only with a ladder configured: `iterationStartSnapshot` is
  // null otherwise, so the whole block — and every halt in it — is dead
  // on an unconfigured run (AC-D1).
  if (decision.classification === "divergence-suspect" && iter.phasesFailed) {
    state.consecutiveDivergenceSuspect++;
    if (
      state.consecutiveDivergenceSuspect >= DIVERGENCE_SUSPECT_HALT_THRESHOLD &&
      state.haltedByDivergence === null
    ) {
      state.haltedByDivergence = "DIVERGENCE_SUSPECT";
      state.divergenceBundle = buildBundle(
        env.ctx.issueNumber,
        state,
        "DIVERGENCE_SUSPECT",
        state.phases[state.phases.length - 1],
      );
      env.warn(formatEvidenceBundle(state.divergenceBundle));
    }
  } else {
    // Any other classification breaks the streak: the halt is about a
    // REPEATED pattern, and counting non-adjacent iterations would halt a
    // loop that recovered in between.
    state.consecutiveDivergenceSuspect = 0;
  }
}

/** What `settleIssueStatus` hands to `deliverIssueBranch`. */
interface SettledIssueStatus {
  readyGateResult: ReadyResult | undefined;
  readyGateError: string | undefined;
  checkpointFailed: boolean;
}

/**
 * #1507: after the phases — the opt-in ready gate, the final issue status
 * and the chain checkpoint commit.
 */
async function settleIssueStatus(
  env: IssueRunEnv,
  state: IssueRunState,
  success: boolean,
): Promise<SettledIssueStatus> {
  const {
    issueNumber,
    config,
    services: { stateManager, shutdownManager },
    chain,
    baseBranch,
    onProgress,
    phasePauseHandle,
  } = env.ctx;
  const { worktreePath, branch, log, warn } = env;
  const { phaseResults } = state;
  const chainMode = chain?.enabled;

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
          // #863: `issueConfig`, not `config` — so a docs-labelled issue's gate
          // phases carry the same `issueType` the phases that just ran had.
          config: env.issueConfig,
          shutdownManager,
          phasePauseHandle,
          onProgress,
          log,
          warn,
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
  const qaVerdict = latestPhaseResult(phaseResults, "qa")?.verdict;
  // #1233: a terminal "ready" status asserts qa actually reviewed the work.
  // A successful run that never ran qa (e.g. `--phases spec` or `--phases
  // exec`) stays `in_progress` so a later `sequant run N --phases exec`
  // isn't skipped as already-completed.
  // This reads what ran, so a `--resume` run that skips an already-completed
  // qa also records `in_progress`. That's the conservative side: main used to
  // mark such a run ready without looking at the earlier verdict. A
  // `--phases qa` run restores the terminal status.
  const ranQa = phaseResults.some((p) => p.phase === "qa");
  const finalStatus = readyGateResult
    ? readyGateResult.issueStatus
    : success && ranQa
      ? qaVerdict === "NEEDS_VERIFICATION"
        ? "awaiting_verification"
        : "ready_for_merge"
      : "in_progress";
  if (stateManager) {
    try {
      await stateManager.updateIssueStatus(issueNumber, finalStatus);
    } catch (err) {
      // State tracking errors shouldn't stop execution
      noteSuppressed("state", err, "updateIssueStatus");
    }
  }

  // Create checkpoint commit in chain mode after QA passes.
  // #760: chain resume rebases the next link onto this checkpoint, so a failure
  // here is not silent — warn prominently and record it on the result (AC-4).
  //
  // When qa ran and passed, a completed status was already written above —
  // `ready_for_merge`, or `waiting_for_human_merge` when #817's `--ready-gate`
  // owned the terminal status (#837) — so a re-run reads this link as a
  // completed prefix and does NOT redo it. Its uncommitted work is therefore
  // absent from the branch tip, which `computeChainResumePlan` detects (dirty
  // worktree → fail fast) rather than wrong-basing the next link: the work must
  // be committed, or --force.
  //
  // A run without qa records `in_progress` instead (#1233). That link is not a
  // completed prefix, so a re-run doesn't skip it. The warning below names
  // whichever of the two outcomes applies.
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
      // The consequence depends on the status actually recorded: a completed
      // status is skipped by the next run, a non-terminal one (#1233: a run
      // without qa) is resumed. Name the one that applies (#837).
      const reRunConsequence = isCompletedIssueStatus(finalStatus)
        ? `so a re-run will skip it and refuse to resume the chain here until the ` +
          `work is committed in ${worktreePath} (or re-run with --force to redo the whole chain).`
        : `so a re-run won't skip it (the chain resumes at its first unfinished link); ` +
          `commit the work in ${worktreePath} first so the next link builds on it.`;
      warn(
        `  ⚠️  Checkpoint commit for #${issueNumber} could not be created — its uncommitted ` +
          `changes are NOT on branch ${branch ?? "the feature branch"}. #${issueNumber} stays ` +
          `${finalStatus}, ${reRunConsequence}`,
      );
    }
  }

  return { readyGateResult, readyGateError, checkpointFailed };
}

/**
 * #1520: the PR this run left behind, for the Read-first comment. The
 * post-QA PR when QA passed; the PR opened after exec (#1247) when the run
 * ended at a failing verdict; on a qa-only re-run, the PR the state recorded.
 * The class failure this guards against is a receipt that reaches one path
 * and misses the others (#964, #1247, #1302, #1340).
 */
async function resolveReadFirstPR(
  postQaPr: number | undefined,
  state: IssueRunState,
  stateManager: StateManager | null,
  issueNumber: number,
  provider: PlatformProvider,
): Promise<number | undefined> {
  if (postQaPr) return postQaPr;
  if (state.earlyPr) return state.earlyPr.number;
  if (!stateManager) return undefined;
  try {
    const recorded = (await stateManager.getIssueState(issueNumber))?.pr
      ?.number;
    if (!recorded) return undefined;
    // The record may name a PR from an earlier attempt that was closed or
    // merged since; a comment about this diff does not belong on it.
    const status = await provider.getPRStatus(String(recorded));
    return status.state === "open" ? recorded : undefined;
  } catch (err) {
    noteSuppressed("state", err, "batch-executor:resolveReadFirstPR");
    return undefined;
  }
}

/**
 * #1520: the "Read first" comment, once per PR, after the last QA iteration,
 * whatever its verdict. Dedup reads the PR, so a later run posts nothing.
 * A run that ran no qa posts nothing: the comment points at the QA verdict.
 */
async function postReadFirstForPR(
  env: IssueRunEnv,
  state: IssueRunState,
  worktreePath: string,
  postQaPr: number | undefined,
): Promise<void> {
  const { issueNumber, chain, baseBranch, services } = env.ctx;
  if (!state.phaseResults.some((p) => p.phase === "qa")) return;
  const provider = env.ctx.readFirstProvider ?? new GitHubProvider();
  const prNumber = await resolveReadFirstPR(
    postQaPr,
    state,
    services.stateManager,
    issueNumber,
    provider,
  );
  if (!prNumber) return;
  const mutationMarkers = [
    ...receiptMarkers(env, worktreePath),
    ...state.phaseResults
      .filter((p) => p.phase === "exec" && p.output)
      .flatMap((p) => parseMutationMarkersFromExecOutput(p.output ?? "")),
  ];
  await deliverReadFirstComment({
    provider,
    worktreePath,
    baseBranch: chain?.predecessorBranch ?? baseBranch ?? "main",
    prNumber,
    issueNumber,
    mutationMarkers,
    warn: env.warn,
  });
}

/**
 * #1507: the run's delivery — rebase, the post-QA PR, relay deactivation —
 * and the issue's `IssueResult`.
 */
async function deliverIssueBranch(
  env: IssueRunEnv,
  state: IssueRunState,
  success: boolean,
  durationSeconds: number,
  settled: SettledIssueStatus,
): Promise<IssueResult> {
  const {
    issueNumber,
    config,
    options,
    services: { stateManager },
    chain,
    packageManager,
    baseBranch,
  } = env.ctx;
  const { worktreePath, branch, log, relayActivation } = env;
  const { phaseResults, divergenceBundle } = state;
  const { readyGateResult, readyGateError, checkpointFailed } = settled;
  const chainMode = chain?.enabled;
  const isLastInChain = chain?.isLast;

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
  const wouldCreatePR = success && worktreePath && branch && !options.noPr;
  // #920: a phase-restricted run (e.g. `--phases spec`) provisions a worktree
  // and branch unconditionally of which phases ran, so a clean spec-only pass
  // satisfies every conjunct above with zero commits — `gh pr create` then
  // fails with "No commits between main and …" and the run reports failed
  // for work that landed exactly where it was supposed to (the plan comment).
  // Gate on the evidence (commits ahead of base) rather than the phase list:
  // `hasExecChanges` fails open (`unknown` counts as "has changes") so a git
  // error here falls through to today's attempt-PR behavior, and it resolves
  // the base the same #537-aware way `classifyExecChanges` already does for
  // the exec zero-diff guard.
  let prSkippedReason: string | undefined;
  if (wouldCreatePR && !hasExecChanges(worktreePath)) {
    prSkippedReason = `no commits ahead of ${baseBranch ?? "main"} (no implementing phase ran)`;
    log(chalk.gray(`    ℹ️  PR skipped — ${prSkippedReason}`));
  }
  const shouldCreatePR = wouldCreatePR && !prSkippedReason;
  if (shouldCreatePR) {
    // #749: surface a non-A+ qa verdict (e.g. AC_MET_BUT_NOT_A_PLUS) in the PR
    // body so a reviewer sees why the run broke to PR rather than reaching A+.
    const qaVerdict = latestPhaseResult(phaseResults, "qa")?.verdict;
    const prResult = await openOrUpdatePR(env, state, worktreePath, branch, {
      qaVerdict,
      // #817 AC-6: surface the ready-gate outcome in the PR body the same way
      // `sequant ready` reports it (threshold reached vs guard halt).
      readyGateReport: readyGateResult?.report,
      // #1249 AC-2: the latest QA pass's findings become the PR's
      // `## Follow-ups` checklist.
      followups: latestPhaseResult(phaseResults, "qa")?.summary?.findings,
    });
    if (prResult.success && prResult.prNumber && prResult.prUrl) {
      prNumber = prResult.prNumber;
      prUrl = prResult.prUrl;
    } else if (prResult.attempted && !prResult.success) {
      // #879: PR creation was attempted (branch/QA passed) but failed. This is
      // a run failure — the deliverable never reached GitHub.
      prCreationError = prResult.error ?? "PR creation failed";
    }
  }
  // #1520: on every verdict, not only the success path above.
  if (worktreePath && !options.noPr) {
    await postReadFirstForPR(env, state, worktreePath, prNumber);
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
        env.warn(`    !  Relay deactivation failed: ${err}`);
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
    loopTriggered: state.loopTriggered,
    prNumber,
    prUrl,
    prCreationError,
    prSkippedReason,
    checkpointFailed,
    failureCategory: overallSuccess
      ? undefined
      : // #920: a PR-creation failure has no failed phase for
        // `deriveFailureCategory` to classify — fall back to the dedicated
        // category so the metrics residual from #879 (empty failureCategory
        // on a PR-only failure) doesn't reopen for this failure path.
        (deriveFailureCategory(phaseResults) ??
        (prCreationError ? "pr_creation" : undefined)),
    // #1254: a ladder halt overrides the phase-derived category with
    // `ladder_halt` and carries its reason and evidence bundle.
    ...(divergenceBundle && !overallSuccess
      ? ladderHaltOutcome(divergenceBundle)
      : {}),
    // #817: present only when `--ready-gate` ran the gate; the summary renders
    // its terminal reason (AC-6).
    readyGate: readyGateResult,
    readyGateError,
  };
}

export async function runIssueWithLogging(
  ctx: IssueExecutionContext,
): Promise<IssueResult> {
  const init = await initIssueRun(ctx);
  if ("aborted" in init) return init.aborted;
  const { env } = init;
  const { config, options, labels } = ctx;
  const state = createIssueRunState();

  // Determine phases for this specific issue
  if (options.autoDetectPhases) {
    const halted = await runSpecStage(env, state);
    if (halted) return halted;
  } else {
    // Use explicit phases with adjustments
    state.phases = determinePhasesForIssue(config.phases, labels, options);
    if (state.phases.length !== config.phases.length) {
      env.log(chalk.gray(`    Phases adjusted: ${state.phases.join(" → ")}`));
    }
  }
  finalizePhasePlan(env, state);

  const completedSuccessfully = await runQualityLoop(env, state);

  const durationSeconds = (Date.now() - env.startTime) / 1000;
  // Success is determined by whether all phases completed in any iteration,
  // not whether all accumulated phase results passed (which would fail after loop recovery)
  const success = completedSuccessfully;
  const settled = await settleIssueStatus(env, state, success);
  return deliverIssueBranch(env, state, success, durationSeconds, settled);
}
