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
  windowHaltResumeAtMs,
  withActivityHook,
  AUTO_WAIT_PROGRESS_LINE_INTERVAL_MS,
} from "./batch-executor.js";
import { AUTO_WAIT_BUFFER_MS } from "./phase-executor.js";
import { classifyError } from "./error-classifier.js";
import { readFileSync } from "node:fs";
import {
  BillingError,
  RateLimitError,
  TimeoutError,
  createRateLimitError,
} from "../errors.js";
import type { RateLimitInfoLike } from "../errors.js";

// Mock all heavy dependencies so we can test runIssueWithLogging in isolation

vi.mock("./phase-executor.js", async (importOriginal) => ({
  // Keep the real isWindowExhaustedRateLimit — #799's billing/window halt
  // predicate relies on it; only executePhaseWithRetry needs to be a spy.
  ...(await importOriginal<typeof import("./phase-executor.js")>()),
  executePhaseWithRetry: vi.fn(),
  // #920: default true (has commits) so every pre-existing PR-gate test keeps
  // exercising the create-PR path unchanged; the #920 describe block below
  // overrides per-test via `mockReturnValueOnce(false)`.
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
  // #964: postQaVerdictComment's commit-hash resolution calls this
  // unconditionally (not gated on logWriter, unlike the pre-existing
  // observability-log call site) — the mock previously omitted it because
  // nothing reached it under `logWriter: null` in these tests.
  resolveDiffBase: vi.fn(),
}));

// #964: postQaVerdictComment's postComment is injected via ctx.postComment
// (see makeCtx below) rather than mocking ./platforms/github.js — that module
// is also used unmocked by resolveSpecRecommendation elsewhere in this file,
// and a blanket mock there breaks those call sites.
const mockPostComment = vi.fn().mockResolvedValue(undefined);

// Keep the real errorTypeToCategory/ERROR_CATEGORIES — deriveFailureCategory
// (#761 AC-7) routes through them on every failure return — but stub
// classifyError so tests control the fallback classification.
vi.mock("./error-classifier.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./error-classifier.js")>()),
  classifyError: vi.fn().mockReturnValue("unknown"),
}));

import { executePhaseWithRetry, hasExecChanges } from "./phase-executor.js";
import { createPhaseLogFromTiming } from "./log-writer.js";
import {
  runIssueWithLogging,
  recordIssueCompletion,
} from "./batch-executor.js";
import { createPR } from "./worktree-manager.js";

