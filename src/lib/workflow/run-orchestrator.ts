/**
 * RunOrchestrator — CLI-free execution engine for sequant workflows.
 *
 * Owns the full lifecycle: config → issue discovery → dispatch → results.
 * Importable and usable without Commander.js or CLI context.
 *
 * @module
 */

import chalk from "chalk";
import { spawnSync } from "child_process";
import pLimit from "p-limit";
import type {
  ExecutionConfig,
  IssueResult,
  RunOptions,
  BatchExecutionContext,
  IssueExecutionContext,
  ProgressCallback,
  PhasePlanCallback,
  PhasePauseHandle,
} from "./types.js";
import type {
  IssueRuntimeState,
  PhaseRuntimeState,
  RunSnapshot,
  RunSnapshotConfig,
} from "./run-state.js";
import { formatCoarseNowLine } from "./run-state.js";
import type { WorktreeInfo } from "./worktree-manager.js";
import {
  detectDefaultBranch,
  ensureWorktrees,
  ensureWorktreesChain,
  getWorktreeDiffStats,
  rebaseOntoLocalBranch,
} from "./worktree-manager.js";
import { LogWriter } from "./log-writer.js";
import type { RunConfig } from "./run-log-schema.js";
import { StateManager } from "./state-manager.js";
import { ShutdownManager } from "../shutdown.js";
import { LockManager, formatLockedMessage } from "../locks/index.js";
import type { LockFile, SignalOtherResult } from "../locks/index.js";
import { bracketedConsoleLog } from "./notice.js";

/** Human-readable line for the run-orchestrator's `--signal-other` log (#637). */
function formatSignalLine(
  issue: number,
  pid: number,
  result: SignalOtherResult,
): string {
  switch (result.reason) {
    case "sent":
      return `  Signaled PID ${pid} (SIGTERM) for #${issue}`;
    case "cross-host":
      return `  Could not signal PID ${pid} for #${issue} (cross-host holder)`;
    case "self-or-parent":
      return `  Refused to signal PID ${pid} for #${issue} (matches this process or its parent)`;
    case "pid-dead":
      return `  Could not signal PID ${pid} for #${issue} (already exited)`;
    case "kill-failed":
      return `  Could not signal PID ${pid} for #${issue} (kill syscall failed)`;
    case "orchestrator":
      return `  Skipped signal for #${issue} (orchestrator mode)`;
  }
}

/**
 * Resolve a git ref (branch name or base branch) to its tip commit SHA in the
 * current repo, or undefined if the ref does not exist. Used by the chain
 * resume planner (#760) to reconstruct — and validate the existence of — a
 * completed link's committed tip.
 */
function revParseRef(ref: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], {
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    return undefined;
  }
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : undefined;
}

/**
 * True iff `worktreePath` has uncommitted changes (`git status --porcelain`,
 * which already honours .gitignore). Used by the chain resume planner (#760) to
 * reject a resume base whose checkpoint commit never landed.
 *
 * Returns false when the path is missing or not a worktree: an unreadable
 * worktree can't be judged dirty, and the branch-tip check already covers the
 * destroyed-link case.
 */
function isWorktreeDirty(worktreePath: string): boolean {
  const result = spawnSync(
    "git",
    ["-C", worktreePath, "status", "--porcelain"],
    {
      stdio: "pipe",
      encoding: "utf-8",
    },
  );
  if (result.status !== 0) {
    return false;
  }
  return result.stdout.trim().length > 0;
}
import {
  getIssueInfo,
  sortByDependencies,
  parseBatches,
  runIssueWithLogging,
  emitRunIdLine,
} from "./batch-executor.js";
import { reconcileStateAtStartup } from "./state-utils.js";
import { getCommitHash } from "./git-diff-utils.js";
import {
  planChainResumeFromState,
  type ChainResumePlan,
  type CompletedLinkResolver,
} from "./chain-resume.js";
import { MetricsWriter } from "./metrics-writer.js";
import { WorkflowEventEmitter } from "./event-emitter.js";
import type { IssueEventStatus } from "./event-emitter.js";
import { type MetricPhase, determineOutcome } from "./metrics-schema.js";
import { getTokenUsageForRun } from "./token-utils.js";
import type { SequantSettings } from "../settings.js";
import { resolveRunOptions, buildExecutionConfig } from "./config-resolver.js";

/**
 * Build the stack-manifest line emitted into PR bodies under --stacked.
 *
 * Example for issues `[100, 101, 102]` at `currentIndex=1`:
 *   `Part of stack: #100 → #101 (this) → #102`
 *
 * @internal Exported for testing.
 */
export function buildStackManifest(
  issueNumbers: number[],
  currentIndex: number,
): string {
  const parts = issueNumbers.map((n, i) =>
    i === currentIndex ? `#${n} (this)` : `#${n}`,
  );
  return `Part of stack: ${parts.join(" → ")}`;
}

// ── Public types ────────────────────────────────────────────────────────────

/**
 * Injectable services for RunOrchestrator.
 * All optional — orchestrator degrades gracefully when services are absent.
 */
export interface OrchestratorServices {
  logWriter?: LogWriter | null;
  stateManager?: StateManager | null;
  shutdownManager?: ShutdownManager;
}

/**
 * CLI-free configuration for RunOrchestrator.
 * No Commander.js types leak into this interface.
 */
export interface OrchestratorConfig {
  /** Execution settings (phases, timeouts, mode flags) */
  config: ExecutionConfig;
  /** Merged run options (post-resolution, no raw CLI types) */
  options: RunOptions;
  /** Issue metadata keyed by issue number */
  issueInfoMap: Map<number, { title: string; labels: string[] }>;
  /** Worktree paths keyed by issue number */
  worktreeMap: Map<number, WorktreeInfo>;
  /** Injectable services */
  services: OrchestratorServices;
  /** Package manager name (e.g. "npm", "pnpm") */
  packageManager?: string;
  /** Base branch for rebase/PR targets */
  baseBranch?: string;
  /**
   * Chain resume plan (#760). Present only when re-running a `--chain` batch
   * whose completed prefix is being skipped. Drives the first active link's
   * rebase onto the last completed link's committed tip in `executeSequential`.
   */
  chainResume?: ChainResumePlan;
  /** Per-phase progress callback (parallel mode) */
  onProgress?: ProgressCallback;
  /** #672 AC-2: phase-plan callback forwarded into per-issue contexts. */
  onPhasePlan?: PhasePlanCallback;
  /**
   * Optional live-zone pause handle (#656). Forwarded to every issue's
   * batch context so `executePhaseWithRetry` can quiesce the renderer
   * around verbose Claude streaming.
   */
  phasePauseHandle?: PhasePauseHandle;
}

