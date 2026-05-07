/**
 * QA stagnation detection — early-exit guard for fullsolve's QA loop.
 *
 * Background (issue #581): when fullsolve's QA loop sees an `AC_NOT_MET`
 * verdict it invokes `/loop` to apply fixes, then re-runs `/qa`. If `/loop`
 * silently no-ops (no diff, no commit), the re-run produces the same verdict
 * at the same SHA — wasting iterations without adding signal.
 *
 * This module exposes:
 *
 * - `detectStagnation()` — pure decision function. Given the latest qa marker,
 *   the current HEAD SHA, and whether the worktree is dirty, returns whether
 *   the next QA invocation would be wasted.
 * - `recordStagnation()` — appends a stagnation entry to the per-issue
 *   record in `.sequant/state.json` so successive fullsolve runs can see
 *   the history.
 *
 * The fullsolve and loop SKILL.md files invoke a thin CLI shim that wraps
 * these functions so the same code paths are exercised by tests and the
 * orchestrated runtime.
 */

import { execSync } from "child_process";
import {
  StateManager,
  getStateManager,
  type StateManagerOptions,
} from "./state-manager.js";
import type { PhaseMarker } from "./state-schema.js";

/**
 * Reason codes for halting the QA loop.
 */
export type StagnationReason = "SAME_SHA_NO_PROGRESS" | "LOOP_NO_DIFF";

/**
 * Decision returned by `detectStagnation`.
 *
 * `stagnant === true` means the orchestrator should NOT re-invoke `/qa` at
 * the current state — either escalate or hand off to `/loop` for one more
 * fix attempt.
 */
export interface StagnationDecision {
  stagnant: boolean;
  reason?: StagnationReason;
  /** Human-readable explanation suitable for logs / GitHub comments. */
  message: string;
  /** SHA the prior QA was recorded at, if any. */
  priorSha?: string;
  /** Verdict from the prior QA, if any. */
  priorVerdict?: string;
}

export interface DetectStagnationInput {
  /** Current `git rev-parse HEAD` for the worktree. */
  currentSha: string;
  /** Whether `git status --porcelain` is non-empty. */
  isDirty: boolean;
  /**
   * Most recent qa phase marker (any status). Pass `null` when no marker has
   * been recorded yet — that always means "fresh, run qa".
   */
  lastMarker: PhaseMarker | null;
}

/**
 * Pure detection function: would invoking `/qa` again be a wasted cycle?
 *
 * The contract from issue #581 AC-1: if the prior qa marker is `failed`,
 * its `commitSHA` matches HEAD, AND the worktree is clean, the next `/qa`
 * call will produce the same verdict — so the orchestrator should escalate
 * (or run `/loop` once) instead.
 */
export function detectStagnation(
  input: DetectStagnationInput,
): StagnationDecision {
  const { currentSha, isDirty, lastMarker } = input;

  if (!lastMarker) {
    return { stagnant: false, message: "No prior qa marker — fresh run." };
  }
  if (lastMarker.phase !== "qa") {
    return {
      stagnant: false,
      message: `Latest marker is for phase '${lastMarker.phase}', not qa.`,
    };
  }
  if (lastMarker.status !== "failed") {
    return {
      stagnant: false,
      message: `Prior qa marker status is '${lastMarker.status}', not 'failed'.`,
    };
  }
  if (!lastMarker.commitSHA) {
    return {
      stagnant: false,
      message:
        "Prior qa marker has no commitSHA — cannot compare; fall through.",
    };
  }
  if (lastMarker.commitSHA !== currentSha) {
    return {
      stagnant: false,
      message: `Prior qa SHA ${lastMarker.commitSHA} ≠ HEAD ${currentSha}; new commits since last run.`,
      priorSha: lastMarker.commitSHA,
    };
  }
  if (isDirty) {
    return {
      stagnant: false,
      message:
        "Worktree dirty since last qa — uncommitted changes will produce different output.",
      priorSha: lastMarker.commitSHA,
    };
  }

  return {
    stagnant: true,
    reason: "SAME_SHA_NO_PROGRESS",
    message:
      `Prior qa failed at HEAD ${currentSha} and worktree is clean — ` +
      `re-running /qa would produce the same verdict.`,
    priorSha: lastMarker.commitSHA,
    priorVerdict: lastMarker.error,
  };
}

/**
 * Append a stagnation entry to the per-issue record. Schema-additive — older
 * state files without the field will simply gain it on next write.
 */
