import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ExecutionConfig,
  PhaseResult,
  IssueExecutionContext,
} from "./types.js";
import type { RunOptions } from "./batch-executor.js";
import {
  billingHaltReason,
  buildLoopContext,
  deriveFailureCategory,
  emitProgressLine,
  isBillingOrWindowHalt,
  withActivityHook,
} from "./batch-executor.js";
import { classifyError } from "./error-classifier.js";
import { BillingError, RateLimitError, TimeoutError } from "../errors.js";

// Mock all heavy dependencies so we can test runIssueWithLogging in isolation

vi.mock("./phase-executor.js", async (importOriginal) => ({
  // Keep the real isWindowExhaustedRateLimit — #799's billing/window halt
  // predicate relies on it; only executePhaseWithRetry needs to be a spy.
  ...(await importOriginal<typeof import("./phase-executor.js")>()),
  executePhaseWithRetry: vi.fn(),
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

vi.mock("./state-manager.js", () => ({
  StateManager: vi.fn(),
}));

vi.mock("../shutdown.js", () => {
  return {
    ShutdownManager: class MockShutdownManager {
      isShuttingDown = false;
      onShutdown = vi.fn();
    },
  };
});

vi.mock("./git-diff-utils.js", () => ({
  getGitDiffStats: vi.fn(),
  getCommitHash: vi.fn(),
}));

// Keep the real errorTypeToCategory/ERROR_CATEGORIES — deriveFailureCategory
// (#761 AC-7) routes through them on every failure return — but stub
// classifyError so tests control the fallback classification.
vi.mock("./error-classifier.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./error-classifier.js")>()),
  classifyError: vi.fn().mockReturnValue("unknown"),
}));

import { executePhaseWithRetry } from "./phase-executor.js";
import { createPhaseLogFromTiming } from "./log-writer.js";
import { runIssueWithLogging } from "./batch-executor.js";
import { createPR } from "./worktree-manager.js";

const mockExecutePhase = vi.mocked(executePhaseWithRetry);
const mockCreatePR = vi.mocked(createPR);

/** Build a minimal ExecutionConfig for testing */
function makeConfig(overrides: Partial<ExecutionConfig> = {}): ExecutionConfig {
  return {
    phases: ["spec", "exec", "qa"],
    phaseTimeout: 1800,
    qualityLoop: false,
    maxIterations: 1,
    skipVerification: false,
    sequential: false,
    concurrency: 3,
    parallel: false,
    verbose: false,
    noSmartTests: false,
    dryRun: false,
    mcp: true,
    retry: true,
    ...overrides,
  };
}

/** Build minimal RunOptions for testing */
function makeOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    autoDetectPhases: true,
    ...overrides,
  };
}

/** Build an IssueExecutionContext for testing */
function makeCtx(
  overrides: {
    issueNumber?: number;
    config?: Partial<ExecutionConfig>;
    title?: string;
    labels?: string[];
    options?: Partial<RunOptions>;
  } = {},
): IssueExecutionContext {
  return {
    issueNumber: overrides.issueNumber ?? 1,
    title: overrides.title ?? "Test issue",
    labels: overrides.labels ?? [],
    config: makeConfig(overrides.config),
    options: makeOptions(overrides.options),
    services: {
      logWriter: null,
      stateManager: null,
    },
  };
}

/** Build a successful PhaseResult */
function successResult(phase: string): PhaseResult {
  return {
    phase: phase as PhaseResult["phase"],
    success: true,
    durationSeconds: 10,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: all phases succeed
  mockExecutePhase.mockResolvedValue(successResult("exec"));
});

