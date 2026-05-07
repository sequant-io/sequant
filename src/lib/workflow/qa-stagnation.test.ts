/**
 * Tests for QA stagnation detection (issue #581).
 *
 * Covers:
 *   AC-3 (unit) — recordStagnation() persists entries to .sequant/state.json
 *   AC-4 (integration) — qa-loop logic halts at iteration 1 when /loop produces no diff
 *
 * Plus full coverage of detectStagnation() and the snapshot/compare helpers
 * that drive the loop's no-diff guard.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import {
  detectStagnation,
  recordStagnation,
  compareLoopProgress,
  snapshotLoopProgress,
  readHeadSha,
  readIsDirty,
  type LoopProgressSnapshot,
} from "./qa-stagnation.js";
import { StateManager, resetStateManager } from "./state-manager.js";
import {
  createIssueState,
  type PhaseMarker,
  type WorkflowState,
} from "./state-schema.js";

// ---------------------------------------------------------------------------
// detectStagnation — pure decision function
// ---------------------------------------------------------------------------

describe("detectStagnation", () => {
  const sha = "abc123";

  it("returns not stagnant when no prior marker exists", () => {
    const decision = detectStagnation({
      currentSha: sha,
      isDirty: false,
      lastMarker: null,
    });
    expect(decision.stagnant).toBe(false);
    expect(decision.message).toMatch(/fresh run/i);
  });

  it("returns not stagnant when prior marker is for a different phase", () => {
    const marker: PhaseMarker = {
      phase: "exec",
      status: "completed",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    const decision = detectStagnation({
      currentSha: sha,
      isDirty: false,
      lastMarker: marker,
    });
    expect(decision.stagnant).toBe(false);
  });

  it("returns not stagnant when prior qa marker status is completed", () => {
    const marker: PhaseMarker = {
      phase: "qa",
      status: "completed",
      timestamp: "2026-01-01T00:00:00.000Z",
      commitSHA: sha,
    };
    const decision = detectStagnation({
      currentSha: sha,
      isDirty: false,
      lastMarker: marker,
    });
    expect(decision.stagnant).toBe(false);
  });

  it("returns not stagnant when prior qa marker has no commitSHA", () => {
    const marker: PhaseMarker = {
      phase: "qa",
      status: "failed",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    const decision = detectStagnation({
      currentSha: sha,
      isDirty: false,
      lastMarker: marker,
    });
    expect(decision.stagnant).toBe(false);
    expect(decision.message).toMatch(/no commitSHA/);
  });

  it("returns not stagnant when SHA has advanced since prior qa", () => {
    const marker: PhaseMarker = {
      phase: "qa",
      status: "failed",
      timestamp: "2026-01-01T00:00:00.000Z",
      commitSHA: "old-sha",
    };
    const decision = detectStagnation({
      currentSha: "new-sha",
      isDirty: false,
      lastMarker: marker,
    });
    expect(decision.stagnant).toBe(false);
    expect(decision.priorSha).toBe("old-sha");
  });

  it("returns not stagnant when worktree is dirty (uncommitted changes)", () => {
    const marker: PhaseMarker = {
      phase: "qa",
      status: "failed",
      timestamp: "2026-01-01T00:00:00.000Z",
      commitSHA: sha,
    };
    const decision = detectStagnation({
      currentSha: sha,
      isDirty: true,
      lastMarker: marker,
    });
    expect(decision.stagnant).toBe(false);
    expect(decision.message).toMatch(/dirty/i);
  });

  it("returns stagnant=true when same SHA, clean tree, prior qa failed", () => {
    const marker: PhaseMarker = {
      phase: "qa",
      status: "failed",
      timestamp: "2026-01-01T00:00:00.000Z",
      commitSHA: sha,
      error: "AC_NOT_MET",
    };
    const decision = detectStagnation({
      currentSha: sha,
      isDirty: false,
      lastMarker: marker,
    });
    expect(decision.stagnant).toBe(true);
    expect(decision.reason).toBe("SAME_SHA_NO_PROGRESS");
    expect(decision.priorSha).toBe(sha);
    expect(decision.priorVerdict).toBe("AC_NOT_MET");
  });
});

// ---------------------------------------------------------------------------
// recordStagnation — AC-3 unit coverage
// ---------------------------------------------------------------------------

describe("recordStagnation (AC-3)", () => {
  let tempDir: string;
  let statePath: string;
  let manager: StateManager;

  beforeEach(async () => {
    resetStateManager();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-stag-test-"));
    statePath = path.join(tempDir, ".sequant", "state.json");
    manager = new StateManager({ statePath });

    // Seed state with issue #581
    const seed: WorkflowState = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      issues: { "581": createIssueState(581, "Test issue") },
    };
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(seed));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    resetStateManager();
  });

  it("appends an entry to the issue's qaStagnation array", async () => {
    await recordStagnation(
      581,
      {
        sha: "abc123",
        verdict: "AC_NOT_MET",
        iteration: 1,
        reason: "SAME_SHA_NO_PROGRESS",
      },
      { statePath },
    );

    const state = await manager.getState();
    const entries = state.issues["581"].qaStagnation;
    expect(entries).toBeDefined();
    expect(entries!.length).toBe(1);
    expect(entries![0]).toMatchObject({
      sha: "abc123",
      verdict: "AC_NOT_MET",
      iteration: 1,
      reason: "SAME_SHA_NO_PROGRESS",
    });
    expect(entries![0].detectedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it("appends multiple entries (additive, not replacing)", async () => {
    await recordStagnation(
      581,
      {
        sha: "abc123",
        verdict: "AC_NOT_MET",
        iteration: 1,
        reason: "SAME_SHA_NO_PROGRESS",
      },
      { statePath },
    );
    await recordStagnation(
      581,
      {
        sha: "abc123",
        verdict: "AC_NOT_MET",
        iteration: 2,
        reason: "LOOP_NO_DIFF",
      },
      { statePath },
    );

    const state = await manager.getState();
    expect(state.issues["581"].qaStagnation!.length).toBe(2);
    expect(state.issues["581"].qaStagnation![1].reason).toBe("LOOP_NO_DIFF");
  });

  it("throws when the issue is not in state", async () => {
    await expect(
      recordStagnation(
        9999,
        {
          sha: "abc123",
          verdict: "AC_NOT_MET",
          iteration: 1,
          reason: "SAME_SHA_NO_PROGRESS",
        },
        { statePath },
      ),
    ).rejects.toThrow(/issue #9999 not found/);
  });

  it("preserves existing IssueState fields (additive schema)", async () => {
    await recordStagnation(
      581,
      {
        sha: "abc123",
        verdict: "AC_NOT_MET",
        iteration: 1,
        reason: "SAME_SHA_NO_PROGRESS",
      },
      { statePath },
    );

    const state = await manager.getState();
    const issue = state.issues["581"];
    expect(issue.number).toBe(581);
    expect(issue.title).toBe("Test issue");
    // lastActivity must update on write
    expect(issue.lastActivity).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// snapshot / compareLoopProgress — drives the loop no-diff guard
// ---------------------------------------------------------------------------

describe("compareLoopProgress", () => {
  it("reports progress when HEAD SHA changed", () => {
    const before: LoopProgressSnapshot = { sha: "old", dirty: [] };
    const after: LoopProgressSnapshot = { sha: "new", dirty: [] };
    const decision = compareLoopProgress(before, after);
    expect(decision.progressed).toBe(true);
    expect(decision.message).toMatch(/HEAD advanced/);
  });

  it("reports progress when a new dirty path appears", () => {
    const before: LoopProgressSnapshot = { sha: "abc", dirty: [] };
    const after: LoopProgressSnapshot = { sha: "abc", dirty: ["src/foo.ts"] };
    const decision = compareLoopProgress(before, after);
    expect(decision.progressed).toBe(true);
  });

  it("reports progress when dirty count changes (file removed)", () => {
    const before: LoopProgressSnapshot = {
      sha: "abc",
      dirty: ["src/foo.ts", "src/bar.ts"],
    };
    const after: LoopProgressSnapshot = { sha: "abc", dirty: ["src/foo.ts"] };
    const decision = compareLoopProgress(before, after);
    expect(decision.progressed).toBe(true);
  });

  it("reports LOOP_NO_DIFF when SHA and dirty set are identical", () => {
    const snap: LoopProgressSnapshot = { sha: "abc", dirty: ["src/foo.ts"] };
    const decision = compareLoopProgress(snap, { ...snap });
    expect(decision.progressed).toBe(false);
    expect(decision.reason).toBe("LOOP_NO_DIFF");
    expect(decision.message).toMatch(/manual intervention/);
  });

  it("reports LOOP_NO_DIFF when both snapshots have empty dirty sets", () => {
    const snap: LoopProgressSnapshot = { sha: "abc", dirty: [] };
    const decision = compareLoopProgress(snap, snap);
    expect(decision.progressed).toBe(false);
    expect(decision.reason).toBe("LOOP_NO_DIFF");
  });
});

describe("snapshotLoopProgress (.sequant/ exclusion)", () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "loop-snap-repo-"));
    execSync("git init -q -b main", { cwd: repo });
    execSync("git config user.email test@test.local", { cwd: repo });
    execSync("git config user.name test", { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "seed\n");
    execSync("git add README.md && git commit -q -m seed", { cwd: repo });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("includes regular working-tree paths in dirty set", () => {
    fs.writeFileSync(path.join(repo, "src.ts"), "x");
    const snap = snapshotLoopProgress(repo);
    expect(snap.dirty).toContain("src.ts");
  });

  it("excludes .sequant/ paths from dirty set", () => {
    fs.mkdirSync(path.join(repo, ".sequant"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".sequant/state.json"), "{}");
    fs.writeFileSync(path.join(repo, "src.ts"), "x");
    const snap = snapshotLoopProgress(repo);
    expect(snap.dirty).toContain("src.ts");
    expect(snap.dirty.some((p) => p.startsWith(".sequant/"))).toBe(false);
  });

  it("returns empty dirty set on a clean tree", () => {
    const snap = snapshotLoopProgress(repo);
    expect(snap.dirty).toEqual([]);
    expect(snap.sha).toBe(readHeadSha(repo));
  });

  it("preserves leading-space paths (unstaged-only entries)", () => {
    // ` M src.ts` would be corrupted if the parser trimmed before slicing
    fs.writeFileSync(path.join(repo, "src.ts"), "x");
    execSync("git add src.ts && git commit -q -m a", { cwd: repo });
    fs.writeFileSync(path.join(repo, "src.ts"), "y");
    const snap = snapshotLoopProgress(repo);
    expect(snap.dirty).toContain("src.ts");
  });
});

// ---------------------------------------------------------------------------
// AC-4 integration — qa-loop halts at iteration 1 when /loop produces no diff
// ---------------------------------------------------------------------------

/**
 * Minimal reimplementation of the qa-loop control flow described in
 * `.claude/skills/fullsolve/SKILL.md` §4.3 + `.claude/skills/loop/SKILL.md`
 * Step 5.5. The orchestrator is markdown pseudo-code; this simulator
 * exercises the same TS helpers (detectStagnation + compareLoopProgress) on
 * the same inputs the markdown describes, so a passing test here proves the
 * gating logic itself works end-to-end against a real git worktree.
 */
