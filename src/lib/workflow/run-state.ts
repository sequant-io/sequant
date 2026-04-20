/**
 * Runtime state snapshots for multi-issue dashboard rendering.
 *
 * Decouples the TUI from the orchestrator: `getSnapshot()` returns an
 * immutable, plain-object view of current run state that can be safely
 * read from a render loop without holding locks.
 */

import type { Phase } from "./types.js";

/** Top-level lifecycle status of a single issue. */
export type IssueStatus = "queued" | "running" | "passed" | "failed";

/** Per-phase status within an issue. */
export type PhaseStatus = "pending" | "running" | "done" | "failed";

/**
 * One phase's runtime state.
 * `elapsedMs` is populated once a phase reaches `done` or `failed`.
 */
export interface PhaseRuntimeState {
  name: string;
  status: PhaseStatus;
  startedAt?: Date;
  elapsedMs?: number;
}

/**
 * State of the currently running phase for an issue.
 * Populated only while a phase is active. Dashboard consumers render
 * `nowLine` as the activity row and tick `lastActivityAt` for the stamp.
 */
export interface CurrentPhaseState {
  name: string;
  startedAt: Date;
  lastActivityAt: Date;
  nowLine: string;
  logPath?: string;
}

/** Complete runtime state for a single issue. */
export interface IssueRuntimeState {
  number: number;
  title: string;
  branch: string;
  status: IssueStatus;
  phases: PhaseRuntimeState[];
  currentPhase?: CurrentPhaseState;
  startedAt?: Date;
  completedAt?: Date;
}

/** Run-level configuration captured at start for the header. */
export interface RunSnapshotConfig {
  concurrency: number;
  baseBranch: string;
  baseSha?: string;
  baseFetchedAt?: Date;
  qualityLoop: boolean;
}

/**
 * A consistent point-in-time view of the entire run.
 *
 * Returned as a freshly-allocated plain object by `getSnapshot()`; callers
 * may read fields concurrently without further synchronization because no
 * internal mutable references are leaked.
 */
export interface RunSnapshot {
  config: RunSnapshotConfig;
  issues: IssueRuntimeState[];
  done: boolean;
  capturedAt: Date;
}

/**
 * Format a coarse "now" line for a phase transition.
 * Used as the M1 default when no finer activity signal exists.
 */
export function formatCoarseNowLine(phase: Phase | string): string {
  return `running ${phase}`;
}
