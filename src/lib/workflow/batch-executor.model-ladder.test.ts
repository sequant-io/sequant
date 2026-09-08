/**
 * #971 — the RUN path's half of AC-2/AC-3/AC-5/AC-D2.
 *
 * `model-ladder.test.ts` drives the ready-gate path through the real
 * `runReadyGate` loop; this file drives the other dispatch site — the outer
 * quality loop in `runIssueWithLogging` — through the real loop with
 * `executePhaseWithRetry` mocked, so the assertion is on the
 * `ExecutionConfig` the loop actually hands the executor.
 *
 * The per-iteration progress snapshot is injected via `ctx.snapshotProgressFn`
 * so these tests need no git worktree: a constant snapshot is "the loop
 * produced nothing" (capability-bound) and an advancing one is "the loop
 * produced a diff that still failed" (divergence-suspect).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ExecutionConfig,
  PhaseResult,
  IssueExecutionContext,
  RunOptions,
} from "./types.js";
import type { LoopProgressSnapshot } from "./qa-stagnation.js";

vi.mock("./phase-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./phase-executor.js")>()),
  executePhaseWithRetry: vi.fn(),
  hasExecChanges: vi.fn().mockReturnValue(true),
}));

vi.mock("./worktree-manager.js", () => ({
  createCheckpointCommit: vi.fn(),
  rebaseBeforePR: vi.fn(),
  createPR: vi.fn(),
  readCacheMetrics: vi.fn(),
  filterResumedPhases: vi.fn(),
}));

vi.mock("./log-writer.js", () => ({
  LogWriter: vi.fn(),
  createPhaseLogFromTiming: vi.fn(),
}));

vi.mock("./state-manager.js", () => ({ StateManager: vi.fn() }));

vi.mock("./git-diff-utils.js", () => ({
  getGitDiffStats: vi.fn(),
  getCommitHash: vi.fn(),
  resolveDiffBase: vi.fn(),
}));

import { executePhaseWithRetry } from "./phase-executor.js";
import { runIssueWithLogging } from "./batch-executor.js";

const mockExecutePhase = vi.mocked(executePhaseWithRetry);

const LADDER = ["sonnet", "opus", "fable"];

function makeCtx(
  config: Partial<ExecutionConfig>,
  snapshotProgressFn: (cwd: string) => LoopProgressSnapshot,
): IssueExecutionContext {
  return {
    issueNumber: 971,
    title: "model ladder",
    labels: [],
    config: {
      // Explicit phase list + autoDetectPhases off: this test is about the
      // quality loop's dispatch config, not phase detection.
      phases: ["exec"],
      phaseTimeout: 1800,
      qualityLoop: true,
      maxIterations: 3,
      sequential: false,
      concurrency: 3,
      parallel: false,
      verbose: false,
      noSmartTests: false,
      dryRun: false,
      mcp: false,
      retry: false,
      ...config,
    } as ExecutionConfig,
    options: { autoDetectPhases: false } as RunOptions,
    services: { logWriter: null, stateManager: null },
    worktree: { path: "/tmp/worktree-971", branch: "feature/971" },
    snapshotProgressFn,
  };
}

/** Models the loop dispatched `exec` with, in order. */
function dispatchedExecModels(): Array<string | undefined> {
  return mockExecutePhase.mock.calls
    .filter((c) => c[1] === "exec")
    .map((c) => (c[2] as ExecutionConfig).phasePolicies?.exec?.model);
}

beforeEach(() => {
  vi.clearAllMocks();
  // These tests drive the REAL quality loop, which calls `emitProgressLine`.
  // That writes `SEQUANT_PROGRESS:` lines to stderr whenever
  // `SEQUANT_ORCHESTRATOR` is set — true when the suite runs inside an
  // orchestrated `sequant run` phase. Those lines are the launcher's wire
  // protocol: it prefix-matches them to drive the progress display and to
  // reset the no-progress watchdog, so leaking synthetic ones for issue 971
  // would spoof progress for whatever run is actually in flight. Scrub the
  // var so the loop stays silent regardless of the ambient environment.
  vi.stubEnv("SEQUANT_ORCHESTRATOR", "");
  // Every phase fails, so the quality loop runs its full iteration budget.
  mockExecutePhase.mockResolvedValue({
    phase: "exec",
    success: false,
    durationSeconds: 1,
    error: "not converged",
  } as PhaseResult);
});

describe("971 AC-2: run path — a no-progress iteration dispatches the next rung", () => {
  it("re-dispatches one rung up after each iteration that produced nothing", async () => {
    // Constant snapshot ⇒ every iteration ends with LOOP_NO_DIFF.
    await runIssueWithLogging(
      makeCtx({ modelLadder: LADDER }, () => ({ sha: "frozen", dirty: [] })),
    );

    // Iteration 1 is the first attempt (nothing observed yet). Iteration 2 is
    // retry 1, which belongs to #915's effort rung — the model is untouched
    // (AC-5). Iteration 3 is retry 2, the first retry eligible to spend a
    // model rung, so it dispatches one rung up.
    expect(dispatchedExecModels()).toEqual([undefined, undefined, "opus"]);
  });

  it("with NO ladder configured, every iteration dispatches the same (unset) model", async () => {
    await runIssueWithLogging(
      makeCtx({}, () => ({ sha: "frozen", dirty: [] })),
    );
    expect(dispatchedExecModels()).toEqual([undefined, undefined, undefined]);
  });
});

