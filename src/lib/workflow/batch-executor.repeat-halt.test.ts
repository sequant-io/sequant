/**
 * #1646 AC-1 — the quality loop halts on a second consecutive `AC_NOT_MET`.
 *
 * Drives the real outer quality loop in `runIssueWithLogging` with
 * `executePhaseWithRetry` mocked and NO `modelLadder` configured: the halt is
 * a counter on the parsed QA verdict and must not depend on the ladder, which
 * #1647 removes. `/loop` dispatches are counted through the mocked executor,
 * as `batch-executor.model-ladder.test.ts` counts `exec` dispatches.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ExecutionConfig,
  PhaseResult,
  IssueExecutionContext,
  RunOptions,
} from "./types.js";
import type { StateManager } from "./state-manager.js";

vi.mock("./phase-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./phase-executor.js")>()),
  executePhaseWithRetry: vi.fn(),
  hasExecChanges: vi.fn().mockReturnValue(false),
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

vi.mock("./git-diff-utils.js", () => ({
  getGitDiffStats: vi.fn(),
  getCommitHash: vi.fn(),
  resolveDiffBase: vi.fn().mockReturnValue("origin/main"),
}));

import { executePhaseWithRetry } from "./phase-executor.js";
import { getCommitHash } from "./git-diff-utils.js";
import {
  runIssueWithLogging,
  recordIssueCompletion,
} from "./batch-executor.js";
import type { LogWriter } from "./log-writer.js";

const mockExecutePhase = vi.mocked(executePhaseWithRetry);
const mockCommitHash = vi.mocked(getCommitHash);

/** A QA result: verdict `undefined` models output with no parsable verdict. */
function qa(verdict: string | undefined, output = ""): PhaseResult {
  return {
    phase: "qa",
    success: verdict === "READY_FOR_MERGE",
    durationSeconds: 1,
    ...(verdict ? { verdict } : { error: "no parseable verdict" }),
    output,
  } as PhaseResult;
}

/**
 * Queue the QA results in order; `exec` and `loop` always pass. Returns the
 * mock so the caller can count dispatches by phase.
 */
function scriptPhases(qaResults: PhaseResult[]): void {
  const queue = [...qaResults];
  mockExecutePhase.mockImplementation(async (_issue, phase) => {
    if (phase === "qa") {
      const next = queue.shift();
      if (!next) throw new Error("unexpected extra qa dispatch");
      return next;
    }
    return { phase, success: true, durationSeconds: 1 } as PhaseResult;
  });
}

function dispatchCount(phase: string): number {
  return mockExecutePhase.mock.calls.filter((c) => c[1] === phase).length;
}

/** A minimal state manager whose issue declares AC-1..AC-3. */
function fakeStateManager(): StateManager {
  const methods: Record<string, unknown> = {
    getIssueState: vi.fn().mockResolvedValue({
      acceptanceCriteria: {
        items: ["AC-1", "AC-2", "AC-3"].map((id) => ({
          id,
          description: id,
          verificationMethod: "unit_test",
          status: "pending",
        })),
      },
    }),
  };
  return new Proxy(methods, {
    get: (target, prop: string) =>
      (target[prop] ??= vi.fn().mockResolvedValue(undefined)),
  }) as unknown as StateManager;
}

