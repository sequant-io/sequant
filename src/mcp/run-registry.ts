/**
 * Active run registry for MCP server
 *
 * Tracks which workflow runs are currently active so that
 * sequant_status can report isRunning state in real time.
 *
 * Module-level singleton — all tools in the same process share one registry.
 */

export interface ActiveRun {
  startedAt: string;
}

const activeRuns = new Map<number, ActiveRun>();

/**
 * Register an active run for an issue.
 * If a run is already registered for this issue, it is replaced.
 */
export function registerRun(issue: number): void {
  activeRuns.set(issue, { startedAt: new Date().toISOString() });
}

/**
 * Unregister a run for an issue (called on process exit/error/abort).
 */
export function unregisterRun(issue: number): void {
  activeRuns.delete(issue);
}

/**
 * Check if a run is currently active for the given issue.
 * Returns false for untracked issues.
 */
export function isRunning(issue: number): boolean {
  return activeRuns.has(issue);
}

/**
 * Get info about all currently active runs.
 */
export function getActiveRuns(): ReadonlyMap<number, ActiveRun> {
  return activeRuns;
}

/**
 * Clear all active runs. Intended for testing only.
 * @internal
 */
export function clearRegistry(): void {
  activeRuns.clear();
}