describe("runIssueWithLogging — label-based phase shortcuts", () => {
  // #533: bug/docs labels no longer short-circuit spec. Under autoDetectPhases
  // mode, spec runs first, then the remaining phases come from the spec
  // recommendation (or, if unparseable, from detectPhasesFromLabels with spec
  // filtered out). With the default mock returning successResult("exec") and
  // no parseable workflow, bug/docs issues produce the full [spec, exec, qa].
  describe("#533: bug labels include spec by default", () => {
    it("runs spec → exec → qa for 'bug' label", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 42,
          title: "Fix crash",
          labels: ["bug"],
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["spec", "exec", "qa"]);
    });

    it("runs spec → exec → qa for 'fix' label", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 43,
          title: "Fix typo",
          labels: ["fix"],
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["spec", "exec", "qa"]);
    });

    it("runs spec → exec → qa for 'hotfix' label", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 44,
          title: "Hotfix deploy",
          labels: ["hotfix"],
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["spec", "exec", "qa"]);
    });

    it("runs spec → exec → qa for 'patch' label", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 45,
          title: "Patch release",
          labels: ["patch"],
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["spec", "exec", "qa"]);
    });
  });

  describe("#533: docs labels include spec by default", () => {
    it("runs spec → exec → qa for 'docs' label", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 50,
          title: "Update readme",
          labels: ["docs"],
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["spec", "exec", "qa"]);
    });

    it("runs spec → exec → qa for 'documentation' label", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 51,
          title: "Add docs",
          labels: ["documentation"],
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["spec", "exec", "qa"]);
    });

    it("runs spec → exec → qa for 'readme' label", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 52,
          title: "Update README",
          labels: ["readme"],
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["spec", "exec", "qa"]);
    });
  });

  describe("AC-2: issueConfig.issueType set to 'docs' for docs labels", () => {
    // #533: Spec now runs for docs-labeled issues under autoDetectPhases.
    // Spec is executed before issueConfig is built, so the spec call receives
    // the base config without issueType. issueType is propagated to exec/qa
    // calls (and any other post-spec phases) via issueConfig. The assertions
    // filter out the spec call to verify issueType propagation downstream.
    const nonSpec = (calls: typeof mockExecutePhase.mock.calls) =>
      calls.filter((c) => c[1] !== "spec");

    it("passes issueType 'docs' to executePhaseWithRetry when docs label present", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 60,
          title: "Docs update",
          labels: ["docs"],
        }),
      );

      const postSpecCalls = nonSpec(mockExecutePhase.mock.calls);
      expect(postSpecCalls.length).toBeGreaterThan(0);
      for (const call of postSpecCalls) {
        const passedConfig = call[2] as ExecutionConfig;
        expect(passedConfig.issueType).toBe("docs");
      }
    });

    it("passes issueType 'docs' for 'documentation' label", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 61,
          title: "Add documentation",
          labels: ["documentation"],
        }),
      );

      const postSpecCalls = nonSpec(mockExecutePhase.mock.calls);
      expect(postSpecCalls.length).toBeGreaterThan(0);
      for (const call of postSpecCalls) {
        const passedConfig = call[2] as ExecutionConfig;
        expect(passedConfig.issueType).toBe("docs");
      }
    });

    it("passes issueType 'docs' for 'readme' label", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 62,
          title: "Update README",
          labels: ["readme"],
        }),
      );

      const postSpecCalls = nonSpec(mockExecutePhase.mock.calls);
      expect(postSpecCalls.length).toBeGreaterThan(0);
      for (const call of postSpecCalls) {
        const passedConfig = call[2] as ExecutionConfig;
        expect(passedConfig.issueType).toBe("docs");
      }
    });
  });

  describe("AC-3: no issueType when non-docs labels present", () => {
    it("does not set issueType for 'enhancement' label", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 70,
          title: "Add feature",
          labels: ["enhancement"],
        }),
      );

      // With autoDetectPhases and 'enhancement', spec runs first.
      // After spec, the function parses workflow from output.
      // Since our mock returns no output, it falls back to label detection
      // which returns spec → exec → qa (filtered to exec → qa since spec ran).
      // All calls should have the original config without issueType.
      for (const call of mockExecutePhase.mock.calls) {
        const passedConfig = call[2] as ExecutionConfig;
        expect(passedConfig.issueType).toBeUndefined();
      }
    });

    it("does not set issueType for 'bug' label (bug shortcut, not docs)", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 71,
          title: "Fix bug",
          labels: ["bug"],
        }),
      );

      for (const call of mockExecutePhase.mock.calls) {
        const passedConfig = call[2] as ExecutionConfig;
        expect(passedConfig.issueType).toBeUndefined();
      }
    });

    it("does not set issueType for empty labels", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 72,
          title: "Something",
          labels: [],
        }),
      );

      for (const call of mockExecutePhase.mock.calls) {
        const passedConfig = call[2] as ExecutionConfig;
        expect(passedConfig.issueType).toBeUndefined();
      }
    });
  });

  describe("AC-4: bug + docs combined labels (#533: no phase-selection precedence)", () => {
    // #533 removed the bug/docs phase shortcuts, so neither label wins a
    // phase-selection "precedence" — both now produce the default workflow.
    // issueType propagation still fires for any label in DOCS_LABELS.
    it("runs spec → exec → qa when both bug and docs labels present", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 80,
          title: "Fix docs bug",
          labels: ["bug", "docs"],
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["spec", "exec", "qa"]);
    });

    it("still sets issueType to 'docs' on post-spec calls when docs label is present", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 81,
          title: "Fix docs bug",
          labels: ["bug", "docs"],
        }),
      );

      // issueConfig is built after spec runs; it still propagates issueType
      // to exec/qa when a docs label is present.
      const postSpecCalls = mockExecutePhase.mock.calls.filter(
        (c) => c[1] !== "spec",
      );
      expect(postSpecCalls.length).toBeGreaterThan(0);
      for (const call of postSpecCalls) {
        const passedConfig = call[2] as ExecutionConfig;
        expect(passedConfig.issueType).toBe("docs");
      }
    });
  });

  describe("AC-5 (derived): case-insensitive label matching", () => {
    it("detects uppercase 'BUG' label (still runs spec → exec → qa under #533)", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 90,
          title: "Fix crash",
          labels: ["BUG"],
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["spec", "exec", "qa"]);
    });

    it("detects uppercase 'DOCS' label and sets issueType on post-spec calls", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 91,
          title: "Update docs",
          labels: ["DOCS"],
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["spec", "exec", "qa"]);

      const postSpecCalls = mockExecutePhase.mock.calls.filter(
        (c) => c[1] !== "spec",
      );
      for (const call of postSpecCalls) {
        const passedConfig = call[2] as ExecutionConfig;
        expect(passedConfig.issueType).toBe("docs");
      }
    });

    it("detects mixed-case 'Documentation' label", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 92,
          title: "Add docs",
          labels: ["Documentation"],
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["spec", "exec", "qa"]);
    });
  });

  describe("exact matching (#461): substring labels do NOT trigger shortcuts", () => {
    it("'dispatch' label does not trigger bug shortcut despite containing 'patch'", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 110,
          title: "Dispatch event",
          labels: ["dispatch"],
        }),
      );

      // #461 switched to exact match — "dispatch" no longer matches "patch"
      // Spec runs because no shortcut fires, then fallback detection runs
      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toContain("spec");
    });

    it("'redocs-system' label does not trigger docs shortcut despite containing 'doc'", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 111,
          title: "Redocs system",
          labels: ["redocs-system"],
        }),
      );

      // #461 switched to exact match — "redocs-system" no longer matches "doc"
      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toContain("spec");
    });
  });

  describe("AC-6 (derived): autoDetectPhases = false bypasses label-based auto-detection", () => {
    it("uses explicit phases when autoDetectPhases is false", async () => {
      // Use ["qa"] only — auto-detection would produce ["spec", "exec", "qa"]
      // for a bug-labeled issue, so this distinguishes explicit-phase mode
      // from auto-detect mode (#533).
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 100,
          config: { phases: ["qa"] },
          title: "Bug fix",
          labels: ["bug"],
          options: { autoDetectPhases: false },
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["qa"]);
    });

    it("runs spec when autoDetectPhases is false even with bug label", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 101,
          config: { phases: ["spec", "exec", "qa"] },
          title: "Bug fix",
          labels: ["bug"],
          options: { autoDetectPhases: false },
        }),
      );

      // Should use explicit phases including spec
      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["spec", "exec", "qa"]);
    });
  });

  // #656 AC-1: phasePauseHandle is forwarded to executePhaseWithRetry at every
  // call site (spec, phase loop, /loop). The handle is the 7th positional
  // argument (`spinner`) — assert it lands on every call so the renderer's
  // pause/resume protocol cannot regress to dead code again.
  describe("#656 AC-1: phasePauseHandle forwarded at every call site", () => {
    it("forwards the handle to spec, exec, and qa calls", async () => {
      const handle = { pause: vi.fn(), resume: vi.fn() };
      await runIssueWithLogging({
        ...makeCtx({
          issueNumber: 656,
          title: "Wire pause handle",
          labels: ["bug"],
        }),
        phasePauseHandle: handle,
      });

      // Every executePhaseWithRetry invocation gets the same handle in
      // argument position 6 (issueNumber, phase, config, sessionId,
      // worktreePath, shutdownManager, spinner).
      expect(mockExecutePhase.mock.calls.length).toBeGreaterThan(0);
      for (const call of mockExecutePhase.mock.calls) {
        expect(call[6]).toBe(handle);
      }
    });

    it("forwards undefined when no handle is wired (quiet/TUI modes)", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 657,
          title: "No renderer",
          labels: ["bug"],
        }),
      );

      for (const call of mockExecutePhase.mock.calls) {
        expect(call[6]).toBeUndefined();
      }
    });

    it("forwards the handle to the loop phase when quality loop triggers", async () => {
      const handle = { pause: vi.fn(), resume: vi.fn() };
      // QA fails on first attempt, then loop runs, then qa retries and passes.
      mockExecutePhase.mockReset();
      mockExecutePhase.mockImplementation(async (_i, phase) => {
        if (phase === "qa") {
          // First qa returns failure with AC_NOT_MET, triggering /loop.
          // Second qa (post-loop) passes.
          const callIdx = mockExecutePhase.mock.calls.filter(
            (c) => c[1] === "qa",
          ).length;
          if (callIdx === 1) {
            return {
              phase: "qa",
              success: false,
              durationSeconds: 10,
              verdict: "AC_NOT_MET",
            } as PhaseResult;
          }
          return successResult("qa");
        }
        return successResult(phase as string);
      });

      await runIssueWithLogging({
        ...makeCtx({
          issueNumber: 658,
          title: "Loop forward",
          labels: ["bug"],
          config: { qualityLoop: true, maxIterations: 2 },
        }),
        phasePauseHandle: handle,
      });

      const loopCalls = mockExecutePhase.mock.calls.filter(
        (c) => c[1] === "loop",
      );
      expect(loopCalls.length).toBeGreaterThan(0);
      for (const call of loopCalls) {
        expect(call[6]).toBe(handle);
      }
    });
  });
});

