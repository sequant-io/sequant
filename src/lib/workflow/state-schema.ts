/**
 * Zod schemas for persistent workflow state tracking
 *
 * These schemas define the structure of `.sequant/state.json` which tracks
 * the current state of all issues being processed through the workflow.
 *
 * @example
 * ```typescript
 * import { WorkflowStateSchema, type WorkflowState } from './state-schema';
 *
 * // Validate state file
 * const state = WorkflowStateSchema.parse(JSON.parse(stateContent));
 *
 * // Type-safe access
 * const issue42 = state.issues["42"];
 * console.log(issue42.currentPhase, issue42.status);
 * ```
 */

import { z } from "zod";
import { ScopeAssessmentSchema } from "../scope/types.js";

/**
 * Workflow phases in order of execution
 */
export const WORKFLOW_PHASES = [
  "spec",
  "security-review",
  "exec",
  "testgen",
  "test",
  "verify",
  "qa",
  "loop",
  "merger",
] as const;

/**
 * Phase status - tracks individual phase progress
 */
export const PhaseStatusSchema = z.enum([
  "pending", // Phase not yet started
  "in_progress", // Phase currently executing
  "completed", // Phase finished successfully
  "failed", // Phase finished with errors
  "skipped", // Phase intentionally skipped (e.g., bug labels skip spec)
]);

export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;

/**
 * Issue status - tracks overall issue progress
 */
export const IssueStatusSchema = z.enum([
  "not_started", // Issue tracked but no work begun
  "in_progress", // Actively being worked on
  "waiting_for_qa_gate", // QA completed, waiting for gate approval in chain mode
  "ready_for_merge", // All phases passed, PR ready for review
  "merged", // PR merged, work complete
  "blocked", // Waiting on external input or dependency
  "abandoned", // Work stopped, will not continue
]);

export type IssueStatus = z.infer<typeof IssueStatusSchema>;

/**
 * Phase type
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

export type Phase = z.infer<typeof PhaseSchema>;

/**
 * Phase marker stored in GitHub issue comments for cross-session detection.
 *
 * Embedded as HTML comments: `<!-- SEQUANT_PHASE: {...} -->`
 */
export const PhaseMarkerSchema = z.object({
  /** The workflow phase */
  phase: PhaseSchema,
  /** Phase completion status */
  status: PhaseStatusSchema,
  /** ISO 8601 timestamp */
  timestamp: z.string().datetime(),
  /** PR number if created during this phase */
  pr: z.number().int().positive().optional(),
  /** Error message if phase failed */
  error: z.string().optional(),
});

export type PhaseMarker = z.infer<typeof PhaseMarkerSchema>;

/**
 * Individual phase state within an issue
 */
export const PhaseStateSchema = z.object({
  /** Current status of the phase */
  status: PhaseStatusSchema,
  /** When the phase started (if started) */
  startedAt: z.string().datetime().optional(),
  /** When the phase completed (if completed/failed/skipped) */
  completedAt: z.string().datetime().optional(),
  /** Error message if phase failed */
  error: z.string().optional(),
  /** Number of loop iterations (for loop phase) */
  iteration: z.number().int().nonnegative().optional(),
});

export type PhaseState = z.infer<typeof PhaseStateSchema>;

/**
 * PR information for an issue
 */
export const PRInfoSchema = z.object({
  /** PR number */
  number: z.number().int().positive(),
  /** PR URL */
  url: z.string().url(),
});

export type PRInfo = z.infer<typeof PRInfoSchema>;

/**
 * Quality loop state
 */
export const LoopStateSchema = z.object({
  /** Whether quality loop is enabled */
  enabled: z.boolean(),
  /** Current iteration number */
  iteration: z.number().int().nonnegative(),
  /** Maximum iterations allowed */
  maxIterations: z.number().int().positive(),
});

export type LoopState = z.infer<typeof LoopStateSchema>;

/**
 * Acceptance criteria verification status
 */
export const ACStatusSchema = z.enum([
  "pending", // Not yet verified
  "met", // Verified as satisfied
  "not_met", // Verified as not satisfied
  "blocked", // Cannot verify due to external dependency
]);

export type ACStatus = z.infer<typeof ACStatusSchema>;

/**
 * Acceptance criteria verification method
 */
export const ACVerificationMethodSchema = z.enum([
  "unit_test",
  "integration_test",
  "browser_test",
  "manual",
]);

export type ACVerificationMethod = z.infer<typeof ACVerificationMethodSchema>;

/**
 * Individual acceptance criterion state
 */
export const AcceptanceCriterionSchema = z.object({
  /** AC identifier (e.g., "A1", "B2") */
  id: z.string(),
  /** Description of the acceptance criterion */
  description: z.string(),
  /** How this AC should be verified */
  verificationMethod: ACVerificationMethodSchema,
  /** Current verification status */
  status: ACStatusSchema,
  /** When the AC was last verified */
  verifiedAt: z.string().datetime().optional(),
  /** Additional notes about verification */
  notes: z.string().optional(),
});

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