/**
 * High-level init config for full lifecycle execution.
 * Used by RunOrchestrator.run() — the entry point for programmatic callers.
 */
export interface RunInit {
  /** Raw CLI options (pre-merge) */
  options: RunOptions;
  /** Resolved settings */
  settings: SequantSettings;
  /** Manifest metadata */
  manifest: { stack: string; packageManager: string };
  /** Explicit base branch override */
  baseBranch?: string;
  /** Per-phase progress callback */
  onProgress?: ProgressCallback;
  /** #672 AC-2: phase-plan callback. Fired once per issue once the executor
   * has resolved the final phase pipeline. */
  onPhasePlan?: PhasePlanCallback;
  /**
   * Optional live-zone pause handle (#656). Threaded through to the
   * `OrchestratorConfig` so verbose Claude streaming pauses the renderer's
   * live zone instead of redrawing over it.
   */
  phasePauseHandle?: PhasePauseHandle;
  /**
   * Invoked once the orchestrator is constructed but before execution begins.
   * Used by the experimental TUI to attach a snapshot poller to the active
   * orchestrator instance created inside `run()`.
   */
  onOrchestratorReady?: (orchestrator: RunOrchestrator) => void;
}

/**
 * Pure result of config resolution — no side effects, no services.
 * Produced by `RunOrchestrator.resolveConfig()` and consumed by both
 * `run()` (internally) and the CLI (for pre-run display).
 */
export interface ResolvedRun {
  /** Post-merge run options (defaults < settings < env < explicit) */
  mergedOptions: RunOptions;
  /** Execution config derived from mergedOptions */
  config: ExecutionConfig;
  /** Parsed + dep-sorted issue numbers (pre-state-guard) */
  issueNumbers: number[];
  /** Resolved batches if --batch specified, else null */
  batches: number[][] | null;
  /** Resolved base branch (CLI → settings → auto-detect → "main") */
  baseBranch: string;
  /** Stack from manifest */
  stack: string;
  /** True when phases will be auto-detected from issue labels */
  autoDetectPhases: boolean;
  /** True when worktree isolation is enabled */
  worktreeIsolationEnabled: boolean;
  /** True when JSON logging will be initialized */
  logEnabled: boolean;
  /** True when state tracking will be enabled */
  stateEnabled: boolean;
}

/**
 * Structured result of a full orchestrator run.
 */
export interface RunResult {
  /** Per-issue results */
  results: IssueResult[];
  /** Log file path (if logging enabled) */
  logPath: string | null;
  /** Non-zero if any issue failed */
  exitCode: number;
  /** Worktree map (for summary display) */
  worktreeMap: Map<number, WorktreeInfo>;
  /** Issue info map (for summary display) */
  issueInfoMap: Map<number, { title: string; labels: string[] }>;
  /** Resolved execution config */
  config: ExecutionConfig;
  /** Resolved merged options */
  mergedOptions: RunOptions;
  /** Log writer (for reflection access) */
  logWriter: LogWriter | null;
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * CLI-free workflow execution engine.
 *
 * Two usage modes:
 * 1. Full lifecycle: `RunOrchestrator.run(init, issueNumbers)` — handles
 *    services, worktrees, state guard, execution, and metrics.
 * 2. Low-level: `new RunOrchestrator(config).execute(issueNumbers)` — caller
 *    manages setup/teardown.
 */
export class RunOrchestrator {
  private readonly cfg: OrchestratorConfig;
  private readonly issueStates = new Map<number, IssueRuntimeState>();
  private readonly phaseStartTimes = new Map<string, number>();
  private readonly emitter: WorkflowEventEmitter;
  private done = false;

  constructor(config: OrchestratorConfig) {
    this.validate(config);
    // Build the event emitter before wrapProgress so the wrapper can route
    // status transitions through `issue_status_changed` events (AC-3).
    this.emitter = new WorkflowEventEmitter({
      onListenerError: (event, error) => {
        // Mirror the orchestrator's verbose-gated non-fatal warning style.
        // Listener failures must never propagate to the run.
        logNonFatalWarning(
          `  !  Event listener for "${event}" threw, ignoring`,
          error,
          config.config?.verbose ?? false,
        );
      },
    });
    this.cfg = { ...config, onProgress: this.wrapProgress(config.onProgress) };
    this.initIssueStates();
  }

  /**
   * Returns the workflow event emitter. External consumers (TUI, MCP server,
   * future webhooks) call `getEmitter().on(...)` to subscribe to lifecycle
   * events. Subscribing is opt-in — the orchestrator runs unaware of who is
   * listening (#504, AC-3).
   */
  getEmitter(): WorkflowEventEmitter {
    return this.emitter;
  }

  /**
   * Point-in-time view of the entire run.
   *
   * Safe under concurrent reads: the returned object contains only freshly
   * allocated arrays and plain records; no internal Map or mutable state
   * reference is leaked. Callers may hold snapshots across awaits without
   * observing torn writes.
   */
  getSnapshot(): RunSnapshot {
    const { config } = this.cfg;
    const snapshotConfig: RunSnapshotConfig = {
      concurrency: config.concurrency,
      baseBranch: this.cfg.baseBranch ?? "main",
      qualityLoop: config.qualityLoop,
    };
    const issues: IssueRuntimeState[] = [];
    for (const state of this.issueStates.values()) {
      issues.push(cloneIssueState(state));
    }
    return {
      config: snapshotConfig,
      issues,
      done: this.done,
      capturedAt: new Date(),
    };
  }

  /**
   * Mark the run as completed so the dashboard can unmount and drop event
   * subscribers. Drains the emitter to prevent leaks across multiple
   * `run()` invocations in the same process (e.g. the MCP server).
   */
  markDone(): void {
    this.done = true;
    this.emitter.removeAllListeners();
  }

