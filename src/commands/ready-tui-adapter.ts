/**
 * Single-issue snapshot adapter for `sequant ready` (#699 Part A).
 *
 * The Ink TUI is pull-based: `App` polls `getSnapshot(): RunSnapshot` at 10 Hz
 * (see `src/ui/tui/index.ts`). But `ready` has no `RunOrchestrator` — its
 * progress arrives push-style via the gate's `onProgress` hook (#697). This
 * adapter bridges the two: a small mutable tracker the gate feeds, exposing a
 * `getSnapshot()` that returns a one-issue `RunSnapshot` for the TUI to mount.
 *
 * The gate fires `start`/`complete`/`failed` around each `qa`/`loop` pass; we
 * model those passes as the phase row, with a coarse `nowLine`
 * (`formatCoarseNowLine`) — no agent-stream enrichment (a stated Non-Goal).
 */

import type { ProgressCallback } from "../lib/workflow/types.js";
import {
  formatCoarseNowLine,
  type RunSnapshot,
  type IssueRuntimeState,
  type PhaseRuntimeState,
  type CurrentPhaseState,
  type IssueStatus,
} from "../lib/workflow/run-state.js";

export interface ReadySnapshotAdapterOptions {
  issueNumber: number;
  title: string;
  branch: string;
  /** Surfaced in the snapshot config header; `ready` always loops. */
  qualityLoop?: boolean;
}

/**
 * Mutable single-issue runtime tracker that doubles as a TUI snapshot provider.
 *
 * Lifecycle: construct → mount `renderTui(adapter)` → pass `adapter.onProgress`
 * to the gate → on gate resolution call `markDone(ready)` so the polling `App`
 * sees `done` and unmounts.
 */
export class ReadySnapshotAdapter {
  private readonly issueNumber: number;
  private readonly title: string;
  private readonly branch: string;
  private readonly qualityLoop: boolean;

  private status: IssueStatus = "queued";
  private readonly phases: PhaseRuntimeState[] = [];
  private currentPhase: CurrentPhaseState | undefined;
  private startedAt: Date | undefined;
  private completedAt: Date | undefined;
  private finished = false;

  constructor(opts: ReadySnapshotAdapterOptions) {
    this.issueNumber = opts.issueNumber;
    this.title = opts.title;
    this.branch = opts.branch;
    this.qualityLoop = opts.qualityLoop ?? true;
  }

  /**
   * `ProgressCallback`-shaped sink wired into the gate's `onProgress`.
   *
   * - `start`    → append a running phase + set `currentPhase` (coarse nowLine).
   * - `complete` → mark the active phase done, record elapsed, clear nowLine.
   * - `failed`   → mark the active phase failed, flip issue status to failed.
   * - `activity` → refresh the activity stamp / nowLine if a finer signal lands.
   */
  readonly onProgress: ProgressCallback = (_issue, phase, event, extra) => {
    const now = new Date();
    switch (event) {
      case "start": {
        if (!this.startedAt) this.startedAt = now;
        this.status = "running";
        this.phases.push({ name: phase, status: "running", startedAt: now });
        this.currentPhase = {
          name: phase,
          startedAt: now,
          lastActivityAt: now,
          nowLine: formatCoarseNowLine(phase),
        };
        break;
      }
      case "complete":
      case "failed": {
        const active = this.phases[this.phases.length - 1];
        if (active && active.status === "running") {
          active.status = event === "failed" ? "failed" : "done";
          active.elapsedMs =
            extra?.durationSeconds != null
              ? Math.round(extra.durationSeconds * 1000)
              : active.startedAt
                ? now.getTime() - active.startedAt.getTime()
                : undefined;
        }
        this.currentPhase = undefined;
        if (event === "failed") this.status = "failed";
        break;
      }
      case "activity": {
        if (this.currentPhase) {
          this.currentPhase = {
            ...this.currentPhase,
            lastActivityAt: now,
            nowLine: extra?.text?.trim()
              ? extra.text.trim()
              : this.currentPhase.nowLine,
          };
        }
        break;
      }
    }
  };

  /**
   * Mark the run finished after `runReadyGate` resolves. Flips the snapshot's
   * `done` flag so the polling `App` unmounts, and sets a terminal status
   * (failed wins if a phase already failed).
   */
  markDone(ready: boolean): void {
    this.completedAt = new Date();
    this.currentPhase = undefined;
    if (this.status !== "failed") {
      this.status = ready ? "passed" : "failed";
    }
    this.finished = true;
  }

  /** Pull-based snapshot consumed by the TUI's 10 Hz poll loop. */
  getSnapshot(): RunSnapshot {
    const issue: IssueRuntimeState = {
      number: this.issueNumber,
      title: this.title,
      branch: this.branch,
      status: this.status,
      phases: this.phases.map((p) => ({ ...p })),
      currentPhase: this.currentPhase ? { ...this.currentPhase } : undefined,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
    };
    return {
      config: {
        concurrency: 1,
        baseBranch: this.branch,
        qualityLoop: this.qualityLoop,
      },
      issues: [issue],
      done: this.finished,
      capturedAt: new Date(),
    };
  }
}