const mockExecutePhase = vi.mocked(executePhaseWithRetry);
const mockCreatePR = vi.mocked(createPR);
const mockHasExecChanges = vi.mocked(hasExecChanges);

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
    postComment?: (issueNumber: number, body: string) => Promise<void>;
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
    ...(overrides.postComment ? { postComment: overrides.postComment } : {}),
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

  it("halts on the real 2026-07-18 capture (#782 — production sample, not synthetic)", () => {
    // Cross-file sibling of the #782 validation in phase-executor.test.ts.
    // #799's outer-loop halt consumes the same classifier, so the one real
    // rejection we have on file belongs here too: if SDK drift changed the
    // payload shape, this predicate would silently stop halting the -Q loop
    // and #799's "QA completed without a parseable verdict" mislabel returns.
    // Every other test around this one is synthetic.
    // Full write-up: docs/incidents/782/validation.md
    const capture = JSON.parse(
      readFileSync(
        new URL(
          "../../../docs/incidents/782/captures/2026-07-18/run-2026-07-18T16-05-05-43494f55-7967-40b9-b04d-e0fb10475255.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      issues: {
        phases: {
          durationSeconds: number;
          errorContext: { errorMetadata: RateLimitInfoLike };
        }[];
      }[];
    };
    const phase = capture.issues[0].phases[0];
    const structuredError = createRateLimitError(
      phase.errorContext.errorMetadata,
    );

    const result: PhaseResult = {
      phase: "spec",
      success: false,
      durationSeconds: phase.durationSeconds,
      error: structuredError.message,
      structuredError,
    };

    expect(isBillingOrWindowHalt(result)).toBe(true);
    // The halt reason surfaces the driver's real cause, not a downstream
    // "QA completed without a parseable verdict".
    expect(billingHaltReason(result)).toBe("Out of credits");
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

// #892 AC-1: the durable halt writes resumeAt = resetsAt + the auto-wait
// buffer, and ONLY for waitable-window halts — billing and transient failures
// must return null so no `windowHalt` record is ever written for them.
describe("windowHaltResumeAtMs (#892)", () => {
  it("computes resetsAt + AUTO_WAIT_BUFFER_MS for a waitable window (same clock as auto-wait)", () => {
    const resetsAtMs = Date.now() + 3 * 3_600_000; // window reopens in 3h
    const result: PhaseResult = {
      phase: "qa",
      success: false,
      durationSeconds: 5,
      error: "Rate limited",
      structuredError: createRateLimitError({
        rateLimitType: "five_hour",
        resetsAt: Math.floor(resetsAtMs / 1000), // SDK emits seconds
      }),
    };
    expect(windowHaltResumeAtMs(result)).toBe(
      Math.floor(resetsAtMs / 1000) * 1000 + AUTO_WAIT_BUFFER_MS,
    );
  });

  it("returns null for a billing failure — credits are purchased, not waited out", () => {
    const result: PhaseResult = {
      phase: "exec",
      success: false,
      durationSeconds: 5,
      structuredError: new BillingError("Out of credits", {
        // A real billing rejection can carry a reset time (#782); the gate is
        // the error type, not the timestamp.
        resetsAt: Math.floor((Date.now() + 3_600_000) / 1000),
        rateLimitType: "five_hour",
      }),
    };
    expect(windowHaltResumeAtMs(result)).toBeNull();
  });

  it("returns null for a transient (metadata-absent) rate limit", () => {
    const result: PhaseResult = {
      phase: "exec",
      success: false,
      durationSeconds: 5,
      structuredError: new RateLimitError("Rate limited"),
    };
    expect(windowHaltResumeAtMs(result)).toBeNull();
  });

  it("returns null for a generic failure", () => {
    const result: PhaseResult = {
      phase: "exec",
      success: false,
      durationSeconds: 5,
      error: "boom",
    };
    expect(windowHaltResumeAtMs(result)).toBeNull();
  });
});

// #892 AC-1 wiring: the durable halt record must actually be written by
// `runIssueWithLogging` at both halt sites (spec path and main phase loop) —
// the pure helper above proves the arithmetic, these prove the producer.
describe("runIssueWithLogging — windowHalt persistence (#892)", () => {
  /** Minimal StateManager double: only the methods the flow under test calls. */
  function makeStateManager() {
    return {
      updatePhaseStatus: vi.fn(),
      updateResumeHandle: vi.fn(),
      updateWindowHalt: vi.fn(),
      clearWindowHalt: vi.fn(),
      updateAutoWait: vi.fn(),
      updateIssueStatus: vi.fn(),
      updateWorktreeInfo: vi.fn(),
      updatePRInfo: vi.fn(),
    };
  }

  function windowHaltResult(phase: string, resetsAtSec: number): PhaseResult {
    return {
      phase: phase as PhaseResult["phase"],
      success: false,
      durationSeconds: 5,
      error: "Rate limited",
      structuredError: createRateLimitError({
        rateLimitType: "five_hour",
        resetsAt: resetsAtSec,
      }),
    };
  }

  it("a waitable-window SPEC halt writes windowHalt with resetsAt + buffer", async () => {
    const resetsAtSec = Math.floor(Date.now() / 1000) + 3 * 3600;
    mockExecutePhase.mockResolvedValue(windowHaltResult("spec", resetsAtSec));
    const stateManager = makeStateManager();

    const ctx = makeCtx({
      issueNumber: 892,
      options: { autoDetectPhases: true },
    });
    ctx.services.stateManager = stateManager as never;
    const result = await runIssueWithLogging(ctx);

    expect(result.success).toBe(false);
    expect(stateManager.updateWindowHalt).toHaveBeenCalledWith(
      892,
      "spec",
      resetsAtSec * 1000 + AUTO_WAIT_BUFFER_MS,
    );
    expect(stateManager.clearWindowHalt).not.toHaveBeenCalled();
  });

  it("a waitable-window MAIN-LOOP halt (exec) writes windowHalt for that phase", async () => {
    const resetsAtSec = Math.floor(Date.now() / 1000) + 3 * 3600;
    mockExecutePhase
      .mockResolvedValueOnce(successResult("spec"))
      .mockResolvedValueOnce(windowHaltResult("exec", resetsAtSec));
    const stateManager = makeStateManager();

    const ctx = makeCtx({
      issueNumber: 892,
      options: { autoDetectPhases: true },
    });
    ctx.services.stateManager = stateManager as never;
    await runIssueWithLogging(ctx);

    expect(stateManager.updateWindowHalt).toHaveBeenCalledWith(
      892,
      "exec",
      resetsAtSec * 1000 + AUTO_WAIT_BUFFER_MS,
    );
  });

  it("a billing halt clears instead of writing — credits cannot be waited out", async () => {
    mockExecutePhase.mockResolvedValue({
      phase: "spec",
      success: false,
      durationSeconds: 5,
      error: "Out of credits",
      structuredError: new BillingError("Out of credits"),
    } as PhaseResult);
    const stateManager = makeStateManager();

    const ctx = makeCtx({
      issueNumber: 892,
      options: { autoDetectPhases: true },
    });
    ctx.services.stateManager = stateManager as never;
    await runIssueWithLogging(ctx);

    expect(stateManager.updateWindowHalt).not.toHaveBeenCalled();
    expect(stateManager.clearWindowHalt).toHaveBeenCalledWith(892);
  });

  it("phase success clears any stale windowHalt (progress resets the record)", async () => {
    mockExecutePhase.mockResolvedValue(successResult("exec"));
    const stateManager = makeStateManager();

    const ctx = makeCtx({
      issueNumber: 892,
      options: { autoDetectPhases: true },
    });
    ctx.services.stateManager = stateManager as never;
    await runIssueWithLogging(ctx);

    expect(stateManager.updateWindowHalt).not.toHaveBeenCalled();
    expect(stateManager.clearWindowHalt).toHaveBeenCalledWith(892);
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

  it("#937 AC-3: excludes a `document`-tagged finding from QA Gaps, keeps `fix_now`", () => {
    const result = buildLoopContext(
      makeResult({
        summary: {
          acMet: 1,
          acTotal: 3,
          gaps: ["fix the retry cap", "cosmetic duplication in foo.ts"],
          suggestions: [],
          findings: [
            {
              category: "requirement_gap",
              evidence: "AC-2 row: NOT_MET",
              description: "fix the retry cap",
              recommendedAction: "fix_now",
            },
            {
              category: "repository_gap",
              evidence: "foo.ts:20",
              description: "cosmetic duplication in foo.ts",
              recommendedAction: "document",
            },
          ],
        },
      }),
    );
    expect(result).toContain("- fix the retry cap");
    expect(result).not.toContain("cosmetic duplication in foo.ts");
  });

  it("#937 AC-3: omits the QA Gaps section entirely when every gap is filtered out", () => {
    const result = buildLoopContext(
      makeResult({
        summary: {
          acMet: 1,
          acTotal: 1,
          gaps: ["polish only"],
          suggestions: [],
          findings: [
            {
              category: "repository_gap",
              evidence: "e",
              description: "polish only",
              recommendedAction: "document",
            },
          ],
        },
      }),
    );
    expect(result).not.toContain("QA Gaps:");
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

describe("#964: qa-verdict comment on the standard (non-ready-gate) run path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostComment.mockResolvedValue(undefined);
    mockCreatePR.mockReturnValue({
      attempted: true,
      success: true,
      prNumber: 964,
      prUrl: "https://example.test/pr/964",
    });
  });

  it("AC-1: posts a comment with the parsed verdict, AC coverage, and the SEQUANT_QA_VERDICT marker after a successful qa phase", async () => {
    mockExecutePhase.mockImplementation(async (_i, phase) => {
      if (phase === "qa") {
        return {
          phase: "qa",
          success: true,
          durationSeconds: 5,
          verdict: "AC_MET_BUT_NOT_A_PLUS",
          summary: {
            acMet: 3,
            acTotal: 5,
            gaps: ["AC-4 not addressed"],
            suggestions: ["Add a regression test"],
          },
        } as PhaseResult;
      }
      return successResult(phase as string);
    });

    await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 964,
        config: { phases: ["qa"], qualityLoop: false, maxIterations: 1 },
        options: { autoDetectPhases: false },
        postComment: mockPostComment,
      }),
      worktree: { path: "/tmp/wt-964", branch: "feature/964" },
    });

    expect(mockPostComment).toHaveBeenCalledTimes(1);
    const [issueArg, body] = mockPostComment.mock.calls[0];
    expect(issueArg).toBe(964);
    expect(body).toContain("AC_MET_BUT_NOT_A_PLUS");
    expect(body).toContain("3/5 met");
    expect(body).toContain("AC-4 not addressed");
    expect(body).toMatch(
      /<!-- SEQUANT_QA_VERDICT: \{"verdict":"AC_MET_BUT_NOT_A_PLUS","commit":.*,"iteration":1\} -->/,
    );
  });

  it("AC-2 (regression, verbatim repro): a re-run computing a fresh, different verdict posts again — the fresh verdict is not left silently stale", async () => {
    // Mirrors the issue's repro: run 1 posts NEEDS_VERIFICATION (gated on
    // pending CI); a later re-run of the same command, with no new commits,
    // computes AC_MET_BUT_NOT_A_PLUS once CI resolves. Both must reach GitHub.
    const ctxFor = () => ({
      ...makeCtx({
        issueNumber: 226,
        config: { phases: ["qa"], qualityLoop: false, maxIterations: 1 },
        options: { autoDetectPhases: false },
        postComment: mockPostComment,
      }),
      worktree: { path: "/tmp/wt-226", branch: "feature/226" },
    });

    mockExecutePhase.mockImplementation(async (_i, phase) => {
      if (phase === "qa") {
        return {
          phase: "qa",
          success: true,
          durationSeconds: 5,
          verdict: "NEEDS_VERIFICATION",
        } as PhaseResult;
      }
      return successResult(phase as string);
    });
    await runIssueWithLogging(ctxFor());

    mockExecutePhase.mockImplementation(async (_i, phase) => {
      if (phase === "qa") {
        return {
          phase: "qa",
          success: true,
          durationSeconds: 5,
          verdict: "AC_MET_BUT_NOT_A_PLUS",
        } as PhaseResult;
      }
      return successResult(phase as string);
    });
    await runIssueWithLogging(ctxFor());

    expect(mockPostComment).toHaveBeenCalledTimes(2);
    expect(mockPostComment.mock.calls[0][1]).toContain("NEEDS_VERIFICATION");
    expect(mockPostComment.mock.calls[1][1]).toContain("AC_MET_BUT_NOT_A_PLUS");
  });

  it("AC-3: a comment-post failure is non-fatal — the run still reports success", async () => {
    mockPostComment.mockRejectedValueOnce(new Error("gh: rate limited"));
    mockExecutePhase.mockImplementation(async (_i, phase) => {
      if (phase === "qa") {
        return {
          phase: "qa",
          success: true,
          durationSeconds: 5,
          verdict: "AC_MET_BUT_NOT_A_PLUS",
        } as PhaseResult;
      }
      return successResult(phase as string);
    });

    const result = await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 965,
        config: { phases: ["qa"], qualityLoop: false, maxIterations: 1 },
        options: { autoDetectPhases: false },
        postComment: mockPostComment,
      }),
      worktree: { path: "/tmp/wt-965", branch: "feature/965" },
    });

    expect(mockPostComment).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it("AC-4: does not post when the qa phase fails, is turn-capped, or yields no parseable verdict", async () => {
    mockExecutePhase.mockImplementation(async (_i, phase) => {
      if (phase === "qa") {
        return {
          phase: "qa",
          success: false,
          durationSeconds: 5,
          error: "QA completed without a parseable verdict",
        } as PhaseResult;
      }
      return successResult(phase as string);
    });

    await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 966,
        config: { phases: ["qa"], qualityLoop: false, maxIterations: 1 },
        options: { autoDetectPhases: false },
        postComment: mockPostComment,
      }),
      worktree: { path: "/tmp/wt-966", branch: "feature/966" },
    });

    expect(mockPostComment).not.toHaveBeenCalled();

    // Turn-capped: also success:false (capped phases never reach the
    // success branch — see the #739 comment in batch-executor.ts).
    mockExecutePhase.mockImplementation(async (_i, phase) => {
      if (phase === "qa") {
        return {
          phase: "qa",
          success: false,
          durationSeconds: 5,
          capped: true,
        } as PhaseResult;
      }
      return successResult(phase as string);
    });

    await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 967,
        config: { phases: ["qa"], qualityLoop: false, maxIterations: 1 },
        options: { autoDetectPhases: false },
        postComment: mockPostComment,
      }),
      worktree: { path: "/tmp/wt-967", branch: "feature/967" },
    });

    expect(mockPostComment).not.toHaveBeenCalled();
  });
});

