/**
 * Core types for workflow execution
 */

import { z } from "zod";
import type { AiderSettings } from "../settings.js";
import type { LogWriter } from "./log-writer.js";
import type { StateManager } from "./state-manager.js";
import type { ShutdownManager } from "../shutdown.js";
import type { WorktreeInfo } from "./worktree-manager.js";

/**
 * Canonical Zod schema for all workflow phases.
 *
 * This is the single source of truth — state-schema.ts and run-log-schema.ts
 * both reference this definition. Add new phases here only.
 */
export const PhaseSchema = z.enum([
  "spec",
  "security-review",
  "exec",
  "testgen",
  "test",
  "verify",
  "qa",
  "loop",
  "merger",
]);

/**
 * Available workflow phases (inferred from PhaseSchema)
 */
export type Phase = z.infer<typeof PhaseSchema>;

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
  /**
   * Isolate parallel agent groups in separate worktrees.
   * When true, each agent in a parallel group gets its own sub-worktree.
   * Resolution priority: CLI flag → settings.agents.isolateParallel → false
   */
  isolateParallel?: boolean;
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
 */
export type ProgressCallback = (
  issue: number,
  phase: string,
  event: "start" | "complete" | "failed",
  extra?: { durationSeconds?: number; error?: string },
) => void;

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
  };
  /** Package manager name (e.g., "npm", "pnpm") */
  packageManager?: string;
  /** Base branch for rebase/PR (e.g., "main") */
  baseBranch?: string;
  /** Per-phase progress callback (used in parallel mode) */
  onProgress?: ProgressCallback;
}