// #739 AC-3: a turn-capped phase surfaces a distinct "partial output preserved"
// signal (not a generic failure), persists the partial output + capped marker,
// and halts the run cleanly for resume.
describe("runIssueWithLogging — #739: turn-capped phase signal (AC-3)", () => {
  it("emits a distinct capped progress signal, logs the capped marker, and halts", async () => {
    const cappedResult: PhaseResult = {
      phase: "exec",
      success: false,
      durationSeconds: 120,
      capped: true,
      output: "partial work before turn cap",
    };
    mockExecutePhase.mockReset();
    mockExecutePhase.mockResolvedValue(cappedResult);

    const onProgress = vi.fn();
    const logPhase = vi.fn();

    const result = await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 739,
        title: "Capped phase",
        config: { phases: ["exec", "qa"] },
        options: { autoDetectPhases: false },
      }),
      onProgress,
      services: {
        logWriter: { logPhase } as never,
        stateManager: null,
      },
    });

    // Distinct signal: the failed event carries the capped message, not "unknown".
    const failedCall = onProgress.mock.calls.find(
      (c) => c[1] === "exec" && c[2] === "failed",
    );
    expect(failedCall).toBeDefined();
    expect((failedCall![3] as { error: string }).error).toMatch(/turn cap/i);

    // Partial output preserved in the phase results (state).
    const execResult = result.phaseResults.find((p) => p.phase === "exec");
    expect(execResult?.capped).toBe(true);
    expect(execResult?.output).toBe("partial work before turn cap");

    // Phase log marks it capped (status stays "failure", no new enum value).
    const loggedOptions = vi
      .mocked(createPhaseLogFromTiming)
      .mock.calls.map((c) => c[5]);
    expect(loggedOptions.some((o) => o?.capped === true)).toBe(true);

    // Run halts cleanly: the downstream qa phase never runs.
    const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
    expect(calledPhases).toEqual(["exec"]);
    expect(result.success).toBe(false);
  });

  it("skips the quality loop on a capped phase (halts instead of looping on partial work)", async () => {
    // With the quality loop enabled, a genuine qa failure would spawn /loop. A
    // capped qa must NOT — partial output is incomplete, so we halt for resume.
    mockExecutePhase.mockReset();
    mockExecutePhase.mockResolvedValue({
      phase: "qa",
      success: false,
      durationSeconds: 120,
      capped: true,
      output: "partial qa",
    } as PhaseResult);

    const result = await runIssueWithLogging(
      makeCtx({
        issueNumber: 740,
        title: "Capped qa with quality loop",
        config: {
          phases: ["qa"],
          qualityLoop: true,
          maxIterations: 3,
        },
        options: { autoDetectPhases: false },
      }),
    );

    const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
    // No "loop" phase spawned, and qa ran exactly once (no loop iteration).
    expect(calledPhases).toEqual(["qa"]);
    expect(calledPhases).not.toContain("loop");
    expect(result.success).toBe(false);
  });

  it("surfaces the capped signal and log marker on a capped spec phase (sibling site)", async () => {
    // The spec phase has its own failure handling, separate from the main phase
    // loop. A capped spec must get the same distinct signal + `capped` log marker
    // (and halt) — otherwise a capped spec is indistinguishable from a generic
    // failure. autoDetectPhases:true is what routes through the spec block.
    mockExecutePhase.mockReset();
    mockExecutePhase.mockResolvedValue({
      phase: "spec",
      success: false,
      durationSeconds: 120,
      capped: true,
      output: "partial spec",
    } as PhaseResult);

    const onProgress = vi.fn();
    const logPhase = vi.fn();

    const result = await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 741,
        title: "Capped spec phase",
        options: { autoDetectPhases: true },
      }),
      onProgress,
      services: {
        logWriter: { logPhase } as never,
        stateManager: null,
      },
    });

    // Distinct capped signal on the spec failed event.
    const specFailed = onProgress.mock.calls.find(
      (c) => c[1] === "spec" && c[2] === "failed",
    );
    expect(specFailed).toBeDefined();
    expect((specFailed![3] as { error: string }).error).toMatch(/turn cap/i);

    // Spec phase log carries the capped marker.
    const loggedOptions = vi
      .mocked(createPhaseLogFromTiming)
      .mock.calls.map((c) => c[5]);
    expect(loggedOptions.some((o) => o?.capped === true)).toBe(true);

    // Halts on the capped spec: only the spec phase ran, partial output preserved.
    const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
    expect(calledPhases).toEqual(["spec"]);
    const specResult = result.phaseResults.find((p) => p.phase === "spec");
    expect(specResult?.capped).toBe(true);
    expect(specResult?.output).toBe("partial spec");
    expect(result.success).toBe(false);
  });
});

