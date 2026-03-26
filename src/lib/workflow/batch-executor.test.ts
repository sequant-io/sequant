import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExecutionConfig, PhaseResult } from "./types.js";
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
        42,
        makeConfig(),
        null, // logWriter
        null, // stateManager
        "Fix crash",
        ["bug"],
        makeOptions(),
      );

      // executePhaseWithRetry should be called for exec and qa (no spec)
      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["exec", "qa"]);
    });

    it("skips spec for 'fix' label", async () => {
      await runIssueWithLogging(
        43,
        makeConfig(),
        null,
        null,
        "Fix typo",
        ["fix"],
        makeOptions(),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["exec", "qa"]);
    });

    it("skips spec for 'hotfix' label", async () => {
      await runIssueWithLogging(
        44,
        makeConfig(),
        null,
        null,
        "Hotfix deploy",
        ["hotfix"],
        makeOptions(),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["exec", "qa"]);
    });
  });

  describe("AC-1: isDocs shortcut", () => {
    it("skips spec for 'docs' label → phases are [exec, qa]", async () => {
      await runIssueWithLogging(
        50,
        makeConfig(),
        null,
        null,
        "Update readme",
        ["docs"],
        makeOptions(),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["exec", "qa"]);
    });

    it("skips spec for 'documentation' label", async () => {
      await runIssueWithLogging(
        51,
        makeConfig(),
        null,
        null,
        "Add docs",
        ["documentation"],
        makeOptions(),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["exec", "qa"]);
    });
  });

  describe("AC-2: issueConfig.issueType set to 'docs' for docs labels", () => {
    it("passes issueType 'docs' to executePhaseWithRetry when docs label present", async () => {
      await runIssueWithLogging(
        60,
        makeConfig(),
        null,
        null,
        "Docs update",
        ["docs"],
        makeOptions(),
      );

      // The 3rd argument to executePhaseWithRetry is the config
      for (const call of mockExecutePhase.mock.calls) {
        const passedConfig = call[2] as ExecutionConfig;
        expect(passedConfig.issueType).toBe("docs");
      }
    });

    it("passes issueType 'docs' for 'documentation' label", async () => {
      await runIssueWithLogging(
        61,
        makeConfig(),
        null,
        null,
        "Add documentation",
        ["documentation"],
        makeOptions(),
      );

      for (const call of mockExecutePhase.mock.calls) {
        const passedConfig = call[2] as ExecutionConfig;
        expect(passedConfig.issueType).toBe("docs");
      }
    });

    it("passes issueType 'docs' for 'readme' label", async () => {
      await runIssueWithLogging(
        62,
        makeConfig(),
        null,
        null,
        "Update README",
        ["readme"],
        makeOptions(),
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
        70,
        makeConfig(),
        null,
        null,
        "Add feature",
        ["enhancement"],
        makeOptions(),
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
        71,
        makeConfig(),
        null,
        null,
        "Fix bug",
        ["bug"],
        makeOptions(),
      );

      for (const call of mockExecutePhase.mock.calls) {
        const passedConfig = call[2] as ExecutionConfig;
        expect(passedConfig.issueType).toBeUndefined();
      }
    });

    it("does not set issueType for empty labels", async () => {
      await runIssueWithLogging(
        72,
        makeConfig(),
        null,
        null,
        "Something",
        [],
        makeOptions(),
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
        80,
        makeConfig(),
        null,
        null,
        "Fix docs bug",
        ["bug", "docs"],
        makeOptions(),
      );

      // Bug shortcut fires first (if/else chain), so phases = [exec, qa]
      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["exec", "qa"]);
    });

    it("still sets issueType to 'docs' even when bug shortcut fires", async () => {
      await runIssueWithLogging(
        81,
        makeConfig(),
        null,
        null,
        "Fix docs bug",
        ["bug", "docs"],
        makeOptions(),
      );

      // issueConfig is built independently at L691-698, so docs label still sets issueType
      for (const call of mockExecutePhase.mock.calls) {
        const passedConfig = call[2] as ExecutionConfig;
        expect(passedConfig.issueType).toBe("docs");
      }
    });
  });

  describe("AC-5 (derived): case-insensitive label matching", () => {
    it("detects uppercase 'BUG' label as bug shortcut", async () => {
      await runIssueWithLogging(
        90,
        makeConfig(),
        null,
        null,
        "Fix crash",
        ["BUG"],
        makeOptions(),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["exec", "qa"]);
    });

    it("detects uppercase 'DOCS' label and sets issueType", async () => {
      await runIssueWithLogging(
        91,
        makeConfig(),
        null,
        null,
        "Update docs",
        ["DOCS"],
        makeOptions(),
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
        92,
        makeConfig(),
        null,
        null,
        "Add docs",
        ["Documentation"],
        makeOptions(),
      );

      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["exec", "qa"]);
    });
  });

  describe("AC-6 (derived): autoDetectPhases = false skips label shortcuts", () => {
    it("uses explicit phases when autoDetectPhases is false", async () => {
      await runIssueWithLogging(
        100,
        makeConfig({ phases: ["exec", "qa"] }),
        null,
        null,
        "Bug fix",
        ["bug"],
        makeOptions({ autoDetectPhases: false }),
      );

      // Should use the config's explicit phases, not detect from labels
      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["exec", "qa"]);
    });

    it("runs spec when autoDetectPhases is false even with bug label", async () => {
      await runIssueWithLogging(
        101,
        makeConfig({ phases: ["spec", "exec", "qa"] }),
        null,
        null,
        "Bug fix",
        ["bug"],
        makeOptions({ autoDetectPhases: false }),
      );

      // Should use explicit phases including spec
      const calledPhases = mockExecutePhase.mock.calls.map((c) => c[1]);
      expect(calledPhases).toEqual(["spec", "exec", "qa"]);
    });
  });
});
