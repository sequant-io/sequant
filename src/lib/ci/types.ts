/**
 * Types for GitHub Actions CI integration.
 *
 * These types model the inputs, outputs, triggers, and configuration
 * that the sequant GitHub Action uses to bridge GitHub events to
 * sequant workflow execution.
 */

import type { Phase } from "../workflow/types.js";

/**
 * Validated action inputs after parsing from GitHub Actions context.
 */
export interface ActionInputs {
  /** Issue numbers to process */
  issues: number[];
  /** Workflow phases to execute */
  phases: Phase[];
  /** Agent backend name */
  agent: string;
  /** Phase timeout in seconds */
  timeout: number;
  /** Enable quality loop */
  qualityLoop: boolean;
  /** API key for the selected agent */
  apiKey: string;
}

/**
 * Supported GitHub event triggers for the action.
 */
export type TriggerType = "workflow_dispatch" | "label" | "comment" | "unknown";

/**
 * Labels that map to specific phase configurations.
 */
export const TRIGGER_LABELS = {
  /** Full workflow: spec → exec → qa */
  ASSESS: "sequant:assess",
  /** @deprecated Use ASSESS instead */
  SOLVE: "sequant:solve",
  /** Spec phase only */
  SPEC_ONLY: "sequant:spec-only",
  /** Exec phase only */
  EXEC: "sequant:exec",
  /** QA phase only */
  QA: "sequant:qa",
} as const;

/**
 * Labels used for lifecycle tracking.
 */
export const LIFECYCLE_LABELS = {
  /** Applied when a run starts */
  SOLVING: "sequant:solving",
  /** Applied on successful completion */
  DONE: "sequant:done",
  /** Applied on failure */
  FAILED: "sequant:failed",
} as const;

/**
 * Result of parsing a GitHub event into a trigger.
 */
export interface TriggerResult {
  /** Type of trigger detected */
  trigger: TriggerType;
  /** Phases to execute */
  phases: Phase[];
  /** Issue number extracted from the event */
  issue: number | null;
  /** The label that triggered the action (if label trigger) */
  label?: string;
}

/**
 * GitHub Actions event payload (subset of fields we use).
 */
export interface GitHubEventPayload {
  action?: string;
  issue?: {
    number: number;
    labels?: Array<{ name: string }>;
  };
  label?: {
    name: string;
  };
  comment?: {
    body: string;
  };
}

/**
 * GitHub Actions context (subset of fields we use).
 */
export interface GitHubContext {
  eventName: string;
  payload: GitHubEventPayload;
}

/**
 * Structured action outputs set via $GITHUB_OUTPUT.
 */
export interface ActionOutputs {
  /** The issue number(s) processed */
  issue: string;
  /** Whether all phases passed */
  success: string;
  /** JSON array of phase results */
  phases: string;
  /** URL of created PR (empty if no PR) */
  "pr-url": string;
  /** Total duration in seconds */
  duration: string;
}

/**
 * Repository-level CI configuration from .github/sequant.yml.
 */
export interface CIConfig {
  /** Default agent backend */
  agent?: string;
  /** Default phases to execute */
  phases?: Phase[];
  /** Default phase timeout in seconds */
  timeout?: number;
  /** Enable quality loop by default */
  qualityLoop?: boolean;
  /** Maximum concurrent workflow runs */
  maxConcurrentRuns?: number;
}

/**
 * Merge precedence: workflow inputs > config file > action defaults.
 */
export const CI_DEFAULTS: Required<CIConfig> = {
  agent: "claude-code",
  phases: ["spec", "exec", "qa"],
  timeout: 1800,
  qualityLoop: false,
  maxConcurrentRuns: 1,
};

/**
 * Pattern for matching @sequant commands in issue comments.
 */
export const COMMENT_TRIGGER_PATTERN = /^@sequant\s+run\s+([\w,-]+)\s*$/m;