// #799: a billing / out-of-credits failure (or a window-exhausted rate limit)
// under the `-Q` quality loop must halt immediately — like the #739 turn cap —
// instead of spawning /loop and burning the remaining iterations, which
// mislabels the halt as a downstream "unparseable verdict".
describe("runIssueWithLogging — #799: billing / rate-limit-window fail-fast under -Q", () => {
  it("halts the outer quality loop on a BillingError exec (no second attempt, no /loop)", async () => {
    const billingResult: PhaseResult = {
      phase: "exec",
      success: false,
      durationSeconds: 5,
      error: "Out of credits",
      structuredError: new BillingError("Out of credits"),
    };
    mockExecutePhase.mockReset();
    mockExecutePhase.mockResolvedValue(billingResult);

    const onProgress = vi.fn();
    // Spy state manager so AC-4 (resumable, not a hard failure) can be asserted
    // on the actual status write, not just the returned success flag.
    const updateIssueStatus = vi.fn();
    const stateManager = {
      getIssueState: vi.fn(),
      initializeIssue: vi.fn(),
      updateIssueStatus,
      updatePRInfo: vi.fn(),
      updatePhaseStatus: vi.fn(),
      updateResumeHandle: vi.fn(),
      updateWorktreeInfo: vi.fn(),
    };

    const result = await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 799,
        title: "Out of credits under -Q",
        config: {
          phases: ["exec", "qa"],
          qualityLoop: true,
          maxIterations: 3,
        },
        options: { autoDetectPhases: false },
      }),
      onProgress,
      services: {
        logWriter: null,
        stateManager: stateManager as never,
      },
    });

    // AC-1: exec ran exactly once — no /loop spawn, no second exec attempt.
    const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
    expect(calledPhases).toEqual(["exec"]);
    expect(calledPhases).not.toContain("loop");

    // AC-3: the failed event names the real cause, not a downstream verdict error.
    const failedCall = onProgress.mock.calls.find(
      (c) => c[1] === "exec" && c[2] === "failed",
    );
    expect(failedCall).toBeDefined();
    expect((failedCall![3] as { error: string }).error).toMatch(
      /out of credits/i,
    );

    // AC-3: metrics category is `billing` (via deriveFailureCategory).
    expect(result.failureCategory).toBe("billing");
    // AC-4: not a hard success; final state is `in_progress` (resumable), and
    // it is never marked `ready_for_merge` — so a re-run resumes the link.
    expect(result.success).toBe(false);
    const finalStatuses = updateIssueStatus.mock.calls.map((c) => c[1]);
    expect(finalStatuses).toContain("in_progress");
    expect(finalStatuses).not.toContain("ready_for_merge");
  });

  it("halts on a window-exhausted rate limit and surfaces the reset time exactly once (rate-limit variant)", async () => {
    // resetsAt an hour out (in seconds) → window exhausted, not transient. The
    // driver already formats the reset time INTO result.error (see
    // formatRateLimitMessage / claude-code driver), so billingHaltReason must
    // surface it verbatim — NOT re-append a second, timezone-inconsistent copy.
    const resetsAtSeconds = Math.floor(Date.now() / 1000) + 3600;
    const rateLimitResult: PhaseResult = {
      phase: "exec",
      success: false,
      durationSeconds: 5,
      error: "Rate limited — resets at 07-24 14:32",
      structuredError: new RateLimitError(
        "Rate limited — resets at 07-24 14:32",
        {
          resetsAt: resetsAtSeconds,
        },
      ),
    };
    mockExecutePhase.mockReset();
    mockExecutePhase.mockResolvedValue(rateLimitResult);

    const onProgress = vi.fn();

    const result = await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 800,
        title: "Rate-limit window under -Q",
        config: {
          phases: ["exec", "qa"],
          qualityLoop: true,
          maxIterations: 3,
        },
        options: { autoDetectPhases: false },
      }),
      onProgress,
    });

    const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
    expect(calledPhases).toEqual(["exec"]);
    expect(calledPhases).not.toContain("loop");

    // AC-3: failed event names the cause and includes the reset time — exactly
    // once (regression guard for the doubled-reset-time bug).
    const failedCall = onProgress.mock.calls.find(
      (c) => c[1] === "exec" && c[2] === "failed",
    );
    const failedError = (failedCall![3] as { error: string }).error;
    expect(failedError).toBe("Rate limited — resets at 07-24 14:32");
    expect(failedError.match(/resets at/gi)).toHaveLength(1);

    expect(result.failureCategory).toBe("rate_limit");
    expect(result.success).toBe(false);
  });

  it("surfaces the billing cause on a spec-phase failure and halts (sibling site)", async () => {
    // The spec phase has its own failure handling, separate from the main loop,
    // and early-returns on any failure (no /loop). A billing spec failure must
    // still name the real cause + record failureCategory `billing` — symmetric
    // with the #739 capped spec sibling. autoDetectPhases:true routes through
    // the spec block.
    mockExecutePhase.mockReset();
    mockExecutePhase.mockResolvedValue({
      phase: "spec",
      success: false,
      durationSeconds: 5,
      error: "Out of credits",
      structuredError: new BillingError("Out of credits"),
    } as PhaseResult);

    const onProgress = vi.fn();

    const result = await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 801,
        title: "Out of credits in spec",
        options: { autoDetectPhases: true },
      }),
      onProgress,
    });

    // Only spec ran — early return, no exec/qa/loop.
    const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
    expect(calledPhases).toEqual(["spec"]);
    expect(calledPhases).not.toContain("loop");

    const specFailed = onProgress.mock.calls.find(
      (c) => c[1] === "spec" && c[2] === "failed",
    );
    expect((specFailed![3] as { error: string }).error).toMatch(
      /out of credits/i,
    );
    expect(result.failureCategory).toBe("billing");
    expect(result.success).toBe(false);
  });

  it("does NOT halt on a transient (metadata-absent) rate limit (AC-2 fallback)", () => {
    // A rate limit with no resetsAt has no timing signal → keep today's
    // retry/loop behavior rather than skipping iterations.
    const transient: PhaseResult = {
      phase: "exec",
      success: false,
      durationSeconds: 5,
      structuredError: new RateLimitError("Rate limited"),
    };
    expect(isBillingOrWindowHalt(transient)).toBe(false);

    // A generic failure is likewise not a billing/window halt.
    const generic: PhaseResult = {
      phase: "exec",
      success: false,
      durationSeconds: 5,
      error: "boom",
    };
    expect(isBillingOrWindowHalt(generic)).toBe(false);
  });

  it("billingHaltReason falls back to the base message when no reset time is present", () => {
    const result: PhaseResult = {
      phase: "exec",
      success: false,
      durationSeconds: 5,
      error: "Out of credits",
      structuredError: new BillingError("Out of credits"),
    };
    expect(billingHaltReason(result)).toBe("Out of credits");
  });
});

