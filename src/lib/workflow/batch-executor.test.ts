import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ExecutionConfig,
  PhaseResult,
  IssueExecutionContext,
} from "./types.js";
import type { RunOptions } from "./batch-executor.js";

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

vi.mock("../phase-spinner.js", () => {
  return {
    PhaseSpinner: class MockPhaseSpinner {
      start = vi.fn();
      succeed = vi.fn();
      fail = vi.fn();
    },
  };
});

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
  describe("AC-1: isSimpleBugFix shortcut", () => {
    it("skips spec for 'bug' label → phases are [exec, qa]", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 42,
          title: "Fix crash",
          labels: ["bug"],
        }),
      );

      // executePhaseWithRetry should be called for exec and qa (no spec)
      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["exec", "qa"]);
    });

    it("skips spec for 'fix' label", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 43,
          title: "Fix typo",
          labels: ["fix"],
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["exec", "qa"]);
    });

    it("skips spec for 'hotfix' label", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 44,
          title: "Hotfix deploy",
          labels: ["hotfix"],
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["exec", "qa"]);
    });

    it("skips spec for 'patch' label", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 45,
          title: "Patch release",
          labels: ["patch"],
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["exec", "qa"]);
    });
  });

  describe("AC-1: isDocs shortcut", () => {
    it("skips spec for 'docs' label → phases are [exec, qa]", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 50,
          title: "Update readme",
          labels: ["docs"],
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["exec", "qa"]);
    });

    it("skips spec for 'documentation' label", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 51,
          title: "Add docs",
          labels: ["documentation"],
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["exec", "qa"]);
    });

    it("skips spec for 'readme' label", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 52,
          title: "Update README",
          labels: ["readme"],
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["exec", "qa"]);
    });
  });

  describe("AC-2: issueConfig.issueType set to 'docs' for docs labels", () => {
    it("passes issueType 'docs' to executePhaseWithRetry when docs label present", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 60,
          title: "Docs update",
          labels: ["docs"],
        }),
      );

      // The 3rd argument to executePhaseWithRetry is the config
      for (const call of mockExecutePhase.mock.calls) {
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

      for (const call of mockExecutePhase.mock.calls) {
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

      for (const call of mockExecutePhase.mock.calls) {
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

  describe("AC-4: bug labels take precedence over docs labels in phase selection", () => {
    it("uses bug shortcut phases when both bug and docs labels present", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 80,
          title: "Fix docs bug",
          labels: ["bug", "docs"],
        }),
      );

      // Bug shortcut fires first (if/else chain), so phases = [exec, qa]
      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["exec", "qa"]);
    });

    it("still sets issueType to 'docs' even when bug shortcut fires", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 81,
          title: "Fix docs bug",
          labels: ["bug", "docs"],
        }),
      );

      // issueConfig is built independently, so docs label still sets issueType
      for (const call of mockExecutePhase.mock.calls) {
        const passedConfig = call[2] as ExecutionConfig;
        expect(passedConfig.issueType).toBe("docs");
      }
    });
  });

  describe("AC-5 (derived): case-insensitive label matching", () => {
    it("detects uppercase 'BUG' label as bug shortcut", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 90,
          title: "Fix crash",
          labels: ["BUG"],
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["exec", "qa"]);
    });

    it("detects uppercase 'DOCS' label and sets issueType", async () => {
      await runIssueWithLogging(
        makeCtx({
          issueNumber: 91,
          title: "Update docs",
          labels: ["DOCS"],
        }),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["exec", "qa"]);

      for (const call of mockExecutePhase.mock.calls) {
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
      expect(calledPhases).toEqual(["exec", "qa"]);
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

  describe("AC-6 (derived): autoDetectPhases = false skips label shortcuts", () => {
    it("uses explicit phases when autoDetectPhases is false", async () => {
      // Use ["qa"] only — bug shortcut would produce ["exec", "qa"],
      // so this distinguishes explicit phases from shortcut
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
});