function makeCtx(
  config: Partial<ExecutionConfig> = {},
  stateManager: StateManager | null = null,
  snapshotProgressFn?: IssueExecutionContext["snapshotProgressFn"],
): IssueExecutionContext {
  return {
    issueNumber: 1646,
    title: "repeat halt",
    labels: [],
    config: {
      phases: ["exec", "qa"],
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
    options: { autoDetectPhases: false, noPr: true } as RunOptions,
    services: { logWriter: null, stateManager },
    worktree: { path: "/tmp/worktree-1646", branch: "feature/1646" },
    postComment: vi.fn().mockResolvedValue(undefined),
    ...(snapshotProgressFn ? { snapshotProgressFn } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The real loop emits SEQUANT_PROGRESS lines when SEQUANT_ORCHESTRATOR is
  // set; scrub it so a suite run inside `sequant run` spoofs no progress.
  vi.stubEnv("SEQUANT_ORCHESTRATOR", "");
  let n = 0;
  mockCommitHash.mockImplementation(() => `sha-${++n}`);
});

describe("1646 AC-1: ac_not_met_repeated halts the quality loop", () => {
  it("two consecutive AC_NOT_MET verdicts stop the loop before the second /loop spawn", async () => {
    scriptPhases([
      qa("AC_NOT_MET", "| AC-1 | NOT_MET |\n| AC-2 | MET |\n| AC-3 | ❌ |"),
      qa("AC_NOT_MET", "| AC-1 | MET |\n| AC-2 | MET |\n| AC-3 | NOT_MET |"),
    ]);

    const result = await runIssueWithLogging(makeCtx({}, fakeStateManager()));

    expect(result.success).toBe(false);
    expect(dispatchCount("qa")).toBe(2);
    // One fix pass after the first refusal; none after the second.
    expect(dispatchCount("loop")).toBe(1);
    expect(result.failureCategory).toBe("ac_not_met_repeated");
    expect(result.abortReason).toMatch(/^ac_not_met_repeated/);
    expect(result.abortReason).toContain("AC-1, AC-3");
    const bundle = result.evidenceBundle;
    expect(bundle?.reason).toBe("AC_NOT_MET_REPEATED");
    expect(bundle?.phase).toBe("qa");
    expect(bundle?.escalationHistory).toEqual([]);
    expect(bundle?.iterations).toEqual([
      {
        iteration: 1,
        sha: "sha-1",
        verdict: "AC_NOT_MET",
        failedAcs: ["AC-1", "AC-3"],
      },
      {
        iteration: 2,
        sha: "sha-2",
        verdict: "AC_NOT_MET",
        failedAcs: ["AC-3"],
      },
    ]);
    expect(bundle?.shasTried).toEqual(["sha-1", "sha-2"]);
  });

  it("a single AC_NOT_MET followed by a passing verdict does not halt", async () => {
    scriptPhases([qa("AC_NOT_MET"), qa("READY_FOR_MERGE")]);

    const result = await runIssueWithLogging(makeCtx());

    expect(result.success).toBe(true);
    expect(dispatchCount("loop")).toBe(1);
    expect(result.failureCategory).toBeUndefined();
    expect(result.abortReason).toBeUndefined();
    expect(result.evidenceBundle).toBeUndefined();
  });

  it("a null verdict between two refusals resets the count", async () => {
    scriptPhases([
      qa("AC_NOT_MET"),
      qa(undefined),
      qa("AC_NOT_MET"),
      qa("READY_FOR_MERGE"),
    ]);

    const result = await runIssueWithLogging(makeCtx({ maxIterations: 4 }));

    // No halt on the third verdict: the loop spends a fix pass after it and
    // reaches a fourth qa.
    expect(dispatchCount("qa")).toBe(4);
    expect(dispatchCount("loop")).toBe(3);
    expect(result.success).toBe(true);
    expect(result.failureCategory).toBeUndefined();
    expect(result.evidenceBundle).toBeUndefined();
  });

  it("halts with failedAcs empty when no AC record is available", async () => {
    scriptPhases([qa("AC_NOT_MET"), qa("AC_NOT_MET")]);

    const result = await runIssueWithLogging(makeCtx());

    expect(dispatchCount("loop")).toBe(1);
    expect(result.failureCategory).toBe("ac_not_met_repeated");
    expect(result.abortReason).toBe(
      "ac_not_met_repeated: AC_NOT_MET twice in qa at sha-1, sha-2",
    );
    expect(result.evidenceBundle?.iterations.map((it) => it.failedAcs)).toEqual(
      [[], []],
    );
  });

  it("with no ladder configured, the per-iteration snapshot is never taken (#971 AC-D2)", async () => {
    scriptPhases([qa("AC_NOT_MET"), qa("AC_NOT_MET")]);
    const snapshot = vi.fn(() => ({ sha: "frozen", dirty: [] }));

    const result = await runIssueWithLogging(makeCtx({}, null, snapshot));

    expect(result.failureCategory).toBe("ac_not_met_repeated");
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("the halt reaches the run log's issue entry with its abortReason and bundle", async () => {
    scriptPhases([qa("AC_NOT_MET"), qa("AC_NOT_MET")]);
    const result = await runIssueWithLogging(makeCtx());
    const logWriter = {
      setPRInfo: vi.fn(),
      markIssueFailed: vi.fn(),
      completeIssue: vi.fn(),
    };

    recordIssueCompletion(logWriter as unknown as LogWriter, result, 1646);

    expect(logWriter.markIssueFailed).toHaveBeenCalledWith(1646, {
      abortReason: result.abortReason,
      evidenceBundle: result.evidenceBundle,
    });
    expect(result.abortReason).toMatch(/^ac_not_met_repeated/);
  });
});
