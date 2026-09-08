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

    // Iteration 1 at the unescalated base; 2 and 3 one rung up each.
    expect(dispatchedExecModels()).toEqual([undefined, "opus", "fable"]);
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
    expect(models).toHaveLength(3);
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

    // Iteration 1: neither (first attempt). Iterations 2-3: model only, at
    // the unbumped base effort.
    expect(dispatches).toEqual([
      { effort: "high", model: undefined },
      { effort: "high", model: "opus" },
      { effort: "high", model: "fable" },
    ]);
    expect(
      dispatches.filter((d) => d.effort === "xhigh" && d.model !== undefined),
    ).toEqual([]);
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

    expect(efforts).toEqual(["high", "xhigh", "xhigh"]);
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
