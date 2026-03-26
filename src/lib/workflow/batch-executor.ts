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
import { LogWriter, createPhaseLogFromTiming } from "./log-writer.js";
import { StateManager } from "./state-manager.js";
import { Phase, ExecutionConfig, PhaseResult, IssueResult } from "./types.js";
import { classifyError } from "./error-classifier.js";
import type { ErrorContext } from "./run-log-schema.js";
import { ShutdownManager } from "../shutdown.js";
import { PhaseSpinner } from "../phase-spinner.js";
import { getGitDiffStats, getCommitHash } from "./git-diff-utils.js";
import type { WorktreeInfo } from "./worktree-manager.js";
import {
  createCheckpointCommit,
  rebaseBeforePR,
  createPR,
  readCacheMetrics,
  filterResumedPhases,
} from "./worktree-manager.js";
import { executePhaseWithRetry } from "./phase-executor.js";
import {
  detectPhasesFromLabels,
  parseRecommendedWorkflow,
  determinePhasesForIssue,
  BUG_LABELS,
} from "./phase-mapper.js";

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
export function emitProgressLine(
  issue: number,
  phase: string,
  event: "start" | "complete" | "failed" = "start",
  extra?: { durationSeconds?: number; error?: string },
): void {
  if (!process.env.SEQUANT_ORCHESTRATOR) return;
  const payload: Record<string, unknown> = { issue, phase, event };
  if (extra?.durationSeconds !== undefined) {
    payload.durationSeconds = extra.durationSeconds;
  }
  if (extra?.error !== undefined) {
    payload.error = extra.error;
  }
  const line = `SEQUANT_PROGRESS:${JSON.stringify(payload)}\n`;
  process.stderr.write(line);
}

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
  /** Enable automatic worktree creation for issue isolation */
  worktreeIsolation?: boolean;
  /** Reuse existing worktrees instead of creating new ones */
  reuseWorktrees?: boolean;
  /** Suppress version warnings and non-essential output */
  quiet?: boolean;
  /** Chain issues: each branches from previous (requires --sequential) */
  chain?: boolean;
  /**
   * Wait for QA pass before starting next issue in chain mode.
   * When enabled, the chain pauses if QA fails, preventing downstream issues
   * from building on potentially broken code.
   */
  qaGate?: boolean;
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
   * Bypasses the pre-flight state guard that skips ready_for_merge/merged issues.
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

    // Parse from body: "Depends on: #123" or "**Depends on**: #123"
    if (data.body) {
      const bodyMatch = data.body.match(
        /\*?\*?depends\s+on\*?\*?:?\s*#?(\d+)/gi,
      );
      if (bodyMatch) {
        for (const match of bodyMatch) {
          const numMatch = match.match(/(\d+)/);
          if (numMatch) {
            dependencies.push(parseInt(numMatch[1], 10));
          }
        }
      }
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

  return config;
}

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
  baseBranch?: string,
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
      undefined,
      baseBranch,
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
  baseBranch?: string,
): Promise<IssueResult> {
  const startTime = Date.now();
  const phaseResults: PhaseResult[] = [];
  let loopTriggered = false;
  let sessionId: string | undefined;

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
        log(chalk.yellow(`    ⚠️  State tracking error: ${error}`));
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
      log(chalk.gray(`    Bug fix detected: ${phases.join(" → ")}`));
    } else {
      // Run spec first to get recommended workflow
      log(chalk.gray(`    Running spec to determine workflow...`));

      // Create spinner for spec phase (suppressed in parallel mode to prevent interleaving)
      const specSpinner = config.parallel
        ? undefined
        : new PhaseSpinner({
            phase: "spec",
            phaseIndex: 1,
            totalPhases: 3, // Estimate; will be refined after spec
            shutdownManager,
          });
      specSpinner?.start();
      emitProgressLine(issueNumber, "spec", "start");

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

      // Emit completion/failure progress event (AC-8)
      const specDurationSec = Math.round(
        (specEndTime.getTime() - specStartTime.getTime()) / 1000,
      );
      if (specResult.success) {
        emitProgressLine(issueNumber, "spec", "complete", {
          durationSeconds: specDurationSec,
        });
      } else {
        emitProgressLine(issueNumber, "spec", "failed", {
          error: specResult.error ?? "unknown",
        });
      }

      // Log spec phase result
      // Note: Spec runs in main repo, not worktree, so no git diff stats
      if (logWriter) {
        // Build errorContext from captured stderr/stdout tails (#447)
        let specErrorContext: ErrorContext | undefined;
        if (!specResult.success && specResult.stderrTail) {
          specErrorContext = {
            stderrTail: specResult.stderrTail ?? [],
            stdoutTail: specResult.stdoutTail ?? [],
            category: classifyError(specResult.stderrTail ?? []),
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
          { error: specResult.error, errorContext: specErrorContext },
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
        specSpinner?.fail(specResult.error);
        const durationSeconds = (Date.now() - startTime) / 1000;
        return {
          issueNumber,
          success: false,
          phaseResults,
          durationSeconds,
          loopTriggered: false,
        };
      }

      specSpinner?.succeed();

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

  let iteration = 0;
  const useQualityLoop = config.qualityLoop || detectedQualityLoop;
  const maxIterations = useQualityLoop ? config.maxIterations : 1;
  let completedSuccessfully = false;

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

    // Calculate total phases for progress indicator
    // If spec already ran in auto-detect mode, it's counted separately
    const totalPhases = specAlreadyRan ? phases.length + 1 : phases.length;
    const phaseIndexOffset = specAlreadyRan ? 1 : 0;

    for (let phaseIdx = 0; phaseIdx < phases.length; phaseIdx++) {
      const phase = phases[phaseIdx];
      const phaseNumber = phaseIdx + 1 + phaseIndexOffset;

      // Create spinner for this phase (suppressed in parallel mode)
      const phaseSpinner = config.parallel
        ? undefined
        : new PhaseSpinner({
            phase,
            phaseIndex: phaseNumber,
            totalPhases,
            shutdownManager,
            iteration: useQualityLoop ? iteration : undefined,
          });
      phaseSpinner?.start();
      emitProgressLine(issueNumber, phase, "start");

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
        config,
        sessionId,
        worktreePath,
        shutdownManager,
        phaseSpinner,
      );
      const phaseEndTime = new Date();

      // Capture session ID for subsequent phases
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

      phaseResults.push(result);

      // Emit completion/failure progress event (AC-8)
      const phaseDurationSec = Math.round(
        (phaseEndTime.getTime() - phaseStartTime.getTime()) / 1000,
      );
      if (result.success) {
        emitProgressLine(issueNumber, phase, "complete", {
          durationSeconds: phaseDurationSec,
        });
      } else {
        emitProgressLine(issueNumber, phase, "failed", {
          error: result.error ?? "unknown",
        });
      }

      // Log phase result with observability data (AC-1, AC-2, AC-3, AC-7)
      if (logWriter) {
        // Capture git diff stats for worktree phases (AC-1, AC-3)
        const diffStats = worktreePath
          ? getGitDiffStats(worktreePath, baseBranch)
          : undefined;

        // Capture commit hash after phase (AC-2)
        const commitHash = worktreePath
          ? getCommitHash(worktreePath)
          : undefined;

        // Read cache metrics for QA phase (AC-7)
        const cacheMetrics =
          phase === "qa" ? readCacheMetrics(worktreePath) : undefined;

        // Build errorContext from captured stderr/stdout tails (#447)
        let errorContext: ErrorContext | undefined;
        if (!result.success && result.stderrTail) {
          errorContext = {
            stderrTail: result.stderrTail ?? [],
            stdoutTail: result.stdoutTail ?? [],
            category: classifyError(result.stderrTail ?? []),
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
            verdict: result.verdict,
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
            { error: result.error },
          );
        } catch {
          // State tracking errors shouldn't stop execution
        }
      }

      if (result.success) {
        phaseSpinner?.succeed();
      } else {
        phaseSpinner?.fail(result.error);
        phasesFailed = true;

        // If quality loop enabled, run loop phase to fix issues
        if (useQualityLoop && iteration < maxIterations) {
          // Create spinner for loop phase (suppressed in parallel mode)
          const loopSpinner = config.parallel
            ? undefined
            : new PhaseSpinner({
                phase: "loop",
                phaseIndex: phaseNumber,
                totalPhases,
                shutdownManager,
                iteration,
              });
          loopSpinner?.start();
          emitProgressLine(issueNumber, "loop", "start");

          const loopStartTime = new Date();
          const loopResult = await executePhaseWithRetry(
            issueNumber,
            "loop",
            config,
            sessionId,
            worktreePath,
            shutdownManager,
            loopSpinner,
          );
          const loopEndTime = new Date();
          phaseResults.push(loopResult);

          // Emit loop completion/failure progress event (AC-8)
          const loopDurationSec = Math.round(
            (loopEndTime.getTime() - loopStartTime.getTime()) / 1000,
          );
          if (loopResult.success) {
            emitProgressLine(issueNumber, "loop", "complete", {
              durationSeconds: loopDurationSec,
            });
          } else {
            emitProgressLine(issueNumber, "loop", "failed", {
              error: loopResult.error ?? "unknown",
            });
          }

          if (loopResult.sessionId) {
            sessionId = loopResult.sessionId;
          }

          if (loopResult.success) {
            loopSpinner?.succeed();
            // Continue to next iteration
            break;
          } else {
            loopSpinner?.fail(loopResult.error);
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

    // If we're not in quality loop mode, don't retry
    if (!config.qualityLoop) {
      break;
    }
  }

  const durationSeconds = (Date.now() - startTime) / 1000;
  // Success is determined by whether all phases completed in any iteration,
  // not whether all accumulated phase results passed (which would fail after loop recovery)
  const success = completedSuccessfully;

  // Update final issue status in state
  if (stateManager) {
    try {
      const finalStatus = success ? "ready_for_merge" : "in_progress";
      await stateManager.updateIssueStatus(issueNumber, finalStatus);
    } catch {
      // State tracking errors shouldn't stop execution
    }
  }

  // Create checkpoint commit in chain mode after QA passes
  if (success && chainMode && worktreePath) {
    createCheckpointCommit(worktreePath, issueNumber, config.verbose);
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
  const shouldCreatePR = success && worktreePath && branch && !options.noPr;
  if (shouldCreatePR) {
    const prResult = createPR(
      worktreePath,
      issueNumber,
      issueTitle,
      branch,
      config.verbose,
      labels,
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
    }
  }

  return {
    issueNumber,
    success,
    phaseResults,
    durationSeconds,
    loopTriggered,
    prNumber,
    prUrl,
  };
}