// #766 AC-6: the loop phase must reach the run log. The writer/schema layer is
// covered in recovered-failure.integration.test.ts, but that test hand-writes
// the loop entry — it would pass even if batch-executor never logged one. These
// drive `runIssueWithLogging` through a real fail → loop → recover sequence and
// assert the PRODUCER: deleting the `logWriter.logPhase(loopPhaseLog)` call
// must fail here.
describe("runIssueWithLogging — #766: loop phase reaches the run log (AC-6)", () => {
  /**
   * `createPhaseLogFromTiming` is mocked module-wide, so give it an identifiable
   * return value: whatever it builds is what `logPhase` should receive.
   */
  function trackPhaseLogs(): { logPhase: ReturnType<typeof vi.fn> } {
    vi.mocked(createPhaseLogFromTiming).mockImplementation(((
      phase: string,
      issueNumber: number,
      startTime: Date,
      endTime: Date,
      status: string,
      options?: Record<string, unknown>,
    ) => ({
      phase,
      issueNumber,
      startTime,
      endTime,
      status,
      ...options,
    })) as never);
    return { logPhase: vi.fn() };
  }

  /** exec always passes; qa fails until `qaFailures` is exhausted. */
  function scriptFailThenRecover(qaFailures: number, loopResult: PhaseResult) {
    let qaSeen = 0;
    mockExecutePhase.mockReset();
    mockExecutePhase.mockImplementation((async (
      _ctx: unknown,
      phase: string,
    ) => {
      if (phase === "loop") return loopResult;
      if (phase === "qa") {
        qaSeen++;
        return qaSeen <= qaFailures
          ? {
              phase: "qa",
              success: false,
              durationSeconds: 5,
              error: "AC not met",
            }
          : { phase: "qa", success: true, durationSeconds: 5 };
      }
      return { phase, success: true, durationSeconds: 5 };
    }) as never);
  }

  it("logs a failed loop with phase, status, duration, and error", async () => {
    const { logPhase } = trackPhaseLogs();
    scriptFailThenRecover(1, {
      phase: "loop",
      success: false,
      durationSeconds: 12,
      error: "loop crashed",
    } as PhaseResult);

    await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 766,
        config: { phases: ["exec", "qa"], qualityLoop: true, maxIterations: 3 },
        options: { autoDetectPhases: false },
      }),
      services: { logWriter: { logPhase } as never, stateManager: null },
    });

    const loopLog = logPhase.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((l) => l?.phase === "loop");

    // The producer ran at all — this is what the writer-level test cannot see.
    expect(loopLog).toBeDefined();
    // AC-6's four required fields.
    expect(loopLog!.status).toBe("failure");
    expect(loopLog!.error).toBe("loop crashed");
    expect(loopLog!.startTime).toBeInstanceOf(Date);
    expect(loopLog!.endTime).toBeInstanceOf(Date);
    // Duration is derived by createPhaseLogFromTiming from these two.
    expect((loopLog!.endTime as Date).getTime()).toBeGreaterThanOrEqual(
      (loopLog!.startTime as Date).getTime(),
    );
  });

  it("maps a timed-out loop to `timeout`, not `failure`", async () => {
    const { logPhase } = trackPhaseLogs();
    scriptFailThenRecover(1, {
      phase: "loop",
      success: false,
      durationSeconds: 1800,
      error: "Timeout after 1800s",
    } as PhaseResult);

    await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 766,
        config: { phases: ["exec", "qa"], qualityLoop: true, maxIterations: 3 },
        options: { autoDetectPhases: false },
      }),
      services: { logWriter: { logPhase } as never, stateManager: null },
    });

    const loopLog = logPhase.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((l) => l?.phase === "loop");

    expect(loopLog).toBeDefined();
    expect(loopLog!.status).toBe("timeout");
  });

  it("logs a successful loop on the recovery path (#760's shape)", async () => {
    // qa fails once, the loop fixes it, iteration 2 passes. The loop entry must
    // still be in the log — it's the phase that decided the card's verdict.
    const { logPhase } = trackPhaseLogs();
    scriptFailThenRecover(1, {
      phase: "loop",
      success: true,
      durationSeconds: 30,
    } as PhaseResult);

    const result = await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 760,
        config: { phases: ["exec", "qa"], qualityLoop: true, maxIterations: 3 },
        options: { autoDetectPhases: false },
      }),
      services: { logWriter: { logPhase } as never, stateManager: null },
    });

    const loopLog = logPhase.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((l) => l?.phase === "loop");

    expect(loopLog).toBeDefined();
    expect(loopLog!.status).toBe("success");
    // And the run genuinely recovered — the premise of the #760 bug.
    expect(result.success).toBe(true);
  });
});

