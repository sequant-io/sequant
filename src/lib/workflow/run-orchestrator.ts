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
} from "./worktree-manager.js";
import { LogWriter } from "./log-writer.js";
import type { RunConfig } from "./run-log-schema.js";
import { StateManager } from "./state-manager.js";
import { ShutdownManager } from "../shutdown.js";
import {
  getIssueInfo,
  sortByDependencies,
  parseBatches,
  runIssueWithLogging,
} from "./batch-executor.js";
import { reconcileStateAtStartup } from "./state-utils.js";
import { getCommitHash } from "./git-diff-utils.js";
import { MetricsWriter } from "./metrics-writer.js";
import { type MetricPhase, determineOutcome } from "./metrics-schema.js";
import { getTokenUsageForRun } from "./token-utils.js";
import type { SequantSettings } from "../settings.js";
import { resolveRunOptions, buildExecutionConfig } from "./config-resolver.js";

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
  /** Per-phase progress callback (parallel mode) */
  onProgress?: ProgressCallback;
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
  private done = false;

  constructor(config: OrchestratorConfig) {
    this.validate(config);
    this.cfg = { ...config, onProgress: this.wrapProgress(config.onProgress) };
    this.initIssueStates();
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

  /** Mark the run as completed so the dashboard can unmount. */
  markDone(): void {
    this.done = true;
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
    event: "start" | "complete" | "failed",
    extra?: { durationSeconds?: number; error?: string },
  ): void {
    const state = this.issueStates.get(issue);
    if (!state) return;

    if (event === "start") {
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

    if (event === "failed") {
      state.status = "failed";
      state.completedAt = new Date();
      return;
    }

    // Completed phase: if it's the last phase in the plan, mark issue passed.
    const allDone = state.phases.every(
      (ph) => ph.status === "done" || ph.status === "failed",
    );
    if (allDone) {
      state.status = state.phases.some((ph) => ph.status === "failed")
        ? "failed"
        : "passed";
      state.completedAt = new Date();
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
    const { manifest, onProgress, settings } = init;

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

    if (stateManager && !config.dryRun && !mergedOptions.force) {
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
        worktreeMap = await ensureWorktreesChain(
          issueData,
          config.verbose,
          manifest.packageManager,
          baseBranch,
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
      onProgress,
    });
    init.onOrchestratorReady?.(orchestrator);

    try {
      if (resolvedBatches) {
        for (let batchIdx = 0; batchIdx < resolvedBatches.length; batchIdx++) {
          const batch = resolvedBatches[batchIdx];
          console.log(
            chalk.blue(
              `\n  Batch ${batchIdx + 1}/${resolvedBatches.length}: Issues ${batch.map((n) => `#${n}`).join(", ")}`,
            ),
          );
          const batchResults = await orchestrator.execute(batch);
          results.push(...batchResults);
          const batchFailed = batchResults.some((r) => !r.success);
          if (batchFailed && config.sequential) {
            console.log(
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

      return {
        results,
        logPath,
        exitCode: results.some((r) => !r.success) && !config.dryRun ? 1 : 0,
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

      const result = await this.executeOneIssue({
        issueNumber,
        batchCtx,
        chain: options.chain
          ? { enabled: true, isLast: i === issueNumbers.length - 1 }
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
    chain?: { enabled: boolean; isLast: boolean };
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
    };
    const result = await runIssueWithLogging(ctx);

    if (logWriter && result.prNumber && result.prUrl) {
      logWriter.setPRInfo(result.prNumber, result.prUrl, parallelIssueNumber);
    }
    if (logWriter) {
      logWriter.completeIssue(parallelIssueNumber);
    }

    return result;
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
          nowLine: s.currentPhase.nowLine,
          logPath: s.currentPhase.logPath,
        }
      : undefined,
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
