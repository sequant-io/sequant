/**
 * Backward-compatible re-exports from run.ts.
 *
 * Consumers that import workflow utilities from "commands/run" continue to work.
 * New code should import directly from the source modules.
 */

export { normalizeCommanderOptions } from "../lib/workflow/config-resolver.js";
export {
  parseQaVerdict,
  formatDuration,
  executePhaseWithRetry,
} from "../lib/workflow/phase-executor.js";
export {
  detectDefaultBranch,
  checkWorktreeFreshness,
  removeStaleWorktree,
  listWorktrees,
  getWorktreeChangedFiles,
  getWorktreeDiffStats,
  readCacheMetrics,
  filterResumedPhases,
  ensureWorktree,
  createCheckpointCommit,
  reinstallIfLockfileChanged,
  rebaseBeforePR,
  createPR,
} from "../lib/workflow/worktree-manager.js";
export type {
  WorktreeInfo,
  RebaseResult,
  PRCreationResult,
} from "../lib/workflow/worktree-manager.js";
export {
  detectPhasesFromLabels,
  parseRecommendedWorkflow,
  determinePhasesForIssue,
} from "../lib/workflow/phase-mapper.js";
export {
  getIssueInfo,
  sortByDependencies,
  parseBatches,
  getEnvConfig,
  executeBatch,
  runIssueWithLogging,
} from "../lib/workflow/batch-executor.js";
export type { RunOptions } from "../lib/workflow/types.js";
export { logNonFatalWarning } from "../lib/workflow/run-orchestrator.js";