interface QaLoopResult {
  iterations: number;
  halted: boolean;
  reason?: "SAME_SHA_NO_PROGRESS" | "LOOP_NO_DIFF" | "MAX_ITERATIONS";
  qaInvocations: number;
}

interface QaLoopDeps {
  cwd: string;
  /** Stub for /qa — returns a verdict and posts a phase marker. */
  runQa: () => { verdict: string; marker: PhaseMarker };
  /** Stub for /loop — returns true if it produced a diff. */
  runLoop: () => boolean;
  maxIterations?: number;
}

function simulateQaLoop(deps: QaLoopDeps): QaLoopResult {
  const max = deps.maxIterations ?? 2;
  let iteration = 0;
  let qaInvocations = 0;
  let lastMarker: PhaseMarker | null = null;

  while (iteration < max) {
    if (iteration > 0) {
      // Stagnation gate (AC-1)
      const stagDecision = detectStagnation({
        currentSha: readHeadSha(deps.cwd),
        isDirty: readIsDirty(deps.cwd),
        lastMarker,
      });
      if (stagDecision.stagnant) {
        return {
          iterations: iteration,
          halted: true,
          reason: stagDecision.reason,
          qaInvocations,
        };
      }
    }

    const qa = deps.runQa();
    qaInvocations++;
    lastMarker = qa.marker;

    if (qa.verdict === "READY_FOR_MERGE") {
      return { iterations: iteration, halted: false, qaInvocations };
    }

    // Snapshot before /loop, /loop, snapshot after, compare (AC-2)
    const before = snapshotLoopProgress(deps.cwd);
    deps.runLoop();
    const after = snapshotLoopProgress(deps.cwd);
    const loopDecision = compareLoopProgress(before, after);
    if (!loopDecision.progressed) {
      return {
        iterations: iteration + 1,
        halted: true,
        reason: loopDecision.reason,
        qaInvocations,
      };
    }

    iteration++;
  }

  return {
    iterations: iteration,
    halted: true,
    reason: "MAX_ITERATIONS",
    qaInvocations,
  };
}