/**
 * Acceptance criteria tracking for an issue
 */
export const AcceptanceCriteriaSchema = z.object({
  /** List of acceptance criteria */
  items: z.array(AcceptanceCriterionSchema),
  /** When the AC list was extracted from the issue */
  extractedAt: z.string().datetime(),
  /** Summary counts for quick access */
  summary: z.object({
    total: z.number().int().nonnegative(),
    met: z.number().int().nonnegative(),
    notMet: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  }),
});

export type AcceptanceCriteria = z.infer<typeof AcceptanceCriteriaSchema>;

/**
 * Complete state for a single issue
 */
export const IssueStateSchema = z.object({
  /** GitHub issue number */
  number: z.number().int().positive(),
  /** Issue title */
  title: z.string(),
  /** Overall issue status */
  status: IssueStatusSchema,
  /** Path to the worktree (if created) */
  worktree: z.string().optional(),
  /** Branch name for this issue */
  branch: z.string().optional(),
  /** Current phase being executed or last executed */
  currentPhase: PhaseSchema.optional(),
  /** State of each phase (only phases that have been started/tracked) */
  phases: z.record(z.string(), PhaseStateSchema),
  /** PR information (if PR created) */
  pr: PRInfoSchema.optional(),
  /** Quality loop state (if loop enabled) */
  loop: LoopStateSchema.optional(),
  /** Acceptance criteria tracking (if extracted by /spec) */
  acceptanceCriteria: AcceptanceCriteriaSchema.optional(),
  /** Scope assessment result (if performed by /spec) */
  scopeAssessment: ScopeAssessmentSchema.optional(),
  /** Claude session ID (for resume) */
  sessionId: z.string().optional(),
  /** Most recent activity timestamp */
  lastActivity: z.string().datetime(),
  /** When this issue was first tracked */
  createdAt: z.string().datetime(),
});

export type IssueState = z.infer<typeof IssueStateSchema>;

/**
 * Complete workflow state schema
 *
 * This is the top-level schema for `.sequant/state.json`
 */
export const WorkflowStateSchema = z.object({
  /** Schema version for backwards compatibility */
  version: z.literal(1),
  /** When the state file was last updated */
  lastUpdated: z.string().datetime(),
  /** State for all tracked issues, keyed by issue number */
  issues: z.record(z.string(), IssueStateSchema),
});

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

/**
 * Default state file path
 */
export const STATE_FILE_PATH = ".sequant/state.json";

/**
 * Create an empty workflow state
 */
export function createEmptyState(): WorkflowState {
  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    issues: {},
  };
}

/**
 * Create initial state for a new issue
 */
export function createIssueState(
  issueNumber: number,
  title: string,
  options?: {
    worktree?: string;
    branch?: string;
    qualityLoop?: boolean;
    maxIterations?: number;
  },
): IssueState {
  const now = new Date().toISOString();

  return {
    number: issueNumber,
    title,
    status: "not_started",
    worktree: options?.worktree,
    branch: options?.branch,
    phases: {},
    loop: options?.qualityLoop
      ? {
          enabled: true,
          iteration: 0,
          maxIterations: options?.maxIterations ?? 3,
        }
      : undefined,
    lastActivity: now,
    createdAt: now,
  };
}

/**
 * Create initial phase state
 */
export function createPhaseState(status: PhaseStatus = "pending"): PhaseState {
  if (status === "in_progress") {
    return {
      status,
      startedAt: new Date().toISOString(),
    };
  }
  return { status };
}

/**
 * Create acceptance criterion
 */
export function createAcceptanceCriterion(
  id: string,
  description: string,
  verificationMethod: ACVerificationMethod = "manual",
): AcceptanceCriterion {
  return {
    id,
    description,
    verificationMethod,
    status: "pending",
  };
}

/**
 * Create acceptance criteria tracking structure
 */
export function createAcceptanceCriteria(
  items: AcceptanceCriterion[],
): AcceptanceCriteria {
  return {
    items,
    extractedAt: new Date().toISOString(),
    summary: {
      total: items.length,
      met: 0,
      notMet: 0,
      pending: items.length,
      blocked: 0,
    },
  };
}

/**
 * Update acceptance criteria summary based on item statuses
 */
export function updateAcceptanceCriteriaSummary(
  ac: AcceptanceCriteria,
): AcceptanceCriteria {
  const summary = {
    total: ac.items.length,
    met: ac.items.filter((i) => i.status === "met").length,
    notMet: ac.items.filter((i) => i.status === "not_met").length,
    pending: ac.items.filter((i) => i.status === "pending").length,
    blocked: ac.items.filter((i) => i.status === "blocked").length,
  };
  return { ...ac, summary };
}
