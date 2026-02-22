/**
 * Batch Execution Module
 *
 * Handles batch execution of workflow phases for multiple issues:
 * - Single issue execution with logging
 * - Batch execution orchestration
 * - Quality loop iteration
 * - State tracking integration
 *
 * @module batch-executor
 */

import chalk from "chalk";
import { ShutdownManager } from "../shutdown.js";
import { PhaseSpinner } from "../phase-spinner.js";
import { LogWriter, createPhaseLogFromTiming } from "./log-writer.js";
import { StateManager } from "./state-manager.js";
import { getGitDiffStats, getCommitHash } from "./git-diff-utils.js";
import type {
  Phase,
  ExecutionConfig,
  IssueResult,
  PhaseResult,
} from "./types.js";
import type { WorktreeInfo } from "./worktree-manager.js";
import {
  createCheckpointCommit,
  rebaseBeforePR,
  createPR,
  readCacheMetrics,
} from "./worktree-manager.js";
import { executePhaseWithRetry, formatDuration } from "./phase-executor.js";
import {
  detectPhasesFromLabels,
  parseRecommendedWorkflow,
  filterResumedPhases,
  determinePhasesForIssue,
  BUG_LABELS,
} from "./phase-mapper.js";

/**
 * Options passed from runCommand
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
  maxIterations?: number;
  batch?: string[];
  smartTests?: boolean;
  noSmartTests?: boolean;
  testgen?: boolean;
  autoDetectPhases?: boolean;
  worktreeIsolation?: boolean;
  reuseWorktrees?: boolean;
  quiet?: boolean;
  chain?: boolean;
  qaGate?: boolean;
  base?: string;
  noMcp?: boolean;
  resume?: boolean;
  noRetry?: boolean;
  noRebase?: boolean;
  noPr?: boolean;
  force?: boolean;
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

  return config;
}

/**
 * Execute a batch of issues
 */