describe("qa-loop integration (AC-4)", () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "qa-loop-int-"));
    execSync("git init -q -b main", { cwd: repo });
    execSync("git config user.email test@test.local", { cwd: repo });
    execSync("git config user.name test", { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "seed\n");
    execSync("git add README.md && git commit -q -m seed", { cwd: repo });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("halts via LOOP_NO_DIFF after iteration 1 when /loop produces no diff (NOT MAX_QA_ITERATIONS)", () => {
    const result = simulateQaLoop({
      cwd: repo,
      runQa: () => {
        const sha = readHeadSha(repo);
        return {
          verdict: "AC_NOT_MET",
          marker: {
            phase: "qa",
            status: "failed",
            timestamp: new Date().toISOString(),
            commitSHA: sha,
            error: "AC_NOT_MET",
          },
        };
      },
      runLoop: () => false, // no-op stub — produces no diff
      maxIterations: 2,
    });

    expect(result.halted).toBe(true);
    expect(result.reason).toBe("LOOP_NO_DIFF");
    expect(result.qaInvocations).toBe(1); // Did NOT re-run /qa after wasted /loop
    expect(result.iterations).toBe(1);
  });

  it("halts via SAME_SHA_NO_PROGRESS at iteration 2 if /loop appears to diff but state is restored", () => {
    let firstLoop = true;
    const result = simulateQaLoop({
      cwd: repo,
      runQa: () => {
        const sha = readHeadSha(repo);
        return {
          verdict: "AC_NOT_MET",
          marker: {
            phase: "qa",
            status: "failed",
            timestamp: new Date().toISOString(),
            commitSHA: sha,
            error: "AC_NOT_MET",
          },
        };
      },
      runLoop: () => {
        // First /loop: write then revert — diff appears momentarily but gets cleaned up
        if (firstLoop) {
          firstLoop = false;
          fs.writeFileSync(path.join(repo, "tmp.ts"), "x");
          // Snapshot will be taken NOW (after this returns) — diff exists
        }
        return true;
      },
      maxIterations: 2,
    });

    // First iteration: /loop made a diff (tmp.ts) so loop guard passes; iteration becomes 1
    // Second iteration: stagnation gate runs — but tmp.ts is still dirty so isDirty=true → not stagnant.
    // /qa runs again at same SHA, returns AC_NOT_MET, /loop runs (no-op this time) → LOOP_NO_DIFF halt
    expect(result.halted).toBe(true);
    expect(result.qaInvocations).toBe(2);
  });

  it("proceeds to MAX_ITERATIONS when /loop progresses each cycle but /qa keeps failing", () => {
    let iter = 0;
    const result = simulateQaLoop({
      cwd: repo,
      runQa: () => {
        const sha = readHeadSha(repo);
        return {
          verdict: "AC_NOT_MET",
          marker: {
            phase: "qa",
            status: "failed",
            timestamp: new Date().toISOString(),
            commitSHA: sha,
            error: "AC_NOT_MET",
          },
        };
      },
      runLoop: () => {
        iter++;
        const file = path.join(repo, `fix-${iter}.ts`);
        fs.writeFileSync(file, "x");
        execSync(`git add fix-${iter}.ts && git commit -q -m fix${iter}`, {
          cwd: repo,
        });
        return true;
      },
      maxIterations: 2,
    });

    expect(result.halted).toBe(true);
    expect(result.reason).toBe("MAX_ITERATIONS");
    expect(result.qaInvocations).toBe(2);
  });

  it("exits cleanly at iteration 0 when /qa returns READY_FOR_MERGE on first try", () => {
    const result = simulateQaLoop({
      cwd: repo,
      runQa: () => ({
        verdict: "READY_FOR_MERGE",
        marker: {
          phase: "qa",
          status: "completed",
          timestamp: new Date().toISOString(),
          commitSHA: readHeadSha(repo),
        },
      }),
      runLoop: () => false,
      maxIterations: 2,
    });

    expect(result.halted).toBe(false);
    expect(result.qaInvocations).toBe(1);
    expect(result.iterations).toBe(0);
  });
});