describe("971 AC-3: run path — advancing SHAs never change the model", () => {
  it("three iterations that each produce a diff hold the model option constant", async () => {
    let n = 0;
    await runIssueWithLogging(
      makeCtx({ modelLadder: LADDER }, () => ({
        sha: `sha-${n++}`,
        dirty: [],
      })),
    );

    const models = dispatchedExecModels();
    // #995 supersedes #971's count here, by design. Under #971 all three
    // iterations ran and stopped at the cap; #995 AC-3 adds the halt, so the
    // SECOND consecutive divergence-suspect iteration ends the run with an
    // evidence bundle rather than spending a third iteration on a pattern the
    // ladder has already decided it will never escalate.
    expect(models).toHaveLength(2);
    // What THIS AC asserts is unchanged: advancing SHAs never buy a rung.
    expect(models.every((m) => m === undefined)).toBe(true);
  });
});

describe("971 AC-5: run path — effort and model never escalate on the same iteration", () => {
  it("a capability-bound iteration spends a model rung and suppresses the effort bump", async () => {
    await runIssueWithLogging(
      makeCtx(
        {
          modelLadder: LADDER,
          effortEscalation: true,
          phasePolicies: { exec: { effort: "high" } },
        },
        () => ({ sha: "frozen", dirty: [] }),
      ),
    );

    const dispatches = mockExecutePhase.mock.calls
      .filter((c) => c[1] === "exec")
      .map((c) => {
        const policy = (c[2] as ExecutionConfig).phasePolicies?.exec;
        return { effort: policy?.effort, model: policy?.model };
      });

    // The AC-5 ordering, derived from the loop rather than hand-fed:
    //   iteration 1 — first attempt: neither escalator fires.
    //   iteration 2 — retry 1: EFFORT only, at the base model. The cheap rung
    //     is spent first even though the trigger is already present.
    //   iteration 3 — retry 2: MODEL only, at the base (unbumped) effort.
    expect(dispatches).toEqual([
      { effort: "high", model: undefined },
      { effort: "xhigh", model: undefined },
      { effort: "high", model: "opus" },
    ]);
    expect(
      dispatches.filter((d) => d.effort === "xhigh" && d.model !== undefined),
    ).toEqual([]);
  });

  it("spends the effort rung BEFORE any model rung when iteration 1 produces nothing", async () => {
    // The regression this test exists for (#971 QA): the trigger is DERIVED
    // from a no-diff iteration 1 rather than hand-fed, which is the only way
    // to observe the ordering the loop actually produces. The previous
    // implementation suppressed effort on the first capability-bound retry
    // and jumped straight to a model rung, so the effort rung was never spent
    // on the ladder's own primary path — AC-5's "retry 1 escalates effort
    // only" was violated while a hand-fed unit test stayed green.
    await runIssueWithLogging(
      makeCtx(
        {
          modelLadder: LADDER,
          effortEscalation: true,
          phasePolicies: { exec: { effort: "high" } },
        },
        // Constant snapshot ⇒ iteration 1 produces nothing ⇒ the trigger is
        // already LOOP_NO_DIFF by the time retry 1 dispatches.
        () => ({ sha: "frozen", dirty: [] }),
      ),
    );

    const dispatches = mockExecutePhase.mock.calls
      .filter((c) => c[1] === "exec")
      .map((c) => {
        const policy = (c[2] as ExecutionConfig).phasePolicies?.exec;
        return { effort: policy?.effort, model: policy?.model };
      });

    const firstEffortBump = dispatches.findIndex((d) => d.effort === "xhigh");
    const firstModelRung = dispatches.findIndex((d) => d.model !== undefined);

    expect(firstEffortBump).toBeGreaterThanOrEqual(0);
    expect(firstModelRung).toBeGreaterThanOrEqual(0);
    // The load-bearing assertion: effort is spent at a STRICTLY earlier
    // dispatch than the first model rung.
    expect(firstEffortBump).toBeLessThan(firstModelRung);
    // And specifically: retry 1 is the effort rung, retry 2 is the model rung.
    expect(firstEffortBump).toBe(1);
    expect(firstModelRung).toBe(2);
  });

  it("a NON-capability-bound retry still escalates effort — #915's behaviour is preserved", async () => {
    let n = 0;
    await runIssueWithLogging(
      makeCtx(
        {
          modelLadder: LADDER,
          effortEscalation: true,
          phasePolicies: { exec: { effort: "high" } },
        },
        () => ({ sha: `sha-${n++}`, dirty: [] }),
      ),
    );

    const efforts = mockExecutePhase.mock.calls
      .filter((c) => c[1] === "exec")
      .map((c) => (c[2] as ExecutionConfig).phasePolicies?.exec?.effort);

    // Two dispatches, not three: the advancing-SHA snapshot is the
    // divergence-suspect pattern, which #995 AC-3 now halts on at the second
    // consecutive occurrence. #915's behaviour — the thing this test guards —
    // is intact over the dispatches that do happen: retry 1 still spends the
    // effort rung even though no capability-bound trigger was ever present.
    expect(efforts).toEqual(["high", "xhigh"]);
  });
});

describe("971 AC-D2: an unconfigured run takes no progress snapshot", () => {
  it("never calls the snapshot function when no ladder is configured", async () => {
    const snapshot = vi.fn(() => ({ sha: "frozen", dirty: [] }));
    await runIssueWithLogging(makeCtx({}, snapshot));
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("calls it once per iteration boundary when a ladder IS configured", async () => {
    const snapshot = vi.fn(() => ({ sha: "frozen", dirty: [] }));
    await runIssueWithLogging(makeCtx({ modelLadder: LADDER }, snapshot));
    // One before each iteration's phases, one after — 3 iterations.
    expect(snapshot).toHaveBeenCalledTimes(6);
  });
});