export async function executeBatch(
  issueNumbers: number[],
  config: ExecutionConfig,
  logWriter: LogWriter | null,
  stateManager: StateManager | null,
  options: RunOptions,
  issueInfoMap: Map<number, { title: string; labels: string[] }>,
  worktreeMap: Map<number, WorktreeInfo>,
  shutdownManager?: ShutdownManager,
  packageManager?: string,
): Promise<IssueResult[]> {
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

    const result = await runIssueWithLogging(
      issueNumber,
      config,
      logWriter,
      stateManager,
      issueInfo.title,
      issueInfo.labels,
      options,
      worktreeInfo?.path,
      worktreeInfo?.branch,
      shutdownManager,
      false, // Batch mode doesn't support chain
      packageManager,
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

  return results;
}

/**
 * Execute all phases for a single issue with logging and quality loop
 */
export async function runIssueWithLogging(
  issueNumber: number,
  config: ExecutionConfig,
  logWriter: LogWriter | null,
  stateManager: StateManager | null,
  issueTitle: string,
  labels: string[],
  options: RunOptions,
  worktreePath?: string,
  branch?: string,
  shutdownManager?: ShutdownManager,
  chainMode?: boolean,
  packageManager?: string,
  isLastInChain?: boolean,
): Promise<IssueResult> {
  const startTime = Date.now();
  const phaseResults: PhaseResult[] = [];
  let loopTriggered = false;
  let sessionId: string | undefined;

  console.log(chalk.blue(`\n  Issue #${issueNumber}`));
  if (worktreePath) {
    console.log(chalk.gray(`    Worktree: ${worktreePath}`));
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
        console.log(chalk.yellow(`    ⚠️  State tracking error: ${error}`));
      }
    }
  }

  // Determine phases for this specific issue
  let phases: Phase[];
  let detectedQualityLoop = false;
  let specAlreadyRan = false;

  if (options.autoDetectPhases) {
    // Check if labels indicate a simple bug/fix (skip spec entirely)
    const lowerLabels = labels.map((l) => l.toLowerCase());
    const isSimpleBugFix = lowerLabels.some((label) =>
      BUG_LABELS.some((bugLabel) => label.includes(bugLabel)),
    );

    if (isSimpleBugFix) {
      // Simple bug fix: skip spec, go straight to exec → qa
      phases = ["exec", "qa"];
      console.log(chalk.gray(`    Bug fix detected: ${phases.join(" → ")}`));
    } else {
      // Run spec first to get recommended workflow
      console.log(chalk.gray(`    Running spec to determine workflow...`));

      // Create spinner for spec phase (1 of estimated 3: spec, exec, qa)
      const specSpinner = new PhaseSpinner({
        phase: "spec",
        phaseIndex: 1,
        totalPhases: 3, // Estimate; will be refined after spec
        shutdownManager,
      });
      specSpinner.start();

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
        config,
        sessionId,
        worktreePath, // Will be ignored for spec (non-isolated phase)
        shutdownManager,
        specSpinner,
      );
      const specEndTime = new Date();

      if (specResult.sessionId) {
        sessionId = specResult.sessionId;
        // Update session ID in state for resume capability
        if (stateManager) {
          try {
            await stateManager.updateSessionId(
              issueNumber,
              specResult.sessionId,
            );
          } catch {
            // State tracking errors shouldn't stop execution
          }
        }
      }

      phaseResults.push(specResult);
      specAlreadyRan = true;

      // Log spec phase result
      // Note: Spec runs in main repo, not worktree, so no git diff stats
      if (logWriter) {
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
          { error: specResult.error },
        );
        logWriter.logPhase(phaseLog);
      }

      // Track spec phase completion in state
      if (stateManager) {
        try {
          const phaseStatus = specResult.success ? "completed" : "failed";
          await stateManager.updatePhaseStatus(
            issueNumber,
            "spec",
            phaseStatus,
            {
              error: specResult.error,
            },
          );
        } catch {
          // State tracking errors shouldn't stop execution
        }
      }

      if (!specResult.success) {
        specSpinner.fail(specResult.error);
        const durationSeconds = (Date.now() - startTime) / 1000;
        return {
          issueNumber,
          success: false,
          phaseResults,
          durationSeconds,
          loopTriggered: false,
        };
      }

      specSpinner.succeed();

      // Parse recommended workflow from spec output
      const parsedWorkflow = specResult.output
        ? parseRecommendedWorkflow(specResult.output)
        : null;

      if (parsedWorkflow) {
        // Remove spec from phases since we already ran it
        phases = parsedWorkflow.phases.filter((p) => p !== "spec");
        detectedQualityLoop = parsedWorkflow.qualityLoop;
        console.log(
          chalk.gray(
            `    Spec recommends: ${phases.join(" → ")}${detectedQualityLoop ? " (quality loop)" : ""}`,
          ),
        );
      } else {
        // Fall back to label-based detection
        console.log(
          chalk.yellow(
            `    Could not parse spec recommendation, using label-based detection`,
          ),
        );
        const detected = detectPhasesFromLabels(labels);
        phases = detected.phases.filter((p) => p !== "spec");
        detectedQualityLoop = detected.qualityLoop;
        console.log(chalk.gray(`    Fallback: ${phases.join(" → ")}`));
      }
    }
  } else {
    // Use explicit phases with adjustments
    phases = determinePhasesForIssue(config.phases, labels, options);
    if (phases.length !== config.phases.length) {
      console.log(chalk.gray(`    Phases adjusted: ${phases.join(" → ")}`));
    }
  }

  // Resume: filter out completed phases if --resume flag is set
  if (options.resume) {
    const resumeResult = filterResumedPhases(issueNumber, phases, true);
    if (resumeResult.skipped.length > 0) {
      console.log(
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
      console.log(chalk.gray(`    Resume: all phases already completed`));
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

  let iteration = 0;
  const useQualityLoop = config.qualityLoop || detectedQualityLoop;
  const maxIterations = useQualityLoop ? config.maxIterations : 1;
  let completedSuccessfully = false;

  while (iteration < maxIterations) {
    iteration++;

    if (useQualityLoop && iteration > 1) {
      console.log(
        chalk.yellow(
          `    Quality loop iteration ${iteration}/${maxIterations}`,
        ),
      );
      loopTriggered = true;
    }

    let phasesFailed = false;

    // Calculate total phases for progress indicator
    // If spec already ran in auto-detect mode, it's counted separately
    const totalPhases = specAlreadyRan ? phases.length + 1 : phases.length;
    const phaseIndexOffset = specAlreadyRan ? 1 : 0;

    for (let phaseIdx = 0; phaseIdx < phases.length; phaseIdx++) {
      const phase = phases[phaseIdx];
      const phaseNumber = phaseIdx + 1 + phaseIndexOffset;

      // Create spinner for this phase
      const spinner = new PhaseSpinner({
        phase,
        phaseIndex: phaseNumber,
        totalPhases,
        shutdownManager,
      });
      spinner.start();

      // Track phase start in state
      if (stateManager) {
        try {
          await stateManager.updatePhaseStatus(
            issueNumber,
            phase,
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
        config,
        sessionId,
        worktreePath,
        shutdownManager,
        spinner,
      );
      const phaseEndTime = new Date();

      // Update session ID if we got one
      if (result.sessionId) {
        sessionId = result.sessionId;
        // Update session ID in state for resume capability
        if (stateManager) {
          try {
            await stateManager.updateSessionId(issueNumber, result.sessionId);
          } catch {
            // State tracking errors shouldn't stop execution
          }
        }
      }

      // Log phase result with observability data (AC-1, AC-2, AC-3, AC-7)
      if (logWriter) {
        // Capture git diff stats for worktree phases (AC-1, AC-3)
        const gitDiffStats = worktreePath
          ? getGitDiffStats(worktreePath)
          : undefined;

        // Capture commit hash after phase (AC-2)
        const commitHash = worktreePath
          ? getCommitHash(worktreePath)
          : undefined;

        // Read cache metrics for QA phase (AC-7)
        const cacheMetrics =
          phase === "qa" ? readCacheMetrics(worktreePath) : undefined;

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
            verdict: result.verdict,
            // Observability fields (AC-1, AC-2, AC-3, AC-7)
            filesModified: gitDiffStats?.filesModified,
            fileDiffStats: gitDiffStats?.fileDiffStats,
            commitHash,
            cacheMetrics,
          },
        );
        logWriter.logPhase(phaseLog);
      }

      // Track phase completion in state
      if (stateManager) {
        try {
          const phaseStatus = result.success ? "completed" : "failed";
          await stateManager.updatePhaseStatus(
            issueNumber,
            phase,
            phaseStatus,
            {
              error: result.error,
            },
          );
        } catch {
          // State tracking errors shouldn't stop execution
        }
      }

      phaseResults.push(result);

      if (!result.success) {
        spinner.fail(result.error);
        phasesFailed = true;
        break;
      }

      spinner.succeed();
    }

    if (!phasesFailed) {
      // Check if QA passed
      const qaResult = phaseResults.find((r) => r.phase === "qa");
      if (qaResult?.success) {
        completedSuccessfully = true;
        break; // Exit quality loop on success
      }

      // QA didn't pass but phases completed - might need another iteration
      if (useQualityLoop && iteration < maxIterations) {
        // Run loop phase to analyze failures and prepare for next iteration
        console.log(
          chalk.yellow(`    QA not passed, running loop analysis...`),
        );

        const loopSpinner = new PhaseSpinner({
          phase: "loop",
          phaseIndex: totalPhases + 1,
          totalPhases: totalPhases + 1,
          shutdownManager,
        });
        loopSpinner.start();

        const loopResult = await executePhaseWithRetry(
          issueNumber,
          "loop",
          config,
          sessionId,
          worktreePath,
          shutdownManager,
          loopSpinner,
        );

        if (loopResult.sessionId) {
          sessionId = loopResult.sessionId;
        }

        phaseResults.push(loopResult);

        if (!loopResult.success) {
          loopSpinner.fail(loopResult.error);
          break;
        }

        loopSpinner.succeed();
        loopTriggered = true;
      }
    } else {
      // Phases failed - exit loop
      break;
    }
  }

  const durationSeconds = (Date.now() - startTime) / 1000;

  // Calculate final result
  const qaResult = phaseResults.find((r) => r.phase === "qa");
  const qaPassedCleanly =
    qaResult?.success &&
    (qaResult.verdict === "READY_FOR_MERGE" ||
      qaResult.verdict === "NEEDS_VERIFICATION");

  // Handle post-QA operations in chain mode or when QA passes
  let prNumber: number | undefined;
  let prUrl: string | undefined;

  if (qaPassedCleanly && worktreePath && branch) {
    // Chain mode: create checkpoint commit for recovery
    if (chainMode) {
      createCheckpointCommit(worktreePath, issueNumber, config.verbose);
    }

    // Rebase before PR (unless disabled)
    // AC-1: Non-chain mode rebases onto origin/main before PR
    // AC-2: Chain mode rebases only the final branch onto origin/main before PR
    //        (intermediate branches must stay based on their predecessor)
    const shouldRebase = !options.noRebase && (!chainMode || isLastInChain);
    if (shouldRebase) {
      const rebaseResult = rebaseBeforePR(
        worktreePath,
        issueNumber,
        packageManager,
        config.verbose,
      );

      if (!rebaseResult.success && config.verbose) {
        console.log(
          chalk.yellow(`    ⚠️  Rebase issue: ${rebaseResult.error}`),
        );
      }
    }

    // Create PR (unless disabled)
    if (!options.noPr) {
      const prResult = createPR(
        worktreePath,
        issueNumber,
        issueTitle,
        branch,
        config.verbose,
        labels,
      );

      if (prResult.success) {
        prNumber = prResult.prNumber;
        prUrl = prResult.prUrl;
      } else if (config.verbose && prResult.error) {
        console.log(chalk.yellow(`    ⚠️  PR creation: ${prResult.error}`));
      }
    }
  }

  // Display summary
  const statusIcon = completedSuccessfully ? chalk.green("✓") : chalk.red("✗");
  const duration = formatDuration(durationSeconds);
  const loopInfo = loopTriggered
    ? chalk.yellow(` [${iteration} iterations]`)
    : "";

  console.log(
    chalk.blue(
      `\n  ${statusIcon} Issue #${issueNumber} completed in ${duration}${loopInfo}`,
    ),
  );

  return {
    issueNumber,
    success: completedSuccessfully,
    phaseResults,
    loopTriggered,
    durationSeconds,
    prNumber,
    prUrl,
  };
}
