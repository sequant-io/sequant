/**
 * State manager for persistent workflow state tracking
 *
 * Provides CRUD operations for tracking issue progress through workflow phases.
 * Uses atomic writes (temp file + rename) to prevent corruption.
 *
 * @example
 * ```typescript
 * import { StateManager } from './state-manager';
 *
 * const manager = new StateManager();
 *
 * // Initialize a new issue
 * await manager.initializeIssue(42, "Add user auth", { worktree: "/path/to/worktree" });
 *
 * // Update phase status
 * await manager.updatePhaseStatus(42, "exec", "in_progress");
 *
 * // Get issue state
 * const state = await manager.getIssueState(42);
 * ```
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  type WorkflowState,
  type IssueState,
  type Phase,
  type PhaseStatus,
  type IssueStatus,
  type PRInfo,
  WorkflowStateSchema,
  STATE_FILE_PATH,
  createEmptyState,
  createIssueState,
  createPhaseState,
} from "./state-schema.js";

export interface StateManagerOptions {
  /** Path to state file (default: .sequant/state.json) */
  statePath?: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Manages persistent workflow state
 */
export class StateManager {
  private statePath: string;
  private verbose: boolean;
  private cachedState: WorkflowState | null = null;

  constructor(options: StateManagerOptions = {}) {
    this.statePath = options.statePath ?? STATE_FILE_PATH;
    this.verbose = options.verbose ?? false;
  }

  /**
   * Get the full path to the state file
   */
  getStatePath(): string {
    return this.statePath;
  }