  private initIssueStates(): void {
    const { issueInfoMap, worktreeMap, config } = this.cfg;
    for (const [num, info] of issueInfoMap.entries()) {
      const branch = worktreeMap.get(num)?.branch ?? `#${num}`;
      const phases: PhaseRuntimeState[] = config.phases.map((name) => ({
        name,
        status: "pending",
      }));
      this.issueStates.set(num, {
        number: num,
        title: info.title,
        branch,
        status: "queued",
        phases,
      });
    }
  }

  private wrapProgress(external?: ProgressCallback): ProgressCallback {
    return (issue, phase, event, extra) => {
      this.applyProgressEvent(issue, phase, event, extra);
      external?.(issue, phase, event, extra);
    };
  }

  private applyProgressEvent(
    issue: number,
    phase: string,
    event: "start" | "complete" | "failed" | "activity",
    extra?: {
      durationSeconds?: number;
      error?: string;
      text?: string;
      iteration?: number;
    },
  ): void {
    const state = this.issueStates.get(issue);
    if (!state) return;

    if (event === "start") {
      const wasStatus: IssueEventStatus = state.status;
      if (!state.startedAt) state.startedAt = new Date();
      state.status = "running";
      const now = new Date();
      this.phaseStartTimes.set(`${issue}:${phase}`, now.getTime());
      state.currentPhase = {
        name: phase,
        startedAt: now,
        lastActivityAt: now,
        nowLine: formatCoarseNowLine(phase),
      };
      const p = findOrAppendPhase(state, phase);
      p.status = "running";
      p.startedAt = now;
      // Fire-and-forget — listener safety guaranteed by the emitter (AC-5).
      void this.emitter.emit("phase_started", {
        issueNumber: issue,
        phase,
        iteration: extra?.iteration,
      });
      if (wasStatus !== "running") {
        void this.emitter.emit("issue_status_changed", {
          issueNumber: issue,
          from: wasStatus,
          to: "running",
        });
      }
      return;
    }

    if (event === "activity") {
      // Ignore activity for stale phases (race between completion and a
      // final flushed output chunk).
      if (!state.currentPhase || state.currentPhase.name !== phase) return;
      const line = extractActivityLine(extra?.text);
      if (!line) return;
      state.currentPhase.nowLine = line;
      state.currentPhase.lastActivityAt = new Date();
      void this.emitter.emit("progress", {
        issueNumber: issue,
        phase,
        text: line,
      });
      return;
    }

    // complete / failed
    const key = `${issue}:${phase}`;
    const startMs = this.phaseStartTimes.get(key);
    this.phaseStartTimes.delete(key);
    const elapsedMs =
      extra?.durationSeconds != null
        ? extra.durationSeconds * 1000
        : startMs != null
          ? Date.now() - startMs
          : undefined;
    const p = findOrAppendPhase(state, phase);
    p.status = event === "complete" ? "done" : "failed";
    p.elapsedMs = elapsedMs;
    state.currentPhase = undefined;
    const durationSec =
      elapsedMs !== undefined ? Math.round(elapsedMs / 1000) : undefined;

    if (event === "failed") {
      const prev: IssueEventStatus = state.status;
      state.status = "failed";
      state.completedAt = new Date();
      void this.emitter.emit("phase_failed", {
        issueNumber: issue,
        phase,
        duration: durationSec,
        error: extra?.error ?? "unknown",
        iteration: extra?.iteration,
      });
      if (prev !== "failed") {
        void this.emitter.emit("issue_status_changed", {
          issueNumber: issue,
          from: prev,
          to: "failed",
        });
      }
      return;
    }

    void this.emitter.emit("phase_completed", {
      issueNumber: issue,
      phase,
      duration: durationSec ?? 0,
      iteration: extra?.iteration,
    });

    // Completed phase: if it's the last phase in the plan, mark issue passed.
    const allDone = state.phases.every(
      (ph) => ph.status === "done" || ph.status === "failed",
    );
    if (allDone) {
      const prev: IssueEventStatus = state.status;
      state.status = state.phases.some((ph) => ph.status === "failed")
        ? "failed"
        : "passed";
      state.completedAt = new Date();
      if (prev !== state.status) {
        void this.emitter.emit("issue_status_changed", {
          issueNumber: issue,
          from: prev,
          to: state.status,
        });
      }
    }
  }

  /**
   * Pure config resolution — no side effects.
   *
   * Produces a `ResolvedRun` containing merged options, execution config,
   * parsed/sorted issue numbers, base branch, and display-only flags. Safe
   * to call for preview purposes (e.g. CLI config display before run).
   *
   * `run()` uses this internally to avoid duplicating resolution logic.
   */
  static resolveConfig(
    init: RunInit,
    issueArgs: string[],
    batches?: number[][] | null,
  ): ResolvedRun {
    const { options, settings, manifest } = init;

    const mergedOptions = resolveRunOptions(options, settings);
    const baseBranch =
      init.baseBranch ??
      options.base ??
      settings.run.defaultBase ??
      detectDefaultBranch(mergedOptions.verbose ?? false);

    let issueNumbers: number[];
    let resolvedBatches: number[][] | null = batches ?? null;

    if (
      mergedOptions.batch &&
      mergedOptions.batch.length > 0 &&
      !resolvedBatches
    ) {
      resolvedBatches = parseBatches(mergedOptions.batch);
      issueNumbers = resolvedBatches.flat();
    } else if (resolvedBatches) {
      issueNumbers = resolvedBatches.flat();
    } else {
      issueNumbers = issueArgs
        .map((i) => parseInt(i, 10))
        .filter((n) => !isNaN(n));
    }

    if (issueNumbers.length > 1 && !resolvedBatches) {
      issueNumbers = sortByDependencies(issueNumbers);
    }

    const config = buildExecutionConfig(
      mergedOptions,
      settings,
      issueNumbers.length,
    );

    const logEnabled =
      !mergedOptions.noLog &&
      !config.dryRun &&
      (mergedOptions.logJson ?? settings.run.logJson ?? false);

    return {
      mergedOptions,
      config,
      issueNumbers,
      batches: resolvedBatches,
      baseBranch,
      stack: manifest.stack,
      autoDetectPhases: mergedOptions.autoDetectPhases ?? false,
      worktreeIsolationEnabled:
        mergedOptions.worktreeIsolation !== false && issueNumbers.length > 0,
      logEnabled,
      stateEnabled: !config.dryRun,
    };
  }

