/**
 * Tests for RunOrchestrator (Issue #503)
 *
 * AC-1: RunOrchestrator owns full execution lifecycle
 * AC-3: RunOrchestrator accepts typed config (no Commander.js types)
 * AC-6: Existing tests pass + new orchestrator tests
 * AC-8: OrchestratorConfig validation rejects missing required fields
 * AC-9: RunOrchestrator never calls process.exit
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import type {
  ExecutionConfig,
  IssueResult,
  RunOptions,
} from "../src/lib/workflow/types.js";
import {
  RunOrchestrator,
  type OrchestratorConfig,
} from "../src/lib/workflow/run-orchestrator.js";

// Mock dependencies
vi.mock("../src/lib/workflow/batch-executor.js", () => ({
  executeBatch: vi.fn(),
  runIssueWithLogging: vi.fn(),
  getIssueInfo: vi.fn(),
  sortByDependencies: vi.fn((ids: number[]) => ids),
  parseBatches: vi.fn(),
}));

vi.mock("../src/lib/workflow/worktree-manager.js", () => ({
  ensureWorktrees: vi.fn(),
  ensureWorktreesChain: vi.fn(),
  detectDefaultBranch: vi.fn(() => "main"),
  getWorktreeDiffStats: vi.fn(() => ({ filesChanged: 0, linesAdded: 0 })),
}));

vi.mock("../src/lib/workflow/log-writer.js", () => ({
  LogWriter: vi.fn(),
}));

vi.mock("../src/lib/workflow/state-manager.js", () => ({
  StateManager: vi.fn(),
}));

vi.mock("../src/lib/workflow/state-utils.js", () => ({
  reconcileStateAtStartup: vi
    .fn()
    .mockResolvedValue({ success: true, advanced: [] }),
}));

vi.mock("../src/lib/workflow/git-diff-utils.js", () => ({
  getCommitHash: vi.fn(() => "abc123"),
}));

vi.mock("../src/lib/workflow/metrics-writer.js", () => ({
  MetricsWriter: vi.fn().mockImplementation(() => ({
    recordRun: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../src/lib/workflow/metrics-schema.js", () => ({
  determineOutcome: vi.fn(() => "success"),
}));

vi.mock("../src/lib/workflow/token-utils.js", () => ({
  getTokenUsageForRun: vi.fn(() => ({ tokensUsed: 0 })),
}));

vi.mock("../src/lib/shutdown.js", () => ({
  ShutdownManager: class MockShutdownManager {
    private _shuttingDown = false;
    get shuttingDown() {
      return this._shuttingDown;
    }
    get isShuttingDown() {
      return this._shuttingDown;
    }
    registerCleanup = vi.fn();
    dispose = vi.fn();
    setShuttingDown(v: boolean) {
      this._shuttingDown = v;
    }
  },
}));

vi.mock("p-limit", () => ({
  default: vi.fn(
    () =>
      <T>(fn: () => Promise<T>) =>
        fn(),
  ),
}));

import { runIssueWithLogging } from "../src/lib/workflow/batch-executor.js";
const mockRunIssue = vi.mocked(runIssueWithLogging);

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

/** Build minimal OrchestratorConfig for testing */
function makeOrchestratorConfig(
  overrides: Partial<OrchestratorConfig> = {},
): OrchestratorConfig {
  return {
    config: makeConfig(),
    options: { autoDetectPhases: true } as RunOptions,
    issueInfoMap: new Map([[123, { title: "Test issue", labels: [] }]]),
    worktreeMap: new Map(),
    services: {
      logWriter: null,
      stateManager: null,
    },
    packageManager: "npm",
    baseBranch: "main",
    ...overrides,
  };
}

/** Build a minimal IssueResult for testing */
function makeIssueResult(overrides: Partial<IssueResult> = {}): IssueResult {
  return {
    issueNumber: 123,
    success: true,
    phaseResults: [],
    durationSeconds: 0,
    ...overrides,
  };
}

