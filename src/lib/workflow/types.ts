/**
 * Core types for workflow execution
 */

/**
 * Available workflow phases
 */
export type Phase =
  | "spec"
  | "security-review"
  | "testgen"
  | "exec"
  | "test"
  | "qa"
  | "loop";

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
   * Aider-specific configuration. Passed to AiderDriver when agent is "aider".
   */
  aiderSettings?: AiderSettings;
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

// Import and re-export QaVerdict from run-log-schema (single source of truth)
import type { AiderSettings } from "../settings.js";
import type { QaVerdict } from "./run-log-schema.js";
export type { QaVerdict } from "./run-log-schema.js";

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
