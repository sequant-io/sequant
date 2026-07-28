/**
 * Behavioral wiring guard for `sequant run --ready-gate` (#817).
 *
 * The #795 inert-flag failure (`--qa-gate` shipped unwired) is the failure
 * class these tests exist to prevent: it is not enough that `readyGate` is
 * *declared* — a test must fail if the flag stops actually reaching
 * `runReadyGate`. So these drive `runIssueWithLogging` end to end with the
 * engine mocked, and assert the gate runs iff the flag is set, is fed the
 * `ready` machinery's args (AC-4), owns the persisted terminal status (AC-1),
 * and surfaces its report in the PR body (AC-6). The complementary "byte-
 * identical without the flag" case (AC-5) is the flag-off assertion here plus
 * the untouched existing `batch-executor.test.ts` suite.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ExecutionConfig,
  IssueExecutionContext,
  PhaseResult,
  RunOptions,
} from "./types.js";
import type { ReadyResult } from "./ready-gate.js";

vi.mock("./phase-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./phase-executor.js")>()),
  executePhaseWithRetry: vi.fn(),
}));

vi.mock("./worktree-manager.js", () => ({
  createCheckpointCommit: vi.fn(),
  rebaseBeforePR: vi.fn(),
  createPR: vi.fn(() => ({ attempted: true, success: false })),
  readCacheMetrics: vi.fn(),
  filterResumedPhases: vi.fn(),
}));

vi.mock("./log-writer.js", () => ({
  LogWriter: vi.fn(),
  createPhaseLogFromTiming: vi.fn(),
}));

vi.mock("./state-manager.js", () => ({
  StateManager: vi.fn(),
}));

vi.mock("../shutdown.js", () => ({
  ShutdownManager: class {
    isShuttingDown = false;
    onShutdown = vi.fn();
  },
}));

vi.mock("./git-diff-utils.js", () => ({
  getGitDiffStats: vi.fn(),
  getCommitHash: vi.fn(),
}));

vi.mock("./error-classifier.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./error-classifier.js")>()),
  classifyError: vi.fn().mockReturnValue("unknown"),
}));

// The engine under wiring test — a spy so we can assert both *whether* and
// *with what args* it is invoked. parseNonGoals is kept trivial (the seam only
// forwards its output).
vi.mock("./ready-gate.js", () => ({
  runReadyGate: vi.fn(),
  parseNonGoals: vi.fn(() => ["do not auto-merge"]),
}));

// The gate seam fetches the issue body for Non-Goals via GitHubProvider — mock
// it so no `gh` shell-out happens under test.
vi.mock("./platforms/github.js", () => ({
  GitHubProvider: class {
    fetchIssueBodySync = vi.fn(() => "## Out of scope\n- do not auto-merge");
  },
}));

// Policy source (AC-4): the run path takes policy from settings.ready.policy.
vi.mock("../settings.js", () => ({
  getSettings: vi.fn(async () => ({ ready: { policy: "a-plus" } })),
}));

import { executePhaseWithRetry } from "./phase-executor.js";
import { createPR } from "./worktree-manager.js";
import { runReadyGate } from "./ready-gate.js";
import { getSettings } from "../settings.js";
import { runIssueWithLogging } from "./batch-executor.js";

const mockExecutePhase = vi.mocked(executePhaseWithRetry);
const mockCreatePR = vi.mocked(createPR);
const mockRunReadyGate = vi.mocked(runReadyGate);
const mockGetSettings = vi.mocked(getSettings);

function makeConfig(overrides: Partial<ExecutionConfig> = {}): ExecutionConfig {
  return {
    phases: ["exec"],
    phaseTimeout: 1800,
    qualityLoop: false,
    maxIterations: 4,
    skipVerification: false,
    sequential: true,
    concurrency: 1,
    parallel: false,
    verbose: false,
    noSmartTests: false,
    dryRun: false,
    mcp: true,
    retry: true,
    ...overrides,
  };
}

function makeOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return { autoDetectPhases: false, ...overrides };
}

/** A stateManager stub that records the final status write. */
function makeStateManager() {
  return {
    getIssueState: vi.fn(async () => null),
    initializeIssue: vi.fn(async () => {}),
    updateWorktreeInfo: vi.fn(async () => {}),
    updatePhaseStatus: vi.fn(async () => {}),
    updateIssueStatus: vi.fn(async () => {}),
    updatePRInfo: vi.fn(async () => {}),
    updateResumeHandle: vi.fn(async () => {}),
  };
}