describe("RunOrchestrator", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRunIssue.mockResolvedValue(makeIssueResult());
  });

  // ===== AC-1: Batch Mode =====
  describe("AC-1: Batch mode execution returns IssueResult[]", () => {
    it("should invoke execute and return IssueResult[] with correct structure", async () => {
      const cfg = makeOrchestratorConfig();
      mockRunIssue.mockResolvedValueOnce(makeIssueResult({ issueNumber: 123 }));

      const orchestrator = new RunOrchestrator(cfg);
      const results = await orchestrator.execute([123]);

      expect(results).toHaveLength(1);
      expect(results[0].issueNumber).toBe(123);
      expect(results[0].success).toBe(true);
      expect(results[0]).toHaveProperty("phaseResults");
    });

    it("should handle multiple issues in parallel mode", async () => {
      const cfg = makeOrchestratorConfig({
        issueInfoMap: new Map([
          [100, { title: "Issue 100", labels: [] }],
          [101, { title: "Issue 101", labels: [] }],
        ]),
      });
      mockRunIssue
        .mockResolvedValueOnce(makeIssueResult({ issueNumber: 100 }))
        .mockResolvedValueOnce(makeIssueResult({ issueNumber: 101 }));

      const orchestrator = new RunOrchestrator(cfg);
      const results = await orchestrator.execute([100, 101]);

      expect(results).toHaveLength(2);
      expect(mockRunIssue).toHaveBeenCalledTimes(2);
    });

    it("should preserve issue order from input array in results", async () => {
      const issueNumbers = [105, 103, 104];
      const cfg = makeOrchestratorConfig({
        issueInfoMap: new Map(
          issueNumbers.map((n) => [n, { title: `Issue ${n}`, labels: [] }]),
        ),
      });
      for (const n of issueNumbers) {
        mockRunIssue.mockResolvedValueOnce(makeIssueResult({ issueNumber: n }));
      }

      const orchestrator = new RunOrchestrator(cfg);
      const results = await orchestrator.execute(issueNumbers);

      expect(results.map((r) => r.issueNumber)).toEqual([105, 103, 104]);
    });
  });

  // ===== AC-1: Sequential Mode =====
  describe("AC-1: Sequential mode execution", () => {
    it("should execute issues sequentially when config.sequential=true", async () => {
      const cfg = makeOrchestratorConfig({
        config: makeConfig({ sequential: true }),
        issueInfoMap: new Map([
          [100, { title: "Issue 100", labels: [] }],
          [101, { title: "Issue 101", labels: [] }],
        ]),
      });
      mockRunIssue
        .mockResolvedValueOnce(makeIssueResult({ issueNumber: 100 }))
        .mockResolvedValueOnce(makeIssueResult({ issueNumber: 101 }));

      const orchestrator = new RunOrchestrator(cfg);
      const results = await orchestrator.execute([100, 101]);

      expect(results).toHaveLength(2);
      expect(mockRunIssue).toHaveBeenCalledTimes(2);
    });

    it("should stop on first failure in sequential mode", async () => {
      const cfg = makeOrchestratorConfig({
        config: makeConfig({ sequential: true }),
        issueInfoMap: new Map([
          [100, { title: "Issue 100", labels: [] }],
          [101, { title: "Issue 101", labels: [] }],
          [102, { title: "Issue 102", labels: [] }],
        ]),
      });
      mockRunIssue
        .mockResolvedValueOnce(
          makeIssueResult({ issueNumber: 100, success: true }),
        )
        .mockResolvedValueOnce(
          makeIssueResult({ issueNumber: 101, success: false }),
        )
        .mockResolvedValueOnce(
          makeIssueResult({ issueNumber: 102, success: true }),
        );

      const orchestrator = new RunOrchestrator(cfg);
      const results = await orchestrator.execute([100, 101, 102]);

      // Stops after 101 fails
      expect(results).toHaveLength(2);
      expect(mockRunIssue).toHaveBeenCalledTimes(2);
    });
  });

  // ===== AC-1: Chain Mode =====
  describe("AC-1: Chain mode execution", () => {
    it("should enable sequential mode when chain=true", async () => {
      const cfg = makeOrchestratorConfig({
        options: { chain: true } as RunOptions,
        issueInfoMap: new Map([
          [100, { title: "Issue 100", labels: [] }],
          [101, { title: "Issue 101", labels: [] }],
        ]),
      });
      mockRunIssue
        .mockResolvedValueOnce(makeIssueResult({ issueNumber: 100 }))
        .mockResolvedValueOnce(makeIssueResult({ issueNumber: 101 }));

      const orchestrator = new RunOrchestrator(cfg);
      const results = await orchestrator.execute([100, 101]);

      // Chain forces sequential — executed in order
      expect(results).toHaveLength(2);
      expect(results[0].issueNumber).toBe(100);
      expect(results[1].issueNumber).toBe(101);
    });

    it("should stop chain if QA fails with qaGate enabled", async () => {
      const cfg = makeOrchestratorConfig({
        options: { chain: true, qaGate: true } as RunOptions,
        issueInfoMap: new Map([
          [100, { title: "Issue 100", labels: [] }],
          [101, { title: "Issue 101", labels: [] }],
          [102, { title: "Issue 102", labels: [] }],
        ]),
      });
      mockRunIssue
        .mockResolvedValueOnce(
          makeIssueResult({ issueNumber: 100, success: true }),
        )
        .mockResolvedValueOnce(
          makeIssueResult({
            issueNumber: 101,
            success: false,
            phaseResults: [{ phase: "qa", success: false }],
          }),
        );

      const orchestrator = new RunOrchestrator(cfg);
      const results = await orchestrator.execute([100, 101, 102]);

      // Stops at 101 due to QA gate
      expect(results).toHaveLength(2);
      expect(mockRunIssue).toHaveBeenCalledTimes(2);
    });
  });

  // ===== AC-3: No Commander.js Types =====
  describe("AC-3: No Commander.js types in orchestrator", () => {
    it("should not import from commander package", () => {
      const source = fs.readFileSync(
        "src/lib/workflow/run-orchestrator.ts",
        "utf-8",
      );
      expect(source).not.toMatch(/from ['"]commander['"]/);
    });

    it("should not reference bin/cli.ts", () => {
      const source = fs.readFileSync(
        "src/lib/workflow/run-orchestrator.ts",
        "utf-8",
      );
      expect(source).not.toMatch(/bin\/cli/);
    });

    it("should not import Commander types", () => {
      const source = fs.readFileSync(
        "src/lib/workflow/run-orchestrator.ts",
        "utf-8",
      );
      expect(source).not.toMatch(/import.*Command.*from/);
    });
  });

  // ===== AC-8: Config validation =====
  describe("AC-8: OrchestratorConfig validation rejects missing fields", () => {
    it("should reject config with missing ExecutionConfig", () => {
      expect(
        () =>
          new RunOrchestrator({
            config: undefined as any,
            options: {} as RunOptions,
            issueInfoMap: new Map(),
            worktreeMap: new Map(),
            services: {},
          }),
      ).toThrow("OrchestratorConfig.config is required");
    });

    it("should reject config with empty phases array", () => {
      expect(
        () =>
          new RunOrchestrator(
            makeOrchestratorConfig({
              config: makeConfig({ phases: [] as any }),
            }),
          ),
      ).toThrow("OrchestratorConfig.config.phases must be a non-empty array");
    });

    it("should accept valid config without throwing", () => {
      expect(() => new RunOrchestrator(makeOrchestratorConfig())).not.toThrow();
    });
  });

  // ===== AC-9: No process.exit =====
  describe("AC-9: RunOrchestrator never calls process.exit", () => {
    it("should not contain process.exit in source code", () => {
      const source = fs.readFileSync(
        "src/lib/workflow/run-orchestrator.ts",
        "utf-8",
      );
      expect(source).not.toMatch(/process\.exit/);
    });

    it("should return results on success without exiting", async () => {
      const cfg = makeOrchestratorConfig();
      mockRunIssue.mockResolvedValueOnce(makeIssueResult());

      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
      const orchestrator = new RunOrchestrator(cfg);
      const results = await orchestrator.execute([123]);

      expect(results).toHaveLength(1);
      expect(exitSpy).not.toHaveBeenCalled();
      exitSpy.mockRestore();
    });

    it("should not exit on failure — returns failed result instead", async () => {
      const cfg = makeOrchestratorConfig();
      mockRunIssue.mockResolvedValueOnce(makeIssueResult({ success: false }));

      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
      const orchestrator = new RunOrchestrator(cfg);
      const results = await orchestrator.execute([123]);

      expect(results[0].success).toBe(false);
      expect(exitSpy).not.toHaveBeenCalled();
      exitSpy.mockRestore();
    });
  });

  // ===== Empty issue list =====
  describe("Empty issue list", () => {
    it("should return empty array for empty input", async () => {
      const cfg = makeOrchestratorConfig();
      const orchestrator = new RunOrchestrator(cfg);
      const results = await orchestrator.execute([]);

      expect(results).toEqual([]);
    });
  });

  // ===== Shutdown handling =====
  describe("Shutdown mid-execution", () => {
    it("should respect shuttingDown flag in sequential mode", async () => {
      const { ShutdownManager } = await import("../src/lib/shutdown.js");
      const shutdown = new ShutdownManager();
      const cfg = makeOrchestratorConfig({
        config: makeConfig({ sequential: true }),
        services: {
          logWriter: null,
          stateManager: null,
          shutdownManager: shutdown,
        },
        issueInfoMap: new Map([
          [100, { title: "Issue 100", labels: [] }],
          [101, { title: "Issue 101", labels: [] }],
        ]),
      });

      // Set shutting down before execution
      (shutdown as any)._shuttingDown = true;

      const orchestrator = new RunOrchestrator(cfg);
      const results = await orchestrator.execute([100, 101]);

      // Should not execute any issues
      expect(results).toHaveLength(0);
      expect(mockRunIssue).not.toHaveBeenCalled();
    });
  });
});