// #488: buildLoopContext — pure function, no mocking needed
describe("buildLoopContext", () => {
  function makeResult(overrides: Partial<PhaseResult> = {}): PhaseResult {
    return {
      phase: "qa",
      success: false,
      ...overrides,
    };
  }

  it("includes verdict when present", () => {
    const result = buildLoopContext(makeResult({ verdict: "AC_NOT_MET" }));
    expect(result).toContain("QA Verdict: AC_NOT_MET");
  });

  it("includes gaps as bullet list", () => {
    const result = buildLoopContext(
      makeResult({
        summary: {
          acMet: 1,
          acTotal: 3,
          gaps: ["gap1", "gap2"],
          suggestions: [],
        },
      }),
    );
    expect(result).toContain("- gap1");
    expect(result).toContain("- gap2");
  });

  it("includes suggestions", () => {
    const result = buildLoopContext(
      makeResult({
        summary: {
          acMet: 2,
          acTotal: 3,
          gaps: [],
          suggestions: ["fix X"],
        },
      }),
    );
    expect(result).toContain("- fix X");
  });

  it("includes error message", () => {
    const result = buildLoopContext(
      makeResult({ error: "QA verdict: AC_NOT_MET" }),
    );
    expect(result).toContain("Error: QA verdict: AC_NOT_MET");
  });

  it("truncates long output to 2000 chars", () => {
    const longOutput = "x".repeat(5000);
    const result = buildLoopContext(makeResult({ output: longOutput }));
    expect(result).toContain("Last output:");
    expect(result).not.toContain("x".repeat(2001));
    expect(result).toContain("x".repeat(2000));
  });

  it("handles minimal result with no optional fields", () => {
    const result = buildLoopContext(makeResult());
    expect(result).toContain('Previous phase "qa" failed.');
    expect(result).not.toContain("QA Verdict:");
    expect(result).not.toContain("QA Gaps:");
    expect(result).not.toContain("Suggestions:");
    expect(result).not.toContain("Error:");
    expect(result).not.toContain("Last output:");
  });
});

