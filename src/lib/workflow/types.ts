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
  /** Force parallel even with dependencies */
  forceParallel: boolean;
  /** Verbose output */
  verbose: boolean;
  /** Disable smart test detection */
  noSmartTests: boolean;
  /** Dry run mode - don't actually execute */
  dryRun: boolean;
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
  forceParallel: false,
  verbose: false,
  noSmartTests: false,
  dryRun: false,
};

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