export async function recordStagnation(
  issueNumber: number,
  entry: {
    sha: string;
    verdict: string;
    iteration: number;
    reason: StagnationReason;
  },
  options: StateManagerOptions = {},
): Promise<void> {
  const manager =
    options.statePath !== undefined
      ? new StateManager(options)
      : getStateManager(options);

  await manager.withLock(async () => {
    const state = await manager.getState();
    const issueState = state.issues[String(issueNumber)];
    if (!issueState) {
      throw new Error(
        `Cannot record stagnation: issue #${issueNumber} not found in state`,
      );
    }
    const existing = issueState.qaStagnation ?? [];
    existing.push({
      sha: entry.sha,
      verdict: entry.verdict,
      iteration: entry.iteration,
      reason: entry.reason,
      detectedAt: new Date().toISOString(),
    });
    issueState.qaStagnation = existing;
    issueState.lastActivity = new Date().toISOString();
    await manager.saveState(state);
  });
}

/**
 * Inputs required for the CLI shim. Loaded from git + GitHub at the call site.
 */
export interface CLIDetectInput {
  currentSha: string;
  isDirty: boolean;
  lastMarker: PhaseMarker | null;
}

/**
 * Read the worktree's HEAD SHA. Pure wrapper around `git rev-parse HEAD`.
 */
export function readHeadSha(cwd: string = process.cwd()): string {
  return execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
}

/**
 * Returns true when `git status --porcelain` reports any uncommitted change.
 */
export function readIsDirty(cwd: string = process.cwd()): boolean {
  return (
    execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim()
      .length > 0
  );
}

/**
 * Snapshot a worktree's HEAD SHA and dirty bit. Used by `/loop` to detect
 * whether a fix attempt actually produced a diff. We deliberately exclude
 * `.sequant/state.json` writes from the dirty check — the helper itself
 * writes there, and per issue #581 those writes do NOT count as progress.
 */
export interface LoopProgressSnapshot {
  sha: string;
  /** Path-relative dirty entries, excluding `.sequant/` state writes. */
  dirty: string[];
}

const STATE_DIR_PREFIX = ".sequant/";

function readDirtyExcludingState(cwd: string = process.cwd()): string[] {
  // `git status --porcelain` (v1) always prefixes each line with exactly
  // `XY ` (two status bytes + a space) before the path. We must slice on the
  // RAW line — trimming first strips the leading space of unstaged-only
  // entries (` M file.ts`) and a subsequent `.{1,3}` regex would chop real
  // path bytes. See issue #581 QA review.
  const out = execSync("git status --porcelain", {
    cwd,
    encoding: "utf-8",
  });
  return out
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      // Renamed entries use `R  old -> new`; we only care about the new path.
      const path = line.slice(3);
      const arrow = path.indexOf(" -> ");
      return arrow >= 0 ? path.slice(arrow + 4) : path;
    })
    .filter((path) => !path.startsWith(STATE_DIR_PREFIX));
}

export function snapshotLoopProgress(
  cwd: string = process.cwd(),
): LoopProgressSnapshot {
  return { sha: readHeadSha(cwd), dirty: readDirtyExcludingState(cwd) };
}

export interface LoopProgressDecision {
  /** True when the snapshot pair shows a real diff (commit or working-tree change). */
  progressed: boolean;
  reason?: "LOOP_NO_DIFF";
  message: string;
}

/**
 * Compare two `LoopProgressSnapshot`s. Returns `progressed: false` ONLY when
 * both the SHA and the (state-excluded) dirty set are unchanged.
 *
 * State-file / settings writes are excluded from the dirty comparison per
 * issue #581's open question — `/loop` may legitimately touch
 * `.sequant/state.json` without that counting as a fix.
 */
export function compareLoopProgress(
  before: LoopProgressSnapshot,
  after: LoopProgressSnapshot,
): LoopProgressDecision {
  if (before.sha !== after.sha) {
    return {
      progressed: true,
      message: `HEAD advanced ${before.sha} → ${after.sha}.`,
    };
  }
  const beforeSet = new Set(before.dirty);
  const afterSet = new Set(after.dirty);
  if (beforeSet.size !== afterSet.size) {
    return {
      progressed: true,
      message: `Working-tree dirty count changed (${beforeSet.size} → ${afterSet.size}).`,
    };
  }
  for (const path of afterSet) {
    if (!beforeSet.has(path)) {
      return {
        progressed: true,
        message: `New dirty path detected: ${path}.`,
      };
    }
  }
  return {
    progressed: false,
    reason: "LOOP_NO_DIFF",
    message:
      "/loop made no commit and no working-tree changes (excluding .sequant/ state writes) — manual intervention required.",
  };
}