describe("#879: a failed createPR fails the run (AC-5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // All phases succeed; only PR creation varies per test.
    mockExecutePhase.mockResolvedValue(successResult("exec"));
  });

  it("returns success:false with prCreationError when createPR fails after passing QA", async () => {
    // The #879 repro: every phase passes, but the branch has no commits, so
    // `gh pr create` fails. Before #879 this printed a warning and the issue
    // still reported success. Now the issue result is a failure.
    mockCreatePR.mockReturnValue({
      attempted: true,
      success: false,
      error:
        "gh pr create failed: GraphQL: No commits between main and feature/879",
    });

    const result = await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 879,
        title: "PR failure fails the run",
        labels: ["bug"],
        config: { phases: ["exec", "qa"], qualityLoop: false },
        options: { autoDetectPhases: false },
      }),
      worktree: { path: "/tmp/wt-879", branch: "feature/879" },
    });

    expect(mockCreatePR).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.prCreationError).toContain("No commits between main");
  });

  it("keeps success:true and leaves prCreationError unset when createPR succeeds (control)", async () => {
    mockCreatePR.mockReturnValue({
      attempted: true,
      success: true,
      prNumber: 900,
      prUrl: "https://example.test/pr/900",
    });

    const result = await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 879,
        title: "PR succeeds",
        labels: ["bug"],
        config: { phases: ["exec", "qa"], qualityLoop: false },
        options: { autoDetectPhases: false },
      }),
      worktree: { path: "/tmp/wt-879", branch: "feature/879" },
    });

    expect(result.success).toBe(true);
    expect(result.prCreationError).toBeUndefined();
  });

  it("does not fail the run when --no-pr suppresses PR creation", async () => {
    // `--no-pr` means "don't judge me on PRs" — createPR is never attempted,
    // so a run with all phases passing stays successful.
    const result = await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 879,
        title: "no-pr run",
        labels: ["bug"],
        config: { phases: ["exec", "qa"], qualityLoop: false },
        options: { autoDetectPhases: false, noPr: true },
      }),
      worktree: { path: "/tmp/wt-879", branch: "feature/879" },
    });

    expect(mockCreatePR).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.prCreationError).toBeUndefined();
  });
});

