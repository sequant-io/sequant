/**
 * sequant run - Execute workflow for GitHub issues
 *
 * Runs the Sequant workflow (/spec → /exec → /qa) for one or more issues
 * using the Claude Agent SDK for proper skill invocation.
 */

import chalk from "chalk";
import { spawnSync } from "child_process";
import { getManifest } from "../lib/manifest.js";
import { getSettings } from "../lib/settings.js";
import { LogWriter } from "../lib/workflow/log-writer.js";
import type { RunConfig } from "../lib/workflow/run-log-schema.js";
import { StateManager } from "../lib/workflow/state-manager.js";
import {
  Phase,
  DEFAULT_PHASES,
  DEFAULT_CONFIG,
  ExecutionConfig,
  IssueResult,
} from "../lib/workflow/types.js";
import { ShutdownManager } from "../lib/shutdown.js";
import { checkVersionCached, getVersionWarning } from "../lib/version-check.js";
import { MetricsWriter } from "../lib/workflow/metrics-writer.js";
import {
  type MetricPhase,
  determineOutcome,
} from "../lib/workflow/metrics-schema.js";
import { ui, colors } from "../lib/cli-ui.js";
import { getCommitHash } from "../lib/workflow/git-diff-utils.js";
import { getTokenUsageForRun } from "../lib/workflow/token-utils.js";
import { reconcileStateAtStartup } from "../lib/workflow/state-utils.js";

// Import from extracted modules
import {
  type WorktreeInfo,
  getWorktreeDiffStats,
  ensureWorktrees,
  ensureWorktreesChain,
} from "../lib/workflow/worktree-manager.js";
import { formatDuration } from "../lib/workflow/phase-executor.js";
import {
  sortByDependencies,
  getIssueInfo,
} from "../lib/workflow/phase-mapper.js";
import {
  type RunOptions,
  parseBatches,
  getEnvConfig,
  executeBatch,
  runIssueWithLogging,
} from "../lib/workflow/batch-executor.js";

// Re-export for backward compatibility (AC-3)
export {
  // From worktree-manager
  type WorktreeInfo,
  type WorktreeFreshnessResult,
  type RebaseResult,
  type PRCreationResult,
  slugify,
  getGitRoot,
  findExistingWorktree,
  checkWorktreeFreshness,
  removeStaleWorktree,
  listWorktrees,
  getWorktreeChangedFiles,
  getWorktreeDiffStats,
  readCacheMetrics,
  createCheckpointCommit,
  reinstallIfLockfileChanged,
  rebaseBeforePR,
  createPR,
  ensureWorktree,
  ensureWorktrees,
  ensureWorktreesChain,
} from "../lib/workflow/worktree-manager.js";

export {
  // From phase-executor
  PHASE_PROMPTS,
  ISOLATED_PHASES,
  parseQaVerdict,
  formatDuration,
  getPhasePrompt,
  executePhase,
  executePhaseWithRetry,
} from "../lib/workflow/phase-executor.js";

export {
  // From phase-mapper
  UI_LABELS,
  BUG_LABELS,
  DOCS_LABELS,
  COMPLEX_LABELS,
  SECURITY_LABELS,
  detectPhasesFromLabels,
  parseRecommendedWorkflow,
  hasUILabels,
  determinePhasesForIssue,
  filterResumedPhases,
  getIssueInfo,
  parseDependencies,
  sortByDependencies,
} from "../lib/workflow/phase-mapper.js";

export {
  // From batch-executor
  type RunOptions,
  parseBatches,
  getEnvConfig,
  executeBatch,
  runIssueWithLogging,
} from "../lib/workflow/batch-executor.js";

/**
 * Main run command
 */