  /**
   * Read the current workflow state
   *
   * Returns empty state if file doesn't exist.
   * Throws on parse errors.
   */
  async getState(): Promise<WorkflowState> {
    // Return cached state if available
    if (this.cachedState) {
      return this.cachedState;
    }

    if (!fs.existsSync(this.statePath)) {
      const emptyState = createEmptyState();
      this.cachedState = emptyState;
      return emptyState;
    }

    try {
      const content = fs.readFileSync(this.statePath, "utf-8");
      const parsed = JSON.parse(content);
      const state = WorkflowStateSchema.parse(parsed);
      this.cachedState = state;
      return state;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in state file: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Write state to disk using atomic write
   *
   * Writes to a temp file first, then renames to prevent corruption
   * if the process is interrupted during write.
   */
  async saveState(state: WorkflowState): Promise<void> {
    // Validate before writing
    WorkflowStateSchema.parse(state);

    // Update lastUpdated timestamp
    state.lastUpdated = new Date().toISOString();

    // Ensure directory exists
    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write to temp file first (atomic write pattern)
    const tempPath = path.join(
      os.tmpdir(),
      `sequant-state-${Date.now()}-${process.pid}.json`,
    );

    try {
      fs.writeFileSync(tempPath, JSON.stringify(state, null, 2));

      // Rename temp file to actual path (atomic on most systems)
      fs.renameSync(tempPath, this.statePath);

      // Update cache
      this.cachedState = state;

      if (this.verbose) {
        console.log(`📊 State saved: ${this.statePath}`);
      }
    } catch (error) {
      // Clean up temp file on error
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      throw error;
    }
  }

  /**
   * Clear the cached state (forces re-read on next access)
   */
  clearCache(): void {
    this.cachedState = null;
  }

  // === Issue Operations ===

  /**
   * Get state for a specific issue
   */
  async getIssueState(issueNumber: number): Promise<IssueState | null> {
    const state = await this.getState();
    return state.issues[String(issueNumber)] ?? null;
  }

  /**
   * Get all issue states
   */
  async getAllIssueStates(): Promise<Record<number, IssueState>> {
    const state = await this.getState();
    const result: Record<number, IssueState> = {};
    for (const [key, value] of Object.entries(state.issues)) {
      result[parseInt(key, 10)] = value;
    }
    return result;
  }

  /**
   * Get the current phase for an issue
   */
  async getCurrentPhase(issueNumber: number): Promise<Phase | null> {
    const issueState = await this.getIssueState(issueNumber);
    return issueState?.currentPhase ?? null;
  }

  /**
   * Initialize tracking for a new issue
   */
  async initializeIssue(
    issueNumber: number,
    title: string,
    options?: {
      worktree?: string;
      branch?: string;
      qualityLoop?: boolean;
      maxIterations?: number;
    },
  ): Promise<void> {
    const state = await this.getState();

    // Create new issue state
    const issueState = createIssueState(issueNumber, title, options);

    state.issues[String(issueNumber)] = issueState;

    await this.saveState(state);

    if (this.verbose) {
      console.log(`📊 Initialized issue #${issueNumber}: ${title}`);
    }
  }

  /**
   * Update the status of a specific phase
   */
  async updatePhaseStatus(
    issueNumber: number,
    phase: Phase,
    status: PhaseStatus,
    options?: {
      error?: string;
      iteration?: number;
    },
  ): Promise<void> {
    const state = await this.getState();
    const issueState = state.issues[String(issueNumber)];

    if (!issueState) {
      throw new Error(`Issue #${issueNumber} not found in state`);
    }

    // Update phase state
    const phaseState = createPhaseState(status);

    if (status === "completed" || status === "failed" || status === "skipped") {
      phaseState.completedAt = new Date().toISOString();
    }

    if (options?.error) {
      phaseState.error = options.error;
    }

    if (options?.iteration !== undefined) {
      phaseState.iteration = options.iteration;
    }

    // Preserve startedAt if already set
    const existingPhase = issueState.phases[phase];
    if (existingPhase?.startedAt && status !== "pending") {
      phaseState.startedAt = existingPhase.startedAt;
    }

    issueState.phases[phase] = phaseState;
    issueState.currentPhase = phase;
    issueState.lastActivity = new Date().toISOString();

    // Update issue status based on phase status
    if (status === "in_progress" && issueState.status === "not_started") {
      issueState.status = "in_progress";
    }

    await this.saveState(state);

    if (this.verbose) {
      console.log(`📊 Phase ${phase} → ${status} for issue #${issueNumber}`);
    }
  }

  /**
   * Update the overall issue status
   */
  async updateIssueStatus(
    issueNumber: number,
    status: IssueStatus,
  ): Promise<void> {
    const state = await this.getState();
    const issueState = state.issues[String(issueNumber)];

    if (!issueState) {
      throw new Error(`Issue #${issueNumber} not found in state`);
    }

    issueState.status = status;
    issueState.lastActivity = new Date().toISOString();

    await this.saveState(state);

    if (this.verbose) {
      console.log(`📊 Issue #${issueNumber} status → ${status}`);
    }
  }

  /**
   * Update PR information for an issue
   */
  async updatePRInfo(issueNumber: number, pr: PRInfo): Promise<void> {
    const state = await this.getState();
    const issueState = state.issues[String(issueNumber)];

    if (!issueState) {
      throw new Error(`Issue #${issueNumber} not found in state`);
    }

    issueState.pr = pr;
    issueState.lastActivity = new Date().toISOString();

    await this.saveState(state);

    if (this.verbose) {
      console.log(`📊 PR #${pr.number} linked to issue #${issueNumber}`);
    }
  }

  /**
   * Update worktree information for an issue
   */
  async updateWorktreeInfo(
    issueNumber: number,
    worktree: string,
    branch: string,
  ): Promise<void> {
    const state = await this.getState();
    const issueState = state.issues[String(issueNumber)];

    if (!issueState) {
      throw new Error(`Issue #${issueNumber} not found in state`);
    }

    issueState.worktree = worktree;
    issueState.branch = branch;
    issueState.lastActivity = new Date().toISOString();

    await this.saveState(state);

    if (this.verbose) {
      console.log(`📊 Worktree updated for issue #${issueNumber}: ${worktree}`);
    }
  }

  /**
   * Update session ID for an issue (for resume)
   */
  async updateSessionId(issueNumber: number, sessionId: string): Promise<void> {
    const state = await this.getState();
    const issueState = state.issues[String(issueNumber)];

    if (!issueState) {
      throw new Error(`Issue #${issueNumber} not found in state`);
    }

    issueState.sessionId = sessionId;
    issueState.lastActivity = new Date().toISOString();

    await this.saveState(state);
  }

  /**
   * Update loop iteration for an issue
   */
  async updateLoopIteration(
    issueNumber: number,
    iteration: number,
  ): Promise<void> {
    const state = await this.getState();
    const issueState = state.issues[String(issueNumber)];

    if (!issueState) {
      throw new Error(`Issue #${issueNumber} not found in state`);
    }

    if (issueState.loop) {
      issueState.loop.iteration = iteration;
    }
    issueState.lastActivity = new Date().toISOString();

    await this.saveState(state);

    if (this.verbose) {
      console.log(`📊 Loop iteration ${iteration} for issue #${issueNumber}`);
    }
  }

  /**
   * Remove an issue from state
   */
  async removeIssue(issueNumber: number): Promise<void> {
    const state = await this.getState();

    if (!state.issues[String(issueNumber)]) {
      return; // Already removed
    }

    delete state.issues[String(issueNumber)];

    await this.saveState(state);

    if (this.verbose) {
      console.log(`📊 Removed issue #${issueNumber} from state`);
    }
  }

  // === Utility Operations ===

  /**
   * Check if state file exists
   */
  stateExists(): boolean {
    return fs.existsSync(this.statePath);
  }

  /**
   * Get issues in a specific status
   */
  async getIssuesByStatus(status: IssueStatus): Promise<IssueState[]> {
    const allStates = await this.getAllIssueStates();
    return Object.values(allStates).filter((s) => s.status === status);
  }

  /**
   * Get issues currently in progress
   */
  async getInProgressIssues(): Promise<IssueState[]> {
    return this.getIssuesByStatus("in_progress");
  }

  /**
   * Get issues ready for merge
   */
  async getReadyForMergeIssues(): Promise<IssueState[]> {
    return this.getIssuesByStatus("ready_for_merge");
  }
}

// Export a default instance for convenience
let defaultManager: StateManager | null = null;

/**
 * Get the default state manager instance
 */
export function getStateManager(options?: StateManagerOptions): StateManager {
  if (!defaultManager || options) {
    defaultManager = new StateManager(options);
  }
  return defaultManager;
}

/**
 * Reset the default state manager (for testing)
 */
export function resetStateManager(): void {
  defaultManager = null;
}