  /**
   * Full lifecycle execution — the primary entry point for programmatic use.
   *
   * Handles: config resolution → services setup → state guard →
   * issue discovery → worktree creation → execution → metrics → cleanup.
   */
  static async run(
    init: RunInit,
    issueArgs: string[],
    batches?: number[][] | null,
  ): Promise<RunResult> {
    const { manifest, onProgress, phasePauseHandle, settings } = init;

    // ── Config resolution ──────────────────────────────────────────────
    const resolved = RunOrchestrator.resolveConfig(init, issueArgs, batches);
    const { mergedOptions, config, baseBranch } = resolved;
    let { issueNumbers } = resolved;
    const resolvedBatches = resolved.batches;

    if (issueNumbers.length === 0) {
      return {
        results: [],
        logPath: null,
        exitCode: 0,
        worktreeMap: new Map(),
        issueInfoMap: new Map(),
        config,
        mergedOptions,
        logWriter: null,
      };
    }

    // ── Services setup ─────────────────────────────────────────────────
    let logWriter: LogWriter | null = null;
    const shouldLog =
      !mergedOptions.noLog &&
      !config.dryRun &&
      (mergedOptions.logJson ?? settings.run.logJson);

    if (shouldLog) {
      const runConfig: RunConfig = {
        phases: config.phases,
        sequential: config.sequential,
        qualityLoop: config.qualityLoop,
        maxIterations: config.maxIterations,
        chain: mergedOptions.chain,
        qaGate: mergedOptions.qaGate,
      };
      try {
        logWriter = new LogWriter({
          logPath: mergedOptions.logPath ?? settings.run.logPath,
          verbose: config.verbose,
          startCommit: getCommitHash(process.cwd()),
        });
        await logWriter.initialize(runConfig);
        const runId = logWriter.getRunId();
        if (runId) emitRunIdLine(runId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(
          chalk.yellow(
            `  ! Log initialization failed, continuing without logging: ${msg}`,
          ),
        );
        logWriter = null;
      }
    }

    let stateManager: StateManager | null = null;
    if (!config.dryRun) {
      stateManager = new StateManager({ verbose: config.verbose });
    }

    const shutdown = new ShutdownManager();
    if (logWriter) {
      const writer = logWriter;
      shutdown.registerCleanup("Finalize run logs", async () => {
        await writer.finalize();
      });
    }

    // ── Pre-flight state guard ─────────────────────────────────────────
    if (stateManager && !config.dryRun) {
      try {
        const reconcileResult = await reconcileStateAtStartup({
          verbose: config.verbose,
        });
        if (reconcileResult.success && reconcileResult.advanced.length > 0) {
          console.log(
            chalk.gray(
              `  State reconciled: ${reconcileResult.advanced.map((n) => `#${n}`).join(", ")} → merged`,
            ),
          );
        }
      } catch (error) {
        logNonFatalWarning(
          "  !  State reconciliation failed, continuing...",
          error,
          config.verbose,
        );
      }
    }

    let chainResume: ChainResumePlan | undefined;
    if (stateManager && !config.dryRun && !mergedOptions.force) {
      if (mergedOptions.chain) {
        // ── Chain-aware resume (#760) ──────────────────────────────────
        // Don't just drop completed links (chain-unaware skip leaves the
        // first incomplete link at index 0, where the #748 successor-rebase
        // never fires → it silently builds on main). Instead compute a
        // chain-correct plan that resumes at the first incomplete link,
        // rebased onto the completed prefix's committed tip.
        const resolver: CompletedLinkResolver = {
          resolveBranchTip: (branch) => revParseRef(branch),
          resolveBaseTip: () => revParseRef(baseBranch),
          isWorktreeDirty,
        };
        const plan = await planChainResumeFromState(
          issueNumbers,
          baseBranch,
          (issueNumber) => stateManager.getIssueState(issueNumber),
          resolver,
          (issueNumber, error) =>
            logNonFatalWarning(
              `  !  State lookup failed for #${issueNumber}, treating as incomplete...`,
              error,
              config.verbose,
            ),
        );

        if (plan.failFast) {
          console.log(
            chalk.red(`\n  ❌ Chain resume aborted: ${plan.failFast}`),
          );
          shutdown.dispose();
          return {
            results: [
              {
                issueNumber: plan.resumeIssue ?? issueNumbers[0],
                success: false,
                phaseResults: [],
                durationSeconds: 0,
                loopTriggered: false,
                abortReason: `chain resume aborted: ${plan.failFast}`,
              },
            ],
            logPath: null,
            exitCode: 1,
            worktreeMap: new Map(),
            issueInfoMap: new Map(),
            config,
            mergedOptions,
            logWriter: null,
          };
        }

        if (plan.allComplete) {
          console.log(
            chalk.yellow(
              `\n  All chain links already completed. Use --force to re-run.`,
            ),
          );
          shutdown.dispose();
          return {
            results: [],
            logPath: null,
            exitCode: 0,
            worktreeMap: new Map(),
            issueInfoMap: new Map(),
            config,
            mergedOptions,
            logWriter: null,
          };
        }

        if (plan.skipped.length > 0) {
          chainResume = plan;
          issueNumbers = plan.active;
          const resumeAt = plan.resumeBaseCommit
            ? plan.resumeBaseCommit.slice(0, 8)
            : (plan.resumeBase ?? "base");
          for (const s of plan.skipped) {
            console.log(
              chalk.yellow(
                `  !  #${s.issueNumber}: already ${s.status} — skipping (use --force to re-run)`,
              ),
            );
          }
          console.log(
            chalk.cyan(
              `  ↻ Resuming chain at #${plan.resumeIssue} from ${resumeAt}` +
                ` (${plan.resumeBase})`,
            ),
          );
        }
      } else {
        // ── Non-chain skip guard (unchanged) ───────────────────────────
        const activeIssues: number[] = [];
        for (const issueNumber of issueNumbers) {
          try {
            const issueState = await stateManager.getIssueState(issueNumber);
            if (
              issueState &&
              (issueState.status === "ready_for_merge" ||
                issueState.status === "merged")
            ) {
              console.log(
                chalk.yellow(
                  `  !  #${issueNumber}: already ${issueState.status} — skipping (use --force to re-run)`,
                ),
              );
            } else {
              activeIssues.push(issueNumber);
            }
          } catch (error) {
            logNonFatalWarning(
              `  !  State lookup failed for #${issueNumber}, including anyway...`,
              error,
              config.verbose,
            );
            activeIssues.push(issueNumber);
          }
        }
        if (activeIssues.length < issueNumbers.length) {
          issueNumbers = activeIssues;
          if (issueNumbers.length === 0) {
            console.log(
              chalk.yellow(
                `\n  All issues already completed. Use --force to re-run.`,
              ),
            );
            shutdown.dispose();
            return {
              results: [],
              logPath: null,
              exitCode: 0,
              worktreeMap: new Map(),
              issueInfoMap: new Map(),
              config,
              mergedOptions,
              logWriter: null,
            };
          }
        }
      }
    }

    // ── Concurrency lock (#625) ────────────────────────────────────────
    // Acquired here — after the state guard, before worktree creation — so
    // that issues already filtered as ready_for_merge don't claim locks they
    // wouldn't release. Locked issues are skipped from the run with a
    // synthetic IssueResult so the batch continues.
    const lockManager = new LockManager();
    const lockedResults: IssueResult[] = [];
    if (!lockManager.isNoop && !config.dryRun) {
      const commandLabel = `npx sequant run ${issueNumbers.join(" ")}`;
      const claimed: number[] = [];
      for (const issueNumber of issueNumbers) {
        const claim = mergedOptions.force
          ? (() => {
              const { previous } = lockManager.forceAcquire(
                issueNumber,
                commandLabel,
              );
              if (previous && mergedOptions.signalOther) {
                const result = lockManager.signalOther(previous);
                console.log(
                  chalk.gray(
                    formatSignalLine(issueNumber, previous.pid, result),
                  ),
                );
              }
              return { acquired: true as const };
            })()
          : lockManager.acquire(issueNumber, commandLabel);
        if (claim.acquired) {
          claimed.push(issueNumber);
        } else {
          lockedResults.push(buildLockedResult(issueNumber, claim.holder));
          console.log(
            chalk.yellow(
              `  !  ${formatLockedMessage(issueNumber, claim.holder)}`,
            ),
          );
        }
      }
      issueNumbers = claimed;
      if (claimed.length > 0) {
        shutdown.registerCleanup("Release issue locks", async () => {
          lockManager.releaseAll();
        });
        // Sync cleanup for SIGKILL / uncaughtException paths. process.on('exit')
        // only fires sync handlers; this is the best-effort safety net for
        // events ShutdownManager doesn't catch.
        const exitHandler = (): void => lockManager.releaseAll();
        process.on("exit", exitHandler);
        shutdown.registerCleanup("Detach exit-handler", async () => {
          process.off("exit", exitHandler);
        });
      }
      if (issueNumbers.length === 0) {
        shutdown.dispose();
        return {
          results: lockedResults,
          logPath: null,
          exitCode: lockedResults.length > 0 ? 1 : 0,
          worktreeMap: new Map(),
          issueInfoMap: new Map(),
          config,
          mergedOptions,
          logWriter: null,
        };
      }
    }

    // ── Issue info + worktree setup ────────────────────────────────────
    const issueInfoMap = new Map<number, { title: string; labels: string[] }>();
    for (const issueNumber of issueNumbers) {
      issueInfoMap.set(issueNumber, await getIssueInfo(issueNumber));
    }

    const useWorktreeIsolation =
      mergedOptions.worktreeIsolation !== false && issueNumbers.length > 0;

    let worktreeMap: Map<number, WorktreeInfo> = new Map();
    if (useWorktreeIsolation && !config.dryRun) {
      const issueData = issueNumbers.map((num) => ({
        number: num,
        title: issueInfoMap.get(num)?.title || `Issue #${num}`,
      }));
      if (mergedOptions.chain) {
        // On resume (#760), provision the first incomplete link from the
        // completed prefix's committed tip (resumeBase) instead of the base
        // branch, so the chain rebuilds onto the work already done.
        const chainBase = chainResume?.resumeBase ?? baseBranch;
        worktreeMap = await ensureWorktreesChain(
          issueData,
          config.verbose,
          manifest.packageManager,
          chainBase,
        );
      } else {
        worktreeMap = await ensureWorktrees(
          issueData,
          config.verbose,
          manifest.packageManager,
          baseBranch,
        );
      }
      for (const [issueNum, worktree] of worktreeMap.entries()) {
        if (!worktree.existed) {
          shutdown.registerCleanup(
            `Cleanup worktree for #${issueNum}`,
            async () => {
              spawnSync(
                "git",
                ["worktree", "remove", "--force", worktree.path],
                {
                  stdio: "pipe",
                },
              );
            },
          );
        }
      }
    }

    // ── Execute ────────────────────────────────────────────────────────
    let results: IssueResult[] = [];

    const orchestrator = new RunOrchestrator({
      config,
      options: mergedOptions,
      issueInfoMap,
      worktreeMap,
      services: { logWriter, stateManager, shutdownManager: shutdown },
      packageManager: manifest.packageManager,
      baseBranch,
      chainResume,
      onProgress,
      onPhasePlan: init.onPhasePlan,
      phasePauseHandle,
    });
    init.onOrchestratorReady?.(orchestrator);

    try {
      if (resolvedBatches) {
        for (let batchIdx = 0; batchIdx < resolvedBatches.length; batchIdx++) {
          const batch = resolvedBatches[batchIdx];
          // #647 AC-3: between-batches in a multi-batch run, the renderer is
          // still alive and may have a populated live zone from the previous
          // batch. Route through `bracketedConsoleLog` so log-update's cursor
          // model stays consistent.
          bracketedConsoleLog(
            phasePauseHandle,
            chalk.blue(
              `\n  Batch ${batchIdx + 1}/${resolvedBatches.length}: Issues ${batch.map((n) => `#${n}`).join(", ")}`,
            ),
          );
          const batchResults = await orchestrator.execute(batch);
          results.push(...batchResults);
          const batchFailed = batchResults.some((r) => !r.success);
          if (batchFailed && config.sequential) {
            bracketedConsoleLog(
              phasePauseHandle,
              chalk.yellow(
                `\n  !  Batch ${batchIdx + 1} failed, stopping batch execution`,
              ),
            );
            break;
          }
        }
      } else {
        results = await orchestrator.execute(issueNumbers);
      }

      // ── Finalize logs ──────────────────────────────────────────────
      let logPath: string | null = null;
      if (logWriter) {
        logPath = await logWriter.finalize({
          endCommit: getCommitHash(process.cwd()),
        });
      }

      // ── Record metrics ─────────────────────────────────────────────
      if (!config.dryRun && results.length > 0) {
        try {
          await RunOrchestrator.recordMetrics(
            config,
            mergedOptions,
            results,
            worktreeMap,
            issueNumbers,
          );
        } catch (metricsError) {
          logNonFatalWarning(
            "  !  Metrics recording failed, continuing...",
            metricsError,
            config.verbose,
          );
        }
      }

      const allResults = [...lockedResults, ...results];
      return {
        results: allResults,
        logPath,
        exitCode: allResults.some((r) => !r.success) && !config.dryRun ? 1 : 0,
        worktreeMap,
        issueInfoMap,
        config,
        mergedOptions,
        logWriter,
      };
    } finally {
      orchestrator.markDone();
      shutdown.dispose();
    }
  }

  /**
   * Execute workflow for the given issue numbers.
   * Returns one IssueResult per issue.
   */
  async execute(issueNumbers: number[]): Promise<IssueResult[]> {
    if (issueNumbers.length === 0) {
      return [];
    }

    const batchCtx = this.buildBatchContext();
    const { config } = this.cfg;
    const options = this.cfg.options;

    // Chain mode implies sequential
    if (options.chain) {
      config.sequential = true;
    }

    if (config.sequential) {
      return this.executeSequential(issueNumbers, batchCtx, options);
    }

    return this.executeParallel(issueNumbers, batchCtx);
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private validate(config: OrchestratorConfig): void {
    if (!config.config) {
      throw new Error("OrchestratorConfig.config is required");
    }
    if (
      !config.config.phases ||
      !Array.isArray(config.config.phases) ||
      config.config.phases.length === 0
    ) {
      throw new Error(
        "OrchestratorConfig.config.phases must be a non-empty array",
      );
    }
  }

  private buildBatchContext(): BatchExecutionContext {
    const { config, options, issueInfoMap, worktreeMap, services } = this.cfg;
    return {
      config,
      options,
      issueInfoMap,
      worktreeMap,
      logWriter: services.logWriter ?? null,
      stateManager: services.stateManager ?? null,
      shutdownManager: services.shutdownManager,
      packageManager: this.cfg.packageManager,
      baseBranch: this.cfg.baseBranch,
      onProgress: this.cfg.onProgress,
      onPhasePlan: this.cfg.onPhasePlan,
      phasePauseHandle: this.cfg.phasePauseHandle,
    };
  }

  private async executeSequential(
    issueNumbers: number[],
    batchCtx: BatchExecutionContext,
    options: RunOptions,
  ): Promise<IssueResult[]> {
    const results: IssueResult[] = [];
    const shutdown = this.cfg.services.shutdownManager;

    for (let i = 0; i < issueNumbers.length; i++) {
      const issueNumber = issueNumbers[i];

      if (shutdown?.shuttingDown) {
        break;
      }

      // #760: On chain resume, the completed prefix was skipped, so the first
      // active link (i === 0) is now the resume point. The #748 successor-rebase
      // below only fires for i > 0, so explicitly rebase this first link onto
      // the last completed link's committed tip (resumeBase). This is the
      // authoritative correctness gate: provisioning may have created the
      // worktree fresh (already on resumeBase → no-op) or rebased an existing
      // one, but a provisioning-time rebase failure only warns and continues —
      // here we fail fast so the link never silently executes on the wrong base.
      const chainResume = this.cfg.chainResume;
      if (options.chain && i === 0 && chainResume?.resumeBase) {
        const activeWorktree = this.cfg.worktreeMap.get(issueNumber);
        if (activeWorktree) {
          const rebase = rebaseOntoLocalBranch(
            activeWorktree.path,
            chainResume.resumeBase,
            this.cfg.config.verbose,
          );
          if (!rebase.success) {
            console.log(
              chalk.yellow(
                `  ⚠️  Chain resume broken: could not rebase #${issueNumber} onto resume base ${chainResume.resumeBase}` +
                  (rebase.conflict ? " — merge conflict" : "") +
                  `. Stopping the chain; #${issueNumber} and any later issues were not run.`,
              ),
            );
            results.push({
              issueNumber,
              success: false,
              phaseResults: [],
              durationSeconds: 0,
              loopTriggered: false,
              abortReason: rebase.conflict
                ? `chain resume rebase conflict onto ${chainResume.resumeBase}`
                : `chain resume rebase failed onto ${chainResume.resumeBase}: ${rebase.error ?? "unknown error"}`,
            });
            break;
          }
        } else {
          console.log(
            chalk.yellow(
              `  ⚠️  Chain resume broken: no worktree for #${issueNumber}. ` +
                `Stopping the chain; #${issueNumber} and any later issues were not run.`,
            ),
          );
          results.push({
            issueNumber,
            success: false,
            phaseResults: [],
            durationSeconds: 0,
            loopTriggered: false,
            abortReason: `chain resume could not be established: missing worktree for #${issueNumber}`,
          });
          break;
        }
      }

      // #748: Successors were provisioned up-front (ensureWorktreesChain) while
      // the predecessor branch still pointed at the base, so on a fresh run each
      // successor effectively branched from main. Now that the predecessor has
      // executed and committed, re-rebase this successor's worktree onto the
      // predecessor's *local* committed tip — independent of --stacked, and
      // targeting the local feature branch (not origin/main). This is what makes
      // the chain contract ("each branches from previous") actually hold.
      if (options.chain && i > 0) {
        const successorWorktree = this.cfg.worktreeMap.get(issueNumber);
        const predecessorLocalBranch = this.cfg.worktreeMap.get(
          issueNumbers[i - 1],
        )?.branch;
        if (successorWorktree && predecessorLocalBranch) {
          const rebase = rebaseOntoLocalBranch(
            successorWorktree.path,
            predecessorLocalBranch,
            this.cfg.config.verbose,
          );
          if (!rebase.success) {
            // A broken chain link must NOT silently produce a successor built on
            // the wrong base — that successor would miss the predecessor's work
            // (the original #748 bug) and the break would propagate to every
            // downstream successor. Treat it like a predecessor failure: warn
            // loudly, record the break, and stop the chain so a human can
            // resolve the conflict and re-run.
            console.log(
              chalk.yellow(
                `  ⚠️  Chain link broken: could not rebase #${issueNumber} onto #${issueNumbers[i - 1]} (${predecessorLocalBranch})` +
                  (rebase.conflict ? " — merge conflict" : "") +
                  `. Stopping the chain; #${issueNumber} and any later issues were not run.`,
              ),
            );
            results.push({
              issueNumber,
              success: false,
              phaseResults: [],
              durationSeconds: 0,
              loopTriggered: false,
              abortReason: rebase.conflict
                ? `chain rebase conflict onto #${issueNumbers[i - 1]} (${predecessorLocalBranch})`
                : `chain rebase failed onto #${issueNumbers[i - 1]} (${predecessorLocalBranch}): ${rebase.error ?? "unknown error"}`,
            });
            break;
          }
        } else {
          // The worktree map is expected to be fully populated for a chain (the
          // --stacked block below treats a missing predecessor branch as
          // unreachable). If it isn't, the successor cannot be chained onto its
          // predecessor's work — the same end state as a rebase conflict — so we
          // break the chain identically rather than letting the successor
          // silently branch from its un-rebased base (the original #748 bug).
          const missing = !successorWorktree
            ? "successor worktree"
            : `predecessor branch for #${issueNumbers[i - 1]}`;
          console.log(
            chalk.yellow(
              `  ⚠️  Chain link could not be established for #${issueNumber}: missing ${missing} in worktree map. ` +
                `Stopping the chain; #${issueNumber} and any later issues were not run.`,
            ),
          );
          results.push({
            issueNumber,
            success: false,
            phaseResults: [],
            durationSeconds: 0,
            loopTriggered: false,
            abortReason: `chain link could not be established onto #${issueNumbers[i - 1]}: missing ${missing} in worktree map`,
          });
          break;
        }
      }

      // #605: under --stacked, non-first PRs target the predecessor branch.
      // The final PR still targets `main` (AC-3 open-question default) so the
      // stack can land partially. Manifest renders for every PR in the stack.
      let predecessorBranch: string | undefined;
      let stackManifest: string | undefined;
      if (options.chain && options.stacked) {
        if (i > 0 && i < issueNumbers.length - 1) {
          // Invariant: chain breaks on prior failure (see `break` below), so the
          // predecessor's worktree is always in worktreeMap when we reach this
          // branch. The optional-chained fallback to undefined is unreachable.
          predecessorBranch = this.cfg.worktreeMap.get(
            issueNumbers[i - 1],
          )?.branch;
        } else if (i > 0) {
          // Last PR: still emit manifest, but base stays main (no predecessor).
          // intentionally undefined predecessorBranch
        }
        stackManifest = buildStackManifest(issueNumbers, i);
      }

      const result = await this.executeOneIssue({
        issueNumber,
        batchCtx,
        chain: options.chain
          ? {
              enabled: true,
              isLast: i === issueNumbers.length - 1,
              predecessorBranch,
              stackManifest,
            }
          : undefined,
      });
      results.push(result);

      if (!result.success) {
        if (options.qaGate && options.chain) {
          const qaFailed = result.phaseResults.some(
            (p) => p.phase === "qa" && !p.success,
          );
          if (qaFailed) break;
        }
        break;
      }
    }

    return results;
  }

  private async executeParallel(
    issueNumbers: number[],
    batchCtx: BatchExecutionContext,
  ): Promise<IssueResult[]> {
    const limit = pLimit(this.cfg.config.concurrency);
    const shutdown = this.cfg.services.shutdownManager;

    const settledResults = await Promise.allSettled(
      issueNumbers.map((issueNumber) =>
        limit(async () => {
          if (shutdown?.shuttingDown) {
            return {
              issueNumber,
              success: false,
              phaseResults: [],
              durationSeconds: 0,
              loopTriggered: false,
            } as IssueResult;
          }

          return this.executeOneIssue({
            issueNumber,
            batchCtx: { ...batchCtx, onProgress: this.cfg.onProgress },
            parallelIssueNumber: issueNumber,
          });
        }),
      ),
    );

    return settledResults.map((settled, i) => {
      if (settled.status === "fulfilled") {
        return settled.value;
      }
      return {
        issueNumber: issueNumbers[i],
        success: false,
        phaseResults: [],
        durationSeconds: 0,
        loopTriggered: false,
      } as IssueResult;
    });
  }

  private async executeOneIssue(args: {
    issueNumber: number;
    batchCtx: BatchExecutionContext;
    chain?: {
      enabled: boolean;
      isLast: boolean;
      predecessorBranch?: string;
      stackManifest?: string;
    };
    parallelIssueNumber?: number;
  }): Promise<IssueResult> {
    const { issueNumber, batchCtx, chain, parallelIssueNumber } = args;
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

    const issueInfo = issueInfoMap.get(issueNumber) ?? {
      title: `Issue #${issueNumber}`,
      labels: [],
    };
    const worktreeInfo = worktreeMap.get(issueNumber);

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
      chain,
      packageManager,
      baseBranch,
      onProgress,
      onPhasePlan,
      phasePauseHandle,
    };

    // Fire-and-forget — orchestrator does not await listener completion on
    // the lifecycle bracket events. Listener safety is the emitter's job (AC-5).
    void this.emitter.emit("run_started", { issueNumber });
    const issueStartedAt = Date.now();
    // `run_completed` is emitted in the finally so the bracket stays
    // symmetric with `run_started` even if `runIssueWithLogging` throws —
    // subscribers (MCP, dashboard) can rely on every started run ending.
    let result: IssueResult | undefined;
    try {
      result = await runIssueWithLogging(ctx);

      // Surface QA verdicts as a dedicated event so consumers don't have to
      // re-parse phase output. Emits at most once per QA phase result.
      for (const pr of result.phaseResults) {
        if (pr.phase === "qa" && pr.verdict) {
          void this.emitter.emit("qa_verdict", {
            issueNumber,
            phase: "qa",
            verdict: pr.verdict,
          });
        }
      }

      if (logWriter && result.prNumber && result.prUrl) {
        logWriter.setPRInfo(result.prNumber, result.prUrl, parallelIssueNumber);
      }
      if (logWriter) {
        logWriter.completeIssue(parallelIssueNumber);
      }

      return result;
    } finally {
      const durationSec = Math.round((Date.now() - issueStartedAt) / 1000);
      void this.emitter.emit("run_completed", {
        issueNumber,
        duration: durationSec,
        success: result?.success ?? false,
      });
    }
  }

  private static async recordMetrics(
    config: ExecutionConfig,
    mergedOptions: RunOptions,
    results: IssueResult[],
    worktreeMap: Map<number, WorktreeInfo>,
    issueNumbers: number[],
  ): Promise<void> {
    const metricsWriter = new MetricsWriter({ verbose: config.verbose });
    const totalDuration = results.reduce(
      (sum, r) => sum + (r.durationSeconds ?? 0),
      0,
    );
    const allPhases = new Set<MetricPhase>();
    for (const result of results) {
      for (const pr of result.phaseResults) {
        const phase = pr.phase as MetricPhase;
        if (
          [
            "spec",
            "security-review",
            "testgen",
            "exec",
            "test",
            "qa",
            "loop",
          ].includes(phase)
        ) {
          allPhases.add(phase);
        }
      }
    }
    let totalFilesChanged = 0;
    let totalLinesAdded = 0;
    let totalQaIterations = 0;
    for (const result of results) {
      const wt = worktreeMap.get(result.issueNumber);
      if (wt?.path) {
        const s = getWorktreeDiffStats(wt.path);
        totalFilesChanged += s.filesChanged;
        totalLinesAdded += s.linesAdded;
      }
      if (result.loopTriggered) {
        totalQaIterations += result.phaseResults.filter(
          (p) => p.phase === "loop",
        ).length;
      }
    }
    const cliFlags: string[] = [];
    if (mergedOptions.sequential) cliFlags.push("--sequential");
    if (mergedOptions.chain) cliFlags.push("--chain");
    if (mergedOptions.qaGate) cliFlags.push("--qa-gate");
    if (mergedOptions.qualityLoop) cliFlags.push("--quality-loop");
    if (mergedOptions.testgen) cliFlags.push("--testgen");
    const tokenUsage = getTokenUsageForRun(undefined, true);
    const passed = results.filter((r) => r.success).length;
    await metricsWriter.recordRun({
      issues: issueNumbers,
      phases: Array.from(allPhases),
      outcome: determineOutcome(passed, results.length),
      duration: totalDuration,
      model: process.env.ANTHROPIC_MODEL ?? "opus",
      flags: cliFlags,
      metrics: {
        tokensUsed: tokenUsage.tokensUsed,
        filesChanged: totalFilesChanged,
        linesAdded: totalLinesAdded,
        acceptanceCriteria: 0,
        qaIterations: totalQaIterations,
        inputTokens: tokenUsage.inputTokens || undefined,
        outputTokens: tokenUsage.outputTokens || undefined,
        cacheTokens: tokenUsage.cacheTokens || undefined,
      },
    });
    if (config.verbose) {
      console.log(chalk.gray("  Metrics recorded to .sequant/metrics.json"));
    }
  }
}

function findOrAppendPhase(
  state: IssueRuntimeState,
  name: string,
): PhaseRuntimeState {
  let p = state.phases.find((ph) => ph.name === name);
  if (!p) {
    p = { name, status: "pending" };
    state.phases.push(p);
  }
  return p;
}

/**
 * Activity is considered stale (and `nowLine` falls back to the coarse
 * `running <phase>` form) once it goes this long without an update (#543).
 */
const ACTIVITY_STALE_MS = 5_000;

function cloneIssueState(s: IssueRuntimeState): IssueRuntimeState {
  return {
    number: s.number,
    title: s.title,
    branch: s.branch,
    status: s.status,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    phases: s.phases.map((p) => ({
      name: p.name,
      status: p.status,
      startedAt: p.startedAt,
      elapsedMs: p.elapsedMs,
    })),
    currentPhase: s.currentPhase
      ? {
          name: s.currentPhase.name,
          startedAt: s.currentPhase.startedAt,
          lastActivityAt: s.currentPhase.lastActivityAt,
          nowLine: nowLineWithStaleFallback(s.currentPhase),
          logPath: s.currentPhase.logPath,
        }
      : undefined,
  };
}

function nowLineWithStaleFallback(
  current: NonNullable<IssueRuntimeState["currentPhase"]>,
): string {
  const ageMs = Date.now() - current.lastActivityAt.getTime();
  if (ageMs >= ACTIVITY_STALE_MS) {
    return formatCoarseNowLine(current.name);
  }
  return current.nowLine;
}

/**
 * Reduce a chunk of streamed agent output to a single line suitable for the
 * activity row. Strips ANSI sequences and trailing whitespace; returns the
 * last non-empty line, truncated to keep the cell render cheap. Returns
 * `undefined` when the chunk contains no usable content.
 */
function extractActivityLine(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Strip ANSI CSI escapes — covers SGR (colour/bold, `…m`), cursor-movement
  // and line-clear codes (`\x1b[2K`, `\x1b[G`), and DEC private-mode toggles
  // (`\x1b[?25l`), any of which can leak through chalk/ink in agent output.
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const lines = cleaned.split(/\r?\n/);
  let last = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.length > 0) {
      last = trimmed;
      break;
    }
  }
  if (!last) return undefined;
  // Bound at 200 chars; the TUI truncates further per row width.
  return last.length > 200 ? last.slice(0, 200) : last;
}

/**
 * Build the synthetic `IssueResult` returned for an issue that was skipped
 * because another sequant session holds its lock (#625).
 */
export function buildLockedResult(
  issueNumber: number,
  holder: LockFile,
): IssueResult {
  return {
    issueNumber,
    success: false,
    phaseResults: [],
    abortReason: `locked by PID ${holder.pid}`,
    locked: {
      pid: holder.pid,
      hostname: holder.hostname,
      startedAt: holder.startedAt,
      command: holder.command,
    },
  };
}

/** Log a non-fatal warning: one-line summary always, detail in verbose. */
export function logNonFatalWarning(
  message: string,
  error: unknown,
  verbose: boolean,
): void {
  console.log(chalk.yellow(message));
  if (verbose) {
    console.log(chalk.gray(`    ${error}`));
  }
}
