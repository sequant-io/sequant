/**
 * State utilities for rebuilding and cleaning up workflow state
 *
 * This module re-exports focused utilities from dedicated modules:
 * - pr-status: PR merge detection and branch status
 * - state-rebuild: State reconstruction from run logs
 * - worktree-discovery: Worktree discovery for state bootstrapping
 * - state-cleanup: Cleanup of stale entries and startup reconciliation
 *
 * @example
 * ```typescript
 * import { rebuildStateFromLogs, cleanupStaleEntries } from './state-utils';
 *
 * // Rebuild state from run logs
 * await rebuildStateFromLogs();
 *
 * // Clean up orphaned entries
 * const result = await cleanupStaleEntries({ dryRun: true });
 * ```
 */

// Re-export PR status detection
export type { PRMergeStatus } from "./pr-status.js";
export {
  checkPRMergeStatus,
  isBranchMergedIntoMain,
  isIssueMergedIntoMain,
} from "./pr-status.js";

// Re-export state rebuild
export type { RebuildOptions, RebuildResult } from "./state-rebuild.js";
export { rebuildStateFromLogs } from "./state-rebuild.js";

// Re-export worktree discovery
export type {
  DiscoverOptions,
  DiscoveredWorktree,
  SkippedWorktree,
  DiscoverResult,
} from "./worktree-discovery.js";
export { discoverUntrackedWorktrees } from "./worktree-discovery.js";

// Re-export state cleanup
export type {
  CleanupOptions,
  CleanupResult,
  ReconcileOptions,
  ReconcileResult,
} from "./state-cleanup.js";
export {
  cleanupStaleEntries,
  reconcileStateAtStartup,
} from "./state-cleanup.js";