function makeCtx(
  overrides: {
    config?: Partial<ExecutionConfig>;
    options?: Partial<RunOptions>;
    stateManager?: ReturnType<typeof makeStateManager>;
  } = {},
): IssueExecutionContext {
  return {
    issueNumber: 817,
    title: "ready-gate wiring",
    labels: [],
    config: makeConfig(overrides.config),
    options: makeOptions(overrides.options),
    services: {
      logWriter: null,
      stateManager: overrides.stateManager ?? null,
    },
    worktree: { path: "/tmp/wt/817", branch: "feature/817" },
    baseBranch: "main",
  };
}

const cannedGate: ReadyResult = {
  issueNumber: 817,
  policy: "a-plus",
  ready: true,
  reason: "READY_FOR_MERGE",
  issueStatus: "waiting_for_human_merge",
  iterations: 2,
  finalVerdict: "READY_FOR_MERGE",
  autoFixed: ["gap A"],
  remaining: [],
  tokensUsed: 1234,
  report: "## sequant ready — Issue #817\n**✅ READY**",
};

function successResult(phase: string): PhaseResult {
  return {
    phase: phase as PhaseResult["phase"],
    success: true,
    durationSeconds: 5,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecutePhase.mockResolvedValue(successResult("exec"));
  mockRunReadyGate.mockResolvedValue(cannedGate);
  mockGetSettings.mockResolvedValue({ ready: { policy: "a-plus" } } as never);
});

describe("run --ready-gate wiring (#817)", () => {
  it("AC-5: does NOT invoke the gate when the flag is off", async () => {
    const state = makeStateManager();
    const result = await runIssueWithLogging(
      makeCtx({ config: { readyGate: false }, stateManager: state }),
    );

    expect(mockRunReadyGate).not.toHaveBeenCalled();
    expect(result.readyGate).toBeUndefined();
    // Byte-identical status write: standard success terminal state.
    expect(state.updateIssueStatus).toHaveBeenCalledWith(
      817,
      "ready_for_merge",
    );
    // PR body carries no gate report.
    expect(mockCreatePR.mock.calls[0]?.[8]).toBeUndefined();
  });

  it("AC-3/AC-1: invokes the gate when the flag is on and persists its terminal status", async () => {
    const state = makeStateManager();
    const result = await runIssueWithLogging(
      makeCtx({ config: { readyGate: true }, stateManager: state }),
    );

    expect(mockRunReadyGate).toHaveBeenCalledTimes(1);
    expect(result.readyGate).toEqual(cannedGate);
    // The gate owns the terminal status — never `ready_for_merge` (no auto-merge).
    expect(state.updateIssueStatus).toHaveBeenCalledWith(
      817,
      "waiting_for_human_merge",
    );
    expect(state.updateIssueStatus).not.toHaveBeenCalledWith(
      817,
      "ready_for_merge",
    );
  });

  it("AC-4: feeds the gate the `ready` machinery's args (policy from settings, budget disabled, cap from config)", async () => {
    await runIssueWithLogging(
      makeCtx({ config: { readyGate: true, maxIterations: 7 } }),
    );

    expect(mockRunReadyGate).toHaveBeenCalledTimes(1);
    const arg = mockRunReadyGate.mock.calls[0][0];
    expect(arg.policy).toBe("a-plus"); // ← settings.ready.policy
    expect(arg.maxIterations).toBe(7); // ← config.maxIterations
    expect(arg.tokenBudget).toBeUndefined(); // parity with `ready` sans --budget
    expect(arg.nonGoals).toEqual(["do not auto-merge"]); // parsed from body
    expect(arg.issueNumber).toBe(817);
    expect(arg.worktreePath).toBe("/tmp/wt/817");
  });

  it("AC-6: surfaces the gate report in the PR body", async () => {
    await runIssueWithLogging(makeCtx({ config: { readyGate: true } }));

    expect(mockCreatePR).toHaveBeenCalledTimes(1);
    // createPR's 10th positional arg is the readyGateReport.
    expect(mockCreatePR.mock.calls[0][8]).toBe(cannedGate.report);
  });

  it("gate failure is non-fatal — the run still reaches PR with the standard status", async () => {
    mockRunReadyGate.mockRejectedValueOnce(new Error("boom"));
    const state = makeStateManager();
    const result = await runIssueWithLogging(
      makeCtx({ config: { readyGate: true }, stateManager: state }),
    );

    expect(result.readyGate).toBeUndefined();
    expect(state.updateIssueStatus).toHaveBeenCalledWith(
      817,
      "ready_for_merge",
    );
    expect(mockCreatePR).toHaveBeenCalledTimes(1);
  });
});