// =============================================================================
// #543 — withActivityHook: bridges agent onOutput to ProgressCallback("activity")
// =============================================================================

describe("withActivityHook (#543)", () => {
  const baseConfig = {
    phases: ["exec"],
    phaseTimeout: 60,
    qualityLoop: false,
    maxIterations: 1,
    skipVerification: false,
    sequential: false,
    concurrency: 3,
    parallel: false,
    verbose: false,
    noSmartTests: false,
    dryRun: false,
    mcp: false,
  } as ExecutionConfig;

  it("returns the input config unchanged when onProgress is undefined", () => {
    const wrapped = withActivityHook(baseConfig, 1, "exec", undefined);
    expect(wrapped).toBe(baseConfig);
    expect(wrapped.onActivity).toBeUndefined();
  });

  it("installs an onActivity hook that forwards activity events", () => {
    const onProgress = vi.fn();
    const wrapped = withActivityHook(baseConfig, 42, "exec", onProgress);
    expect(wrapped).not.toBe(baseConfig);
    expect(wrapped.onActivity).toBeTypeOf("function");

    wrapped.onActivity!("writing tests");
    expect(onProgress).toHaveBeenCalledWith(42, "exec", "activity", {
      text: "writing tests",
    });
  });

  it("swallows progress callback errors so the run is not disrupted", () => {
    const onProgress = vi.fn(() => {
      throw new Error("boom");
    });
    const wrapped = withActivityHook(baseConfig, 1, "exec", onProgress);
    expect(() => wrapped.onActivity!("anything")).not.toThrow();
    expect(onProgress).toHaveBeenCalled();
  });
});

// =============================================================================
// #624 Item 3 — emitProgressLine iteration propagation
// =============================================================================

describe("emitProgressLine (#624 Item 3): iteration field propagation", () => {
  const ORIGINAL_ORCH = process.env.SEQUANT_ORCHESTRATOR;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    process.env.SEQUANT_ORCHESTRATOR = "1";
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        captured.push(String(chunk));
        return true;
      });
  });

  // vitest's afterEach is implicit via spy restore; restore env after each.
  function teardown(): void {
    stderrSpy.mockRestore();
    if (ORIGINAL_ORCH === undefined) {
      delete process.env.SEQUANT_ORCHESTRATOR;
    } else {
      process.env.SEQUANT_ORCHESTRATOR = ORIGINAL_ORCH;
    }
  }

  function lastPayload(): Record<string, unknown> {
    const last = captured[captured.length - 1] ?? "";
    const m = last.match(/^SEQUANT_PROGRESS:(.+)\n$/);
    if (!m) throw new Error(`unexpected stderr: ${JSON.stringify(last)}`);
    return JSON.parse(m[1]) as Record<string, unknown>;
  }

  it("includes iteration in the JSON payload when extra.iteration is set", () => {
    try {
      emitProgressLine(604, "exec", "start", { iteration: 2 });
      const payload = lastPayload();
      expect(payload).toMatchObject({
        issue: 604,
        phase: "exec",
        event: "start",
        iteration: 2,
      });
    } finally {
      teardown();
    }
  });

  it("omits iteration key when extra is undefined", () => {
    try {
      emitProgressLine(604, "exec", "start");
      const payload = lastPayload();
      expect(payload.iteration).toBeUndefined();
      expect(payload).toMatchObject({
        issue: 604,
        phase: "exec",
        event: "start",
      });
    } finally {
      teardown();
    }
  });

  it("threads iteration alongside durationSeconds on complete events", () => {
    try {
      emitProgressLine(604, "exec", "complete", {
        durationSeconds: 42,
        iteration: 3,
      });
      const payload = lastPayload();
      expect(payload).toMatchObject({
        event: "complete",
        durationSeconds: 42,
        iteration: 3,
      });
    } finally {
      teardown();
    }
  });

  it("threads iteration alongside error on failed events", () => {
    try {
      emitProgressLine(604, "exec", "failed", {
        error: "boom",
        iteration: 2,
      });
      const payload = lastPayload();
      expect(payload).toMatchObject({
        event: "failed",
        error: "boom",
        iteration: 2,
      });
    } finally {
      teardown();
    }
  });

  it("is a no-op when SEQUANT_ORCHESTRATOR is unset", () => {
    try {
      delete process.env.SEQUANT_ORCHESTRATOR;
      emitProgressLine(604, "exec", "start", { iteration: 5 });
      expect(captured).toHaveLength(0);
    } finally {
      teardown();
    }
  });
});

