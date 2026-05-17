import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ExecutionConfig,
  PhaseResult,
  IssueExecutionContext,
} from "./types.js";
import type { RunOptions } from "./batch-executor.js";
import {
  buildLoopContext,
  emitProgressLine,
  withActivityHook,
} from "./batch-executor.js";

// Mock all heavy dependencies so we can test runIssueWithLogging in isolation

vi.mock("./phase-executor.js", () => ({
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

vi.mock("./error-classifier.js", () => ({
  classifyError: vi.fn().mockReturnValue("unknown"),
}));

import { executePhaseWithRetry } from "./phase-executor.js";
import { runIssueWithLogging } from "./batch-executor.js";

const mockExecutePhase = vi.mocked(executePhaseWithRetry);

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
