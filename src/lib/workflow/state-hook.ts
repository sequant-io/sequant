/**
 * State hook for skills running standalone
 *
 * Skills can use this utility to update workflow state when running outside
 * of the orchestrated `sequant run` context. When running orchestrated,
 * the orchestrator handles state updates.
 *
 * @example
 * ```typescript
 * import { createStateHook } from '../lib/workflow/state-hook';
 *
 * // In a skill entry point
 * const stateHook = createStateHook(issueNumber, issueTitle);
 *
 * // Update phase status
 * await stateHook.startPhase('exec');
 * // ... do work ...
 * await stateHook.completePhase('exec', true);
 * ```
 */

import { StateManager } from "./state-manager.js";
import type { Phase, PhaseStatus, IssueStatus } from "./state-schema.js";

/**
 * Check if running in orchestrated mode
 *
 * When SEQUANT_ORCHESTRATOR is set, state updates are handled by the orchestrator.
 */
export function isOrchestrated(): boolean {
  return !!process.env.SEQUANT_ORCHESTRATOR;
}

/**
 * Get the current orchestration context from environment
 */
export function getOrchestrationContext(): {
  orchestrator: string | undefined;
  phase: string | undefined;
  issue: number | undefined;
  worktree: string | undefined;
} {
  return {
    orchestrator: process.env.SEQUANT_ORCHESTRATOR,
    phase: process.env.SEQUANT_PHASE,
    issue: process.env.SEQUANT_ISSUE
      ? parseInt(process.env.SEQUANT_ISSUE, 10)
      : undefined,
    worktree: process.env.SEQUANT_WORKTREE,
  };
}

export interface StateHookOptions {
  /** Enable verbose logging */
  verbose?: boolean;
  /** Custom state path (for testing) */
  statePath?: string;
}

export interface StateHook {
  /** Whether state updates are active (standalone mode) */
  isActive: boolean;
  /** Start a phase (sets status to in_progress) */
  startPhase: (phase: Phase) => Promise<void>;
  /** Complete a phase (sets status to completed or failed) */
  completePhase: (
    phase: Phase,
    success: boolean,
    error?: string,
  ) => Promise<void>;
  /** Skip a phase (sets status to skipped) */
  skipPhase: (phase: Phase) => Promise<void>;
  /** Update the overall issue status */
  updateIssueStatus: (status: IssueStatus) => Promise<void>;
  /** Update session ID for resume capability */
  updateSessionId: (sessionId: string) => Promise<void>;
  /** Update PR info after PR creation */
  updatePRInfo: (prNumber: number, prUrl: string) => Promise<void>;
}

/**
 * Create a state hook for a skill
 *
 * In orchestrated mode, returns a no-op hook (orchestrator handles state).
 * In standalone mode, returns an active hook that updates state.
 *
 * @param issueNumber - GitHub issue number
 * @param issueTitle - Issue title (for initialization)
 * @param options - Hook configuration
 */
export function createStateHook(
  issueNumber: number,
  issueTitle: string,
  options?: StateHookOptions,
): StateHook {
  // In orchestrated mode, return no-op hook
  if (isOrchestrated()) {
    return createNoOpHook();
  }

  // In standalone mode, return active hook
  return createActiveHook(issueNumber, issueTitle, options);
}

/**
 * Create a no-op hook for orchestrated mode
 */
function createNoOpHook(): StateHook {
  const noOp = async () => {
    /* no-op */
  };

  return {
    isActive: false,
    startPhase: noOp,
    completePhase: noOp,
    skipPhase: noOp,
    updateIssueStatus: noOp,
    updateSessionId: noOp,
    updatePRInfo: noOp,
  };
}

/**
 * Create an active hook for standalone mode
 */
function createActiveHook(
  issueNumber: number,
  issueTitle: string,
  options?: StateHookOptions,
): StateHook {
  const manager = new StateManager({
    statePath: options?.statePath,
    verbose: options?.verbose,
  });

  // Initialize issue on first use
  let initialized = false;

  async function ensureInitialized(): Promise<void> {
    if (initialized) return;

    try {
      const existing = await manager.getIssueState(issueNumber);
      if (!existing) {
        await manager.initializeIssue(issueNumber, issueTitle, {
          worktree: process.env.SEQUANT_WORKTREE,
        });
      }
      initialized = true;
    } catch {
      // Silently ignore initialization errors
      initialized = true;
    }
  }

  return {
    isActive: true,

    async startPhase(phase: Phase): Promise<void> {
      try {
        await ensureInitialized();
        await manager.updatePhaseStatus(issueNumber, phase, "in_progress");
      } catch {
        // State errors shouldn't stop skill execution
      }
    },

    async completePhase(
      phase: Phase,
      success: boolean,
      error?: string,
    ): Promise<void> {
      try {
        await ensureInitialized();
        const status: PhaseStatus = success ? "completed" : "failed";
        await manager.updatePhaseStatus(issueNumber, phase, status, { error });
      } catch {
        // State errors shouldn't stop skill execution
      }
    },

    async skipPhase(phase: Phase): Promise<void> {
      try {
        await ensureInitialized();
        await manager.updatePhaseStatus(issueNumber, phase, "skipped");
      } catch {
        // State errors shouldn't stop skill execution
      }
    },

    async updateIssueStatus(status: IssueStatus): Promise<void> {
      try {
        await ensureInitialized();
        await manager.updateIssueStatus(issueNumber, status);
      } catch {
        // State errors shouldn't stop skill execution
      }
    },

    async updateSessionId(sessionId: string): Promise<void> {
      try {
        await ensureInitialized();
        await manager.updateSessionId(issueNumber, sessionId);
      } catch {
        // State errors shouldn't stop skill execution
      }
    },

    async updatePRInfo(prNumber: number, prUrl: string): Promise<void> {
      try {
        await ensureInitialized();
        await manager.updatePRInfo(issueNumber, {
          number: prNumber,
          url: prUrl,
        });
      } catch {
        // State errors shouldn't stop skill execution
      }
    },
  };
}