describe("#749: AC_MET_BUT_NOT_A_PLUS breaks to PR (run-path integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreatePR.mockReturnValue({
      attempted: true,
      success: true,
      prNumber: 753,
      prUrl: "https://example.test/pr/753",
    });
  });

  it("creates the PR (no quality loop) when qa returns AC_MET_BUT_NOT_A_PLUS, forwarding the verdict to the PR body", async () => {
    // The phase-executor mapping (verdict → success) is unit-tested in
    // phase-executor.test.ts. This exercises the *consumer* seam: given a
    // success qa result carrying AC_MET_BUT_NOT_A_PLUS, the run path must reach
    // createPR (break-to-PR) rather than the quality loop, and surface the
    // verdict in the PR body (#749 Gap fixes).
    mockExecutePhase.mockImplementation(async (_i, phase) => {
      if (phase === "qa") {
        return {
          phase: "qa",
          success: true,
          durationSeconds: 10,
          verdict: "AC_MET_BUT_NOT_A_PLUS",
        } as PhaseResult;
      }
      return successResult(phase as string);
    });

    await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 749,
        title: "AC_MET_BUT_NOT_A_PLUS break-to-PR",
        labels: ["bug"],
        config: {
          phases: ["exec", "qa"],
          qualityLoop: true,
          maxIterations: 2,
        },
        options: { autoDetectPhases: false },
      }),
      worktree: { path: "/tmp/wt-749", branch: "feature/749" },
    });

    // Break-to-PR: createPR was called, and the loop never ran.
    expect(mockCreatePR).toHaveBeenCalledTimes(1);
    const loopCalls = mockExecutePhase.mock.calls.filter(
      (c) => c[1] === "loop",
    );
    expect(loopCalls).toHaveLength(0);

    // The verdict is forwarded as the 8th arg so the PR body surfaces the
    // "not A+" note.
    expect(mockCreatePR.mock.calls[0][7]).toBe("AC_MET_BUT_NOT_A_PLUS");
  });
});

describe("deriveFailureCategory (#761 AC-7)", () => {
  beforeEach(() => {
    vi.mocked(classifyError).mockClear();
  });

  const failedPhase = (overrides: Partial<PhaseResult>): PhaseResult =>
    ({ phase: "exec", success: false, ...overrides }) as PhaseResult;

  it("returns undefined when nothing failed", () => {
    expect(
      deriveFailureCategory([{ phase: "exec", success: true } as PhaseResult]),
    ).toBeUndefined();
    expect(deriveFailureCategory([])).toBeUndefined();
  });

  it("prefers the structured cause over stderr classification", () => {
    const category = deriveFailureCategory([
      failedPhase({
        structuredError: new RateLimitError("Rate limited"),
        stderrTail: ["something about a build error"],
      }),
    ]);

    expect(category).toBe("rate_limit");
    expect(vi.mocked(classifyError)).not.toHaveBeenCalled();
  });

  it("maps a billing failure to the billing category", () => {
    expect(
      deriveFailureCategory([
        failedPhase({ structuredError: new BillingError("Out of credits") }),
      ]),
    ).toBe("billing");
  });

  it("falls back to stderr classification when no structured cause exists", () => {
    vi.mocked(classifyError).mockReturnValueOnce(
      new TimeoutError("Timeout after 1800s"),
    );

    const category = deriveFailureCategory([
      failedPhase({ stderrTail: ["Timeout after 1800s"] }),
    ]);

    expect(category).toBe("timeout");
  });

  it("classifies the LAST non-loop failing attempt (#766 reverse scan)", () => {
    // First iteration timed out, loop recovered, final attempt rate-limited:
    // the recorded category must describe the halt, not the stale first try.
    const category = deriveFailureCategory([
      failedPhase({ structuredError: undefined }),
      { phase: "loop", success: true } as PhaseResult,
      failedPhase({ structuredError: new RateLimitError("Rate limited") }),
      { phase: "loop", success: false } as PhaseResult, // trailing loop noise
    ]);

    expect(category).toBe("rate_limit");
  });
});