export async function runCommand(
  issues: string[],
  options: RunOptions,
): Promise<void> {
  console.log(ui.headerBox("SEQUANT WORKFLOW"));

  // Version freshness check (cached, non-blocking, respects --quiet)
  if (!options.quiet) {
    try {
      const versionResult = await checkVersionCached();
      if (versionResult.isOutdated && versionResult.latestVersion) {
        console.log(
          chalk.yellow(
            `  ⚠️  ${getVersionWarning(versionResult.currentVersion, versionResult.latestVersion, versionResult.isLocalInstall)}`,
          ),
        );
        console.log("");
      }
    } catch {
      // Silent failure - version check is non-critical
    }
  }

  // Check if initialized
  const manifest = await getManifest();
  if (!manifest) {
    console.log(
      chalk.red("❌ Sequant is not initialized. Run `sequant init` first."),
    );
    return;
  }

  // Load settings and merge with environment config and CLI options
  const settings = await getSettings();
  const envConfig = getEnvConfig();

  // Settings provide defaults, env overrides settings, CLI overrides all
  // Note: phases are auto-detected per-issue unless --phases is explicitly set
  // Commander.js converts --no-X to { X: false }, not { noX: true }.
  // Normalize these so RunOptions fields (noLog, noMcp, etc.) work correctly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cliOpts = options as any;
  const normalizedOptions: RunOptions = {
    ...options,
    ...(cliOpts.log === false && { noLog: true }),
    ...(cliOpts.smartTests === false && { noSmartTests: true }),
    ...(cliOpts.mcp === false && { noMcp: true }),
    ...(cliOpts.retry === false && { noRetry: true }),
    ...(cliOpts.rebase === false && { noRebase: true }),
    ...(cliOpts.pr === false && { noPr: true }),
  };

  const mergedOptions: RunOptions = {
    // Settings defaults (phases removed - now auto-detected)
    sequential: normalizedOptions.sequential ?? settings.run.sequential,
    timeout: normalizedOptions.timeout ?? settings.run.timeout,
    logPath: normalizedOptions.logPath ?? settings.run.logPath,
    qualityLoop: normalizedOptions.qualityLoop ?? settings.run.qualityLoop,
    maxIterations:
      normalizedOptions.maxIterations ?? settings.run.maxIterations,
    noSmartTests: normalizedOptions.noSmartTests ?? !settings.run.smartTests,
    // Env overrides
    ...envConfig,
    // CLI explicit options override all
    ...normalizedOptions,
  };

  // Determine if we should auto-detect phases from labels
  const autoDetectPhases = !options.phases && settings.run.autoDetectPhases;
  mergedOptions.autoDetectPhases = autoDetectPhases;

  // Resolve base branch: CLI flag → settings.run.defaultBase → 'main'
  const resolvedBaseBranch =
    options.base ?? settings.run.defaultBase ?? undefined;

  // Parse issue numbers (or use batch mode)
  let issueNumbers: number[];
  let batches: number[][] | null = null;

  if (mergedOptions.batch && mergedOptions.batch.length > 0) {
    batches = parseBatches(mergedOptions.batch);
    issueNumbers = batches.flat();
    console.log(
      chalk.gray(
        `  Batch mode: ${batches.map((b) => `[${b.join(", ")}]`).join(" → ")}`,
      ),
    );
  } else {
    issueNumbers = issues.map((i) => parseInt(i, 10)).filter((n) => !isNaN(n));
  }

  if (issueNumbers.length === 0) {
    console.log(chalk.red("❌ No valid issue numbers provided."));
    console.log(chalk.gray("\nUsage: npx sequant run <issues...> [options]"));
    console.log(chalk.gray("Example: npx sequant run 1 2 3 --sequential"));
    console.log(
      chalk.gray('Batch example: npx sequant run --batch "1 2" --batch "3"'),
    );
    console.log(
      chalk.gray("Chain example: npx sequant run 1 2 3 --sequential --chain"),
    );
    return;
  }

  // Validate chain mode requirements
  if (mergedOptions.chain) {
    if (!mergedOptions.sequential) {
      console.log(chalk.red("❌ --chain requires --sequential flag"));
      console.log(
        chalk.gray(
          "   Chain mode executes issues sequentially, each branching from the previous.",
        ),
      );
      console.log(
        chalk.gray("   Usage: npx sequant run 1 2 3 --sequential --chain"),
      );
      return;
    }

    if (batches) {
      console.log(chalk.red("❌ --chain cannot be used with --batch"));
      console.log(
        chalk.gray(
          "   Chain mode creates a linear dependency chain between issues.",
        ),
      );
      return;
    }

    // Warn about long chains
    if (issueNumbers.length > 5) {
      console.log(
        chalk.yellow(
          `  ⚠️  Warning: Chain has ${issueNumbers.length} issues (recommended max: 5)`,
        ),
      );
      console.log(
        chalk.yellow(
          "     Long chains increase merge complexity and review difficulty.",
        ),
      );
      console.log(
        chalk.yellow(
          "     Consider breaking into smaller chains or using batch mode.",
        ),
      );
      console.log("");
    }
  }

  // Validate QA gate requirements
  if (mergedOptions.qaGate && !mergedOptions.chain) {
    console.log(chalk.red("❌ --qa-gate requires --chain flag"));
    console.log(
      chalk.gray(
        "   QA gate ensures each issue passes QA before the next issue starts.",
      ),
    );
    console.log(
      chalk.gray(
        "   Usage: npx sequant run 1 2 3 --sequential --chain --qa-gate",
      ),
    );
    return;
  }

  // Sort issues by dependencies (if more than one issue)
  if (issueNumbers.length > 1 && !batches) {
    const originalOrder = [...issueNumbers];
    issueNumbers = sortByDependencies(issueNumbers);
    const orderChanged = !originalOrder.every((n, i) => n === issueNumbers[i]);
    if (orderChanged) {
      console.log(
        chalk.gray(
          `  Dependency order: ${issueNumbers.map((n) => `#${n}`).join(" → ")}`,
        ),
      );
    }
  }

  // Build config
  // Note: config.phases is only used when --phases is explicitly set or autoDetect fails
  const explicitPhases = mergedOptions.phases
    ? (mergedOptions.phases.split(",").map((p) => p.trim()) as Phase[])
    : null;

  // Determine MCP enablement: CLI flag (--no-mcp) → settings.run.mcp → default (true)
  const mcpEnabled = mergedOptions.noMcp
    ? false
    : (settings.run.mcp ?? DEFAULT_CONFIG.mcp);

  // Resolve retry setting: CLI flag → settings.run.retry → default (true)
  const retryEnabled = mergedOptions.noRetry
    ? false
    : (settings.run.retry ?? true);

  const config: ExecutionConfig = {
    ...DEFAULT_CONFIG,
    phases: explicitPhases ?? DEFAULT_PHASES,
    sequential: mergedOptions.sequential ?? false,
    dryRun: mergedOptions.dryRun ?? false,
    verbose: mergedOptions.verbose ?? false,
    phaseTimeout: mergedOptions.timeout ?? DEFAULT_CONFIG.phaseTimeout,
    qualityLoop: mergedOptions.qualityLoop ?? false,
    maxIterations: mergedOptions.maxIterations ?? DEFAULT_CONFIG.maxIterations,
    noSmartTests: mergedOptions.noSmartTests ?? false,
    mcp: mcpEnabled,
    retry: retryEnabled,
  };

  // Propagate verbose mode to UI config so spinners use text-only mode.
  // This prevents animated spinner control characters from colliding with
  // verbose console.log() calls from StateManager/MetricsWriter (#282).
  if (config.verbose) {
    ui.configure({ verbose: true });
  }

  // Initialize log writer if JSON logging enabled
  // Default: enabled via settings (logJson: true), can be disabled with --no-log
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
      // Log initialization failure is non-fatal - warn and continue without logging
      // Common causes: permissions issues, disk full, invalid path
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.log(
        chalk.yellow(
          `  ⚠️ Log initialization failed, continuing without logging: ${errorMessage}`,
        ),
      );
      logWriter = null;
    }
  }

  // Initialize state manager for persistent workflow state tracking
  // State tracking is always enabled (unless dry run)
  let stateManager: StateManager | null = null;
  if (!config.dryRun) {
    stateManager = new StateManager({ verbose: config.verbose });
  }

  // Initialize shutdown manager for graceful interruption handling
  const shutdown = new ShutdownManager();

  // Register log writer finalization as cleanup task
  if (logWriter) {
    const writer = logWriter; // Capture for closure
    shutdown.registerCleanup("Finalize run logs", async () => {
      await writer.finalize();
    });
  }

  // Display configuration
  console.log(chalk.gray(`  Stack: ${manifest.stack}`));
  if (autoDetectPhases) {
    console.log(chalk.gray(`  Phases: auto-detect from labels`));
  } else {
    console.log(chalk.gray(`  Phases: ${config.phases.join(" → ")}`));
  }
  console.log(
    chalk.gray(`  Mode: ${config.sequential ? "sequential" : "parallel"}`),
  );
  if (config.qualityLoop) {
    console.log(
      chalk.gray(
        `  Quality loop: enabled (max ${config.maxIterations} iterations)`,
      ),
    );
  }
  if (mergedOptions.testgen) {
    console.log(chalk.gray(`  Testgen: enabled`));
  }
  if (config.noSmartTests) {
    console.log(chalk.gray(`  Smart tests: disabled`));
  }
  if (config.dryRun) {
    console.log(chalk.yellow(`  ⚠️  DRY RUN - no actual execution`));
  }
  if (logWriter) {
    console.log(
      chalk.gray(
        `  Logging: JSON (run ${logWriter.getRunId()?.slice(0, 8)}...)`,
      ),
    );
  }
  if (stateManager) {
    console.log(chalk.gray(`  State tracking: enabled`));
  }
  if (mergedOptions.force) {
    console.log(chalk.yellow(`  Force mode: enabled (bypass state guard)`));
  }
  console.log(
    chalk.gray(`  Issues: ${issueNumbers.map((n) => `#${n}`).join(", ")}`),
  );

  // ============================================================================
  // Pre-flight State Guard (#305)
  // ============================================================================

  // AC-5: Auto-cleanup at run start - reconcile stale ready_for_merge states
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
    } catch {
      // AC-8: Graceful degradation - don't block execution on reconciliation failure
      if (config.verbose) {
        console.log(
          chalk.yellow(`  ⚠️  State reconciliation failed, continuing...`),
        );
      }
    }
  }

  // AC-1 & AC-2: Pre-flight state guard - skip completed issues unless --force
  if (stateManager && !config.dryRun && !mergedOptions.force) {
    const skippedIssues: number[] = [];
    const activeIssues: number[] = [];

    for (const issueNumber of issueNumbers) {
      try {
        const issueState = await stateManager.getIssueState(issueNumber);
        if (
          issueState &&
          (issueState.status === "ready_for_merge" ||
            issueState.status === "merged")
        ) {
          skippedIssues.push(issueNumber);
          console.log(
            chalk.yellow(
              `  ⚠️  #${issueNumber}: already ${issueState.status} — skipping (use --force to re-run)`,
            ),
          );
        } else {
          activeIssues.push(issueNumber);
        }
      } catch {
        // AC-8: Graceful degradation - if state check fails, include the issue
        activeIssues.push(issueNumber);
      }
    }

    // Update issueNumbers to only include active issues
    if (skippedIssues.length > 0) {
      issueNumbers = activeIssues;

      if (issueNumbers.length === 0) {
        console.log(
          chalk.yellow(
            `\n  All issues already completed. Use --force to re-run.`,
          ),
        );
        return;
      }

      console.log(
        chalk.gray(
          `  Active issues: ${issueNumbers.map((n) => `#${n}`).join(", ")}`,
        ),
      );
    }
  }

  // Worktree isolation is enabled by default for multi-issue runs
  const useWorktreeIsolation =
    mergedOptions.worktreeIsolation !== false && issueNumbers.length > 0;

  if (useWorktreeIsolation) {
    console.log(chalk.gray(`  Worktree isolation: enabled`));
  }
  if (resolvedBaseBranch) {
    console.log(chalk.gray(`  Base branch: ${resolvedBaseBranch}`));
  }
  if (mergedOptions.chain) {
    console.log(
      chalk.gray(`  Chain mode: enabled (each issue branches from previous)`),
    );
  }
  if (mergedOptions.qaGate) {
    console.log(chalk.gray(`  QA gate: enabled (chain waits for QA pass)`));
  }

  // Fetch issue info for all issues first
  const issueInfoMap = new Map<number, { title: string; labels: string[] }>();
  for (const issueNumber of issueNumbers) {
    issueInfoMap.set(issueNumber, await getIssueInfo(issueNumber));
  }

  // Create worktrees for all issues before execution (if isolation enabled)
  let worktreeMap: Map<number, WorktreeInfo> = new Map();
  if (useWorktreeIsolation && !config.dryRun) {
    const issueData = issueNumbers.map((num) => ({
      number: num,
      title: issueInfoMap.get(num)?.title || `Issue #${num}`,
    }));

    // Use chain mode or standard worktree creation
    if (mergedOptions.chain) {
      worktreeMap = await ensureWorktreesChain(
        issueData,
        config.verbose,
        manifest.packageManager,
        resolvedBaseBranch,
      );
    } else {
      worktreeMap = await ensureWorktrees(
        issueData,
        config.verbose,
        manifest.packageManager,
        resolvedBaseBranch,
      );
    }

    // Register cleanup tasks for newly created worktrees (not pre-existing ones)
    for (const [issueNum, worktree] of worktreeMap.entries()) {
      if (!worktree.existed) {
        shutdown.registerCleanup(
          `Cleanup worktree for #${issueNum}`,
          async () => {
            // Remove worktree (leaves branch intact for recovery)
            const result = spawnSync(
              "git",
              ["worktree", "remove", "--force", worktree.path],
              {
                stdio: "pipe",
              },
            );
            if (result.status !== 0 && config.verbose) {
              console.log(
                chalk.yellow(
                  `    Warning: Could not remove worktree ${worktree.path}`,
                ),
              );
            }
          },
        );
      }
    }
  }

  // Execute with graceful shutdown handling
  const results: IssueResult[] = [];
  let exitCode = 0;

  try {
    if (batches) {
      // Batch execution: run batches sequentially, issues within batch based on mode
      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];
        console.log(
          chalk.blue(
            `\n  Batch ${batchIdx + 1}/${batches.length}: Issues ${batch.map((n) => `#${n}`).join(", ")}`,
          ),
        );

        const batchResults = await executeBatch(
          batch,
          config,
          logWriter,
          stateManager,
          mergedOptions,
          issueInfoMap,
          worktreeMap,
          shutdown,
          manifest.packageManager,
        );
        results.push(...batchResults);

        // Check if batch failed and we should stop
        const batchFailed = batchResults.some((r) => !r.success);
        if (batchFailed && config.sequential) {
          console.log(
            chalk.yellow(
              `\n  ⚠️  Batch ${batchIdx + 1} failed, stopping batch execution`,
            ),
          );
          break;
        }
      }
    } else if (config.sequential) {
      // Sequential execution
      for (let i = 0; i < issueNumbers.length; i++) {
        const issueNumber = issueNumbers[i];
        const issueInfo = issueInfoMap.get(issueNumber) ?? {
          title: `Issue #${issueNumber}`,
          labels: [],
        };
        const worktreeInfo = worktreeMap.get(issueNumber);

        // Start issue logging
        if (logWriter) {
          logWriter.startIssue(issueNumber, issueInfo.title, issueInfo.labels);
        }

        const result = await runIssueWithLogging(
          issueNumber,
          config,
          logWriter,
          stateManager,
          issueInfo.title,
          issueInfo.labels,
          mergedOptions,
          worktreeInfo?.path,
          worktreeInfo?.branch,
          shutdown,
          mergedOptions.chain, // Enable checkpoint commits in chain mode
          manifest.packageManager,
          // In chain mode, only the last issue should trigger pre-PR rebase
          mergedOptions.chain ? i === issueNumbers.length - 1 : undefined,
        );
        results.push(result);

        // Record PR info in log before completing issue
        if (logWriter && result.prNumber && result.prUrl) {
          logWriter.setPRInfo(result.prNumber, result.prUrl);
        }

        // Complete issue logging
        if (logWriter) {
          logWriter.completeIssue();
        }

        // Check if shutdown was triggered
        if (shutdown.shuttingDown) {
          break;
        }

        if (!result.success) {
          // Check if QA gate is enabled and QA specifically failed
          if (mergedOptions.qaGate) {
            const qaResult = result.phaseResults.find((p) => p.phase === "qa");
            const qaFailed = qaResult && !qaResult.success;

            if (qaFailed) {
              // QA gate: pause chain with clear messaging
              console.log(chalk.yellow("\n  ⏸️  QA Gate"));
              console.log(
                chalk.yellow(
                  `     Issue #${issueNumber} QA did not pass. Chain paused.`,
                ),
              );
              console.log(
                chalk.gray(
                  "     Fix QA issues and re-run, or run /loop to auto-fix.",
                ),
              );

              // Update state to waiting_for_qa_gate
              if (stateManager) {
                try {
                  await stateManager.updateIssueStatus(
                    issueNumber,
                    "waiting_for_qa_gate",
                  );
                } catch {
                  // State tracking errors shouldn't stop execution
                }
              }
              break;
            }
          }

          const chainInfo = mergedOptions.chain ? " (chain stopped)" : "";
          console.log(
            chalk.yellow(
              `\n  ⚠️  Issue #${issueNumber} failed, stopping sequential execution${chainInfo}`,
            ),
          );
          break;
        }
      }
    } else {
      // Parallel execution (for now, just run sequentially but don't stop on failure)
      // TODO: Add proper parallel execution with listr2
      for (const issueNumber of issueNumbers) {
        // Check if shutdown was triggered
        if (shutdown.shuttingDown) {
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

        const result = await runIssueWithLogging(
          issueNumber,
          config,
          logWriter,
          stateManager,
          issueInfo.title,
          issueInfo.labels,
          mergedOptions,
          worktreeInfo?.path,
          worktreeInfo?.branch,
          shutdown,
          false, // Parallel mode doesn't support chain
          manifest.packageManager,
        );
        results.push(result);

        // Record PR info in log before completing issue
        if (logWriter && result.prNumber && result.prUrl) {
          logWriter.setPRInfo(result.prNumber, result.prUrl);
        }

        // Complete issue logging
        if (logWriter) {
          logWriter.completeIssue();
        }
      }
    }

    // Finalize log
    let logPath: string | null = null;
    if (logWriter) {
      logPath = await logWriter.finalize({
        endCommit: getCommitHash(process.cwd()),
      });
    }

    // Calculate success/failure counts
    const passed = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    // Record metrics (local analytics)
    if (!config.dryRun && results.length > 0) {
      try {
        const metricsWriter = new MetricsWriter({ verbose: config.verbose });

        // Calculate total duration
        const totalDuration = results.reduce(
          (sum, r) => sum + (r.durationSeconds ?? 0),
          0,
        );

        // Get unique phases from all results
        const allPhases = new Set<MetricPhase>();
        for (const result of results) {
          for (const phaseResult of result.phaseResults) {
            // Only include phases that are valid MetricPhases
            const phase = phaseResult.phase as MetricPhase;
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

        // Calculate aggregate metrics from worktrees
        let totalFilesChanged = 0;
        let totalLinesAdded = 0;
        let totalQaIterations = 0;

        for (const result of results) {
          const worktreeInfo = worktreeMap.get(result.issueNumber);
          if (worktreeInfo?.path) {
            const stats = getWorktreeDiffStats(worktreeInfo.path);
            totalFilesChanged += stats.filesChanged;
            totalLinesAdded += stats.linesAdded;
          }
          // Count QA iterations (loop phases indicate retries)
          if (result.loopTriggered) {
            totalQaIterations += result.phaseResults.filter(
              (p) => p.phase === "loop",
            ).length;
          }
        }

        // Build CLI flags for metrics
        const cliFlags: string[] = [];
        if (mergedOptions.sequential) cliFlags.push("--sequential");
        if (mergedOptions.chain) cliFlags.push("--chain");
        if (mergedOptions.qaGate) cliFlags.push("--qa-gate");
        if (mergedOptions.qualityLoop) cliFlags.push("--quality-loop");
        if (mergedOptions.testgen) cliFlags.push("--testgen");

        // Read token usage from SessionEnd hook files (AC-5, AC-6)
        const tokenUsage = getTokenUsageForRun(undefined, true); // cleanup after reading

        // Record the run
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
            acceptanceCriteria: 0, // Would need to parse from issue
            qaIterations: totalQaIterations,
            // Token breakdown (AC-6)
            inputTokens: tokenUsage.inputTokens || undefined,
            outputTokens: tokenUsage.outputTokens || undefined,
            cacheTokens: tokenUsage.cacheTokens || undefined,
          },
        });

        if (config.verbose) {
          console.log(
            chalk.gray(`  📊 Metrics recorded to .sequant/metrics.json`),
          );
        }
      } catch (metricsError) {
        // Metrics recording errors shouldn't stop execution
        if (config.verbose) {
          console.log(
            chalk.yellow(`  ⚠️  Metrics recording error: ${metricsError}`),
          );
        }
      }
    }

    // Summary
    console.log("\n" + ui.divider());
    console.log(colors.info("  Summary"));
    console.log(ui.divider());

    console.log(
      colors.muted(
        `\n  Results: ${colors.success(`${passed} passed`)}, ${colors.error(`${failed} failed`)}`,
      ),
    );

    for (const result of results) {
      const status = result.success
        ? ui.statusIcon("success")
        : ui.statusIcon("error");
      const duration = result.durationSeconds
        ? colors.muted(` (${formatDuration(result.durationSeconds)})`)
        : "";
      const phases = result.phaseResults
        .map((p) =>
          p.success ? colors.success(p.phase) : colors.error(p.phase),
        )
        .join(" → ");
      const loopInfo = result.loopTriggered ? colors.warning(" [loop]") : "";
      const prInfo = result.prUrl
        ? colors.muted(` → PR #${result.prNumber}`)
        : "";
      console.log(
        `  ${status} #${result.issueNumber}: ${phases}${loopInfo}${prInfo}${duration}`,
      );
    }

    console.log("");

    if (logPath) {
      console.log(colors.muted(`  📝 Log: ${logPath}`));
      console.log("");
    }

    // Suggest merge checks for multi-issue batches
    if (results.length > 1 && passed > 0 && !config.dryRun) {
      console.log(
        colors.muted("  💡 Verify batch integration before merging:"),
      );
      console.log(colors.muted("     sequant merge --check"));
      console.log("");
    }

    if (config.dryRun) {
      console.log(
        colors.warning(
          "  ℹ️  This was a dry run. Use without --dry-run to execute.",
        ),
      );
      console.log("");
    }

    // Set exit code if any failed
    if (failed > 0 && !config.dryRun) {
      exitCode = 1;
    }
  } finally {
    // Always dispose shutdown manager to clean up signal handlers
    shutdown.dispose();
  }

  // Exit with error if any failed (outside try/finally so dispose() runs first)
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