describe("#920: PR creation skipped when the branch has zero commits ahead of base", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecutePhase.mockResolvedValue(successResult("spec"));
  });

  it("AC-1/AC-5: a spec-only run (as CI's sequant:spec-only label produces) with zero commits skips PR creation and reports success", async () => {
    mockHasExecChanges.mockReturnValue(false);

    const result = await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 920,
        title: "spec-only run",
        labels: ["bug"],
        config: { phases: ["spec"], qualityLoop: false },
        options: { autoDetectPhases: false },
      }),
      worktree: { path: "/tmp/wt-920", branch: "feature/920" },
    });

    expect(mockCreatePR).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.prNumber).toBeUndefined();
    expect(result.prCreationError).toBeUndefined();
  });

  it("AC-2: records a non-silent skip reason on the result", async () => {
    mockHasExecChanges.mockReturnValue(false);

    const result = await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 920,
        title: "spec-only run",
        labels: ["bug"],
        config: { phases: ["spec"], qualityLoop: false },
        options: { autoDetectPhases: false },
      }),
      worktree: { path: "/tmp/wt-920", branch: "feature/920" },
    });

    expect(result.prSkippedReason).toContain("no commits ahead of");
  });

  it("AC-4: a qa-only resume on a branch with commits ahead of base still creates a PR", async () => {
    mockHasExecChanges.mockReturnValue(true);
    mockCreatePR.mockReturnValue({
      attempted: true,
      success: true,
      prNumber: 921,
      prUrl: "https://example.test/pr/921",
    });

    const result = await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 920,
        title: "qa-only resume with commits",
        labels: ["bug"],
        config: { phases: ["qa"], qualityLoop: false },
        options: { autoDetectPhases: false },
      }),
      worktree: { path: "/tmp/wt-920b", branch: "feature/920b" },
    });

    expect(mockCreatePR).toHaveBeenCalledTimes(1);
    expect(result.prNumber).toBe(921);
    expect(result.prSkippedReason).toBeUndefined();
  });

  it("AC-6: an attempted-and-failed PR still yields a concrete (non-empty) failureCategory", async () => {
    mockHasExecChanges.mockReturnValue(true);
    mockCreatePR.mockReturnValue({
      attempted: true,
      success: false,
      error: "gh pr create failed: some real failure",
    });

    const result = await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 920,
        title: "PR create fails",
        labels: ["bug"],
        config: { phases: ["exec", "qa"], qualityLoop: false },
        options: { autoDetectPhases: false },
      }),
      worktree: { path: "/tmp/wt-920c", branch: "feature/920c" },
    });

    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("pr_creation");
  });

  it("AC-7: --no-pr semantics are unchanged — the commits-ahead check is never consulted", async () => {
    mockHasExecChanges.mockReturnValue(false);

    const result = await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 920,
        title: "no-pr on zero commits",
        labels: ["bug"],
        config: { phases: ["spec"], qualityLoop: false },
        options: { autoDetectPhases: false, noPr: true },
      }),
      worktree: { path: "/tmp/wt-920d", branch: "feature/920d" },
    });

    // `--no-pr` already rules out PR creation, so the new gate must short-
    // circuit before ever calling hasExecChanges — proves this AC didn't
    // grow a second, redundant reason for the skip.
    expect(mockHasExecChanges).not.toHaveBeenCalled();
    expect(mockCreatePR).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.prSkippedReason).toBeUndefined();
  });

  it("AC-8: the skip reason names the worktree's custom base branch, not a hardcoded main", async () => {
    mockHasExecChanges.mockReturnValue(false);

    const result = await runIssueWithLogging({
      ...makeCtx({
        issueNumber: 920,
        title: "custom base",
        labels: ["bug"],
        config: { phases: ["spec"], qualityLoop: false },
        options: { autoDetectPhases: false },
      }),
      worktree: { path: "/tmp/wt-920e", branch: "feature/920e" },
      baseBranch: "feature/epic",
    });

    expect(result.prSkippedReason).toContain("feature/epic");
  });
});

describe("recordIssueCompletion (#879) — shared completion sequence", () => {
  // Guards the LIVE path: RunOrchestrator.executeOneIssue and executeBatch both
  // finalize an issue through this ONE helper, so a PR-creation failure flips the
  // run-log status on every path. The #879 defect was that flip living only in
  // executeBatch while the orchestrator path (the real `sequant run`) omitted it.
  function spyLogWriter() {
    return {
      setPRInfo: vi.fn(),
      markIssueFailed: vi.fn(),
      completeIssue: vi.fn(),
    };
  }

  function issueResult(overrides: Partial<IssueResult>): IssueResult {
    return {
      issueNumber: 765,
      success: true,
      phaseResults: [],
      durationSeconds: 1,
      ...overrides,
    };
  }

  it("marks the issue failed (before completing it) when the result carries a prCreationError", () => {
    const lw = spyLogWriter();
    recordIssueCompletion(
      lw as unknown as Parameters<typeof recordIssueCompletion>[0],
      issueResult({
        issueNumber: 765,
        success: false,
        prCreationError: "gh pr create failed: No commits between main and …",
      }),
      765,
    );

    expect(lw.markIssueFailed).toHaveBeenCalledWith(765);
    expect(lw.completeIssue).toHaveBeenCalledWith(765);
    // The failure flip must precede completion, or completeIssue snapshots the
    // still-"success" status.
    expect(lw.markIssueFailed.mock.invocationCallOrder[0]).toBeLessThan(
      lw.completeIssue.mock.invocationCallOrder[0],
    );
  });

  it("records PR info and does NOT mark failed when the PR was created", () => {
    const lw = spyLogWriter();
    recordIssueCompletion(
      lw as unknown as Parameters<typeof recordIssueCompletion>[0],
      issueResult({
        issueNumber: 766,
        success: true,
        prNumber: 900,
        prUrl: "https://example.test/pr/900",
      }),
      766,
    );

    expect(lw.setPRInfo).toHaveBeenCalledWith(
      900,
      "https://example.test/pr/900",
      766,
    );
    expect(lw.markIssueFailed).not.toHaveBeenCalled();
    expect(lw.completeIssue).toHaveBeenCalledWith(766);
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

// =============================================================================
// #860 — withActivityHook: orchestrator waiting lines + state transitions
// =============================================================================

describe("withActivityHook (#860): auto-wait visibility on the orchestrator channel", () => {
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

  const ORIGINAL_ORCH = process.env.SEQUANT_ORCHESTRATOR;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let captured: string[];

  function setup(orchestrated: boolean): void {
    captured = [];
    if (orchestrated) {
      process.env.SEQUANT_ORCHESTRATOR = "1";
    } else {
      delete process.env.SEQUANT_ORCHESTRATOR;
    }
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        captured.push(String(chunk));
        return true;
      });
  }

  function teardown(): void {
    stderrSpy.mockRestore();
    if (ORIGINAL_ORCH === undefined) {
      delete process.env.SEQUANT_ORCHESTRATOR;
    } else {
      process.env.SEQUANT_ORCHESTRATOR = ORIGINAL_ORCH;
    }
    vi.useRealTimers();
  }

  function waitingLines(): Array<Record<string, unknown>> {
    return captured
      .filter((l) => l.startsWith("SEQUANT_PROGRESS:"))
      .map(
        (l) =>
          JSON.parse(l.slice("SEQUANT_PROGRESS:".length)) as Record<
            string,
            unknown
          >,
      )
      .filter((p) => p.event === "waiting");
  }

  function notice(overrides: Record<string, unknown> = {}) {
    return {
      issueNumber: 860,
      phase: "exec",
      wakeAtMs: 1_784_910_600_000,
      remainingMs: 3_600_000,
      message: "Rate limited · auto-wait 1/2",
      done: false,
      ...overrides,
    } as Parameters<NonNullable<ExecutionConfig["onAutoWait"]>>[0];
  }

  it("emits a SEQUANT_PROGRESS waiting line under SEQUANT_ORCHESTRATOR even with no onProgress", () => {
    setup(true);
    try {
      const wrapped = withActivityHook(baseConfig, 860, "exec", undefined);
      expect(wrapped).not.toBe(baseConfig); // orchestrator channel is a consumer
      wrapped.onAutoWait!(notice());

      const lines = waitingLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        issue: 860,
        phase: "exec",
        event: "waiting",
        wakeAtMs: 1_784_910_600_000,
        remainingMs: 3_600_000,
      });
    } finally {
      teardown();
    }
  });

  it("throttles the per-15s ticks to one line per interval, then emits again after it", () => {
    setup(true);
    vi.useFakeTimers();
    vi.setSystemTime(1_784_900_000_000);
    try {
      const wrapped = withActivityHook(baseConfig, 860, "exec", undefined);
      wrapped.onAutoWait!(notice());
      wrapped.onAutoWait!(notice({ remainingMs: 3_585_000 }));
      wrapped.onAutoWait!(notice({ remainingMs: 3_570_000 }));
      expect(waitingLines()).toHaveLength(1); // ticks inside the window absorbed

      vi.setSystemTime(1_784_900_000_000 + AUTO_WAIT_PROGRESS_LINE_INTERVAL_MS);
      wrapped.onAutoWait!(notice({ remainingMs: 3_540_000 }));
      expect(waitingLines()).toHaveLength(2);
    } finally {
      teardown();
    }
  });

  it("the terminal notice emits a final line without wakeAtMs and re-arms for a second wait", () => {
    setup(true);
    try {
      const wrapped = withActivityHook(baseConfig, 860, "exec", undefined);
      wrapped.onAutoWait!(notice());
      wrapped.onAutoWait!(notice({ done: true, remainingMs: 0 }));

      const lines = waitingLines();
      expect(lines).toHaveLength(2);
      expect(lines[1].wakeAtMs).toBeUndefined();
      expect(lines[1].remainingMs).toBe(0);

      // A second wait announces immediately (throttle reset on done).
      wrapped.onAutoWait!(notice({ wakeAtMs: 1_784_920_000_000 }));
      expect(waitingLines()).toHaveLength(3);
    } finally {
      teardown();
    }
  });

  it("a terminal notice with no preceding wait emits nothing", () => {
    setup(true);
    try {
      const wrapped = withActivityHook(baseConfig, 860, "exec", undefined);
      wrapped.onAutoWait!(notice({ done: true, remainingMs: 0 }));
      expect(waitingLines()).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  it("calls onWaitTransition on wait start (wakeAtMs) and wake (null), once each", () => {
    setup(false); // works without the orchestrator channel too
    try {
      const transitions: Array<number | null> = [];
      const wrapped = withActivityHook(
        baseConfig,
        860,
        "exec",
        undefined,
        (wakeAtMs) => transitions.push(wakeAtMs),
      );
      expect(wrapped).not.toBe(baseConfig); // the transition callback is a consumer
      wrapped.onAutoWait!(notice());
      wrapped.onAutoWait!(notice({ remainingMs: 3_585_000 }));
      wrapped.onAutoWait!(notice({ done: true, remainingMs: 0 }));

      expect(transitions).toEqual([1_784_910_600_000, null]);
      expect(waitingLines()).toHaveLength(0); // no orchestrator env → no lines
    } finally {
      teardown();
    }
  });

  it("still returns the input config unchanged when there is no consumer at all", () => {
    setup(false);
    try {
      const wrapped = withActivityHook(baseConfig, 1, "exec", undefined);
      expect(wrapped).toBe(baseConfig);
    } finally {
      teardown();
    }
  });
});

describe("runIssueWithLogging — #915: effort escalation on quality-loop retries", () => {
  /** exec always passes; qa fails until `qaFailures` is exhausted. */
  function scriptFailThenRecover(qaFailures: number) {
    let qaSeen = 0;
    mockExecutePhase.mockReset();
    mockExecutePhase.mockImplementation((async (
      _issueNumber: number,
      phase: string,
    ) => {
      if (phase === "loop") return { phase: "loop", success: true };
      if (phase === "qa") {
        qaSeen++;
        return qaSeen <= qaFailures
          ? { phase: "qa", success: false, error: "AC not met" }
          : { phase: "qa", success: true };
      }
      return { phase, success: true };
    }) as never);
  }

  it("AC-2: escalation disabled — every dispatch, including the retry, carries no phasePolicies key at all", async () => {
    scriptFailThenRecover(1);
    await runIssueWithLogging(
      makeCtx({
        issueNumber: 915,
        config: {
          phases: ["exec", "qa"],
          qualityLoop: true,
          maxIterations: 3,
          effortEscalation: false,
        },
        options: { autoDetectPhases: false },
      }),
    );

    const qaConfigs = mockExecutePhase.mock.calls
      .filter((c) => c[1] === "qa")
      .map((c) => c[2] as ExecutionConfig);
    expect(qaConfigs).toHaveLength(2); // first attempt + one retry
    for (const cfg of qaConfigs) {
      expect(cfg.phasePolicies?.qa?.effort).toBeUndefined();
    }
  });

  it("AC-3/AC-7: escalation enabled — iteration 1 (first attempt) is unescalated; the retried iteration 2 escalates EVERY phase it dispatches, not just the one that failed", async () => {
    // The outer quality loop re-runs the WHOLE `phases` list on every
    // iteration (it does not resume from the failure point), so "iteration >
    // 1" is the only retry signal available at dispatch time — it applies per
    // ITERATION, not per specific-phase-that-previously-failed. `exec`
    // succeeded on iteration 1 but is still part of the retried iteration 2,
    // so it escalates too (from the AC-5 default, since it has no configured
    // effort). This is the correct, intended scope (AC-7 guarantees the
    // escalation doesn't leak into a *later, separate* phase execution beyond
    // this retried iteration — see effort-escalation.test.ts).
    scriptFailThenRecover(1);
    await runIssueWithLogging(
      makeCtx({
        issueNumber: 915,
        config: {
          phases: ["exec", "qa"],
          qualityLoop: true,
          maxIterations: 3,
          effortEscalation: true,
          phasePolicies: { qa: { effort: "high" } },
        },
        options: { autoDetectPhases: false },
      }),
    );

    const qaEfforts = mockExecutePhase.mock.calls
      .filter((c) => c[1] === "qa")
      .map((c) => (c[2] as ExecutionConfig).phasePolicies?.qa?.effort);
    expect(qaEfforts).toEqual(["high", "xhigh"]);

    const execEfforts = mockExecutePhase.mock.calls
      .filter((c) => c[1] === "exec")
      .map((c) => (c[2] as ExecutionConfig).phasePolicies?.exec?.effort);
    // Unconfigured phase: iteration 1 stays key-absent (AC-2), iteration 2
    // escalates from the AC-5 default (high → xhigh).
    expect(execEfforts).toEqual([undefined, "xhigh"]);
  });

  it("AC-6: base already at max — the retried dispatch stays at max, never overflows the ladder", async () => {
    scriptFailThenRecover(1);
    await runIssueWithLogging(
      makeCtx({
        issueNumber: 915,
        config: {
          phases: ["exec", "qa"],
          qualityLoop: true,
          maxIterations: 3,
          effortEscalation: true,
          phasePolicies: { qa: { effort: "max" } },
        },
        options: { autoDetectPhases: false },
      }),
    );

    const qaEfforts = mockExecutePhase.mock.calls
      .filter((c) => c[1] === "qa")
      .map((c) => (c[2] as ExecutionConfig).phasePolicies?.qa?.effort);
    expect(qaEfforts).toEqual(["max", "max"]);
  });
});
