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
  rebaseOntoLocalBranch: vi.fn(() => ({
    performed: true,
    success: true,
    conflict: false,
  })),
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

import { rebaseOntoLocalBranch } from "../src/lib/workflow/worktree-manager.js";
const mockRebaseOntoLocalBranch = vi.mocked(rebaseOntoLocalBranch);

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

  // ===== #605: Stacked-mode chain context =====
  describe("#605: --stacked passes predecessor branch + manifest", () => {
    it("sets predecessorBranch on middle-of-stack issues only", async () => {
      const cfg = makeOrchestratorConfig({
        options: { chain: true, stacked: true } as RunOptions,
        issueInfoMap: new Map([
          [100, { title: "Issue 100", labels: [] }],
          [101, { title: "Issue 101", labels: [] }],
          [102, { title: "Issue 102", labels: [] }],
        ]),
        worktreeMap: new Map([
          [
            100,
            {
              path: "/wt/100",
              branch: "feature/100-first",
              existed: false,
              rebased: false,
            },
          ],
          [
            101,
            {
              path: "/wt/101",
              branch: "feature/101-second",
              existed: false,
              rebased: false,
            },
          ],
          [
            102,
            {
              path: "/wt/102",
              branch: "feature/102-third",
              existed: false,
              rebased: false,
            },
          ],
        ]),
      });

      mockRunIssue
        .mockResolvedValueOnce(makeIssueResult({ issueNumber: 100 }))
        .mockResolvedValueOnce(makeIssueResult({ issueNumber: 101 }))
        .mockResolvedValueOnce(makeIssueResult({ issueNumber: 102 }));

      const orchestrator = new RunOrchestrator(cfg);
      await orchestrator.execute([100, 101, 102]);

      // First call: issue 100 — no predecessor (first in stack)
      const firstCtx = mockRunIssue.mock.calls[0][0];
      expect(firstCtx.chain?.enabled).toBe(true);
      expect(firstCtx.chain?.predecessorBranch).toBeUndefined();
      expect(firstCtx.chain?.stackManifest).toBe(
        "Part of stack: #100 (this) → #101 → #102",
      );

      // Second call: issue 101 — predecessor is feature/100-first
      const secondCtx = mockRunIssue.mock.calls[1][0];
      expect(secondCtx.chain?.predecessorBranch).toBe("feature/100-first");
      expect(secondCtx.chain?.stackManifest).toBe(
        "Part of stack: #100 → #101 (this) → #102",
      );

      // Third call: issue 102 — last in stack, no predecessor (PR targets main)
      const thirdCtx = mockRunIssue.mock.calls[2][0];
      expect(thirdCtx.chain?.isLast).toBe(true);
      expect(thirdCtx.chain?.predecessorBranch).toBeUndefined();
      expect(thirdCtx.chain?.stackManifest).toBe(
        "Part of stack: #100 → #101 → #102 (this)",
      );
    });

    it("does not set stack fields when stacked=false (plain --chain)", async () => {
      const cfg = makeOrchestratorConfig({
        options: { chain: true } as RunOptions,
        issueInfoMap: new Map([
          [100, { title: "Issue 100", labels: [] }],
          [101, { title: "Issue 101", labels: [] }],
        ]),
        worktreeMap: new Map([
          [
            100,
            {
              path: "/wt/100",
              branch: "feature/100-first",
              existed: false,
              rebased: false,
            },
          ],
          [
            101,
            {
              path: "/wt/101",
              branch: "feature/101-second",
              existed: false,
              rebased: false,
            },
          ],
        ]),
      });

      mockRunIssue
        .mockResolvedValueOnce(makeIssueResult({ issueNumber: 100 }))
        .mockResolvedValueOnce(makeIssueResult({ issueNumber: 101 }));

      const orchestrator = new RunOrchestrator(cfg);
      await orchestrator.execute([100, 101]);

      for (const call of mockRunIssue.mock.calls) {
        const ctx = call[0];
        expect(ctx.chain?.predecessorBranch).toBeUndefined();
        expect(ctx.chain?.stackManifest).toBeUndefined();
      }
    });
  });

  // ===== #748: chain successors rebase onto predecessor's local tip =====
  describe("#748: chain successors are rebased onto the predecessor's local branch", () => {
    it("rebases each successor onto its predecessor's local branch before it runs (plain --chain)", async () => {
      mockRebaseOntoLocalBranch.mockClear();
      const cfg = makeOrchestratorConfig({
        options: { chain: true } as RunOptions,
        issueInfoMap: new Map([
          [100, { title: "Issue 100", labels: [] }],
          [101, { title: "Issue 101", labels: [] }],
          [102, { title: "Issue 102", labels: [] }],
        ]),
        worktreeMap: new Map([
          [
            100,
            {
              path: "/wt/100",
              branch: "feature/100-first",
              existed: false,
              rebased: false,
            },
          ],
          [
            101,
            {
              path: "/wt/101",
              branch: "feature/101-second",
              existed: false,
              rebased: false,
            },
          ],
          [
            102,
            {
              path: "/wt/102",
              branch: "feature/102-third",
              existed: false,
              rebased: false,
            },
          ],
        ]),
      });

      mockRunIssue
        .mockResolvedValueOnce(makeIssueResult({ issueNumber: 100 }))
        .mockResolvedValueOnce(makeIssueResult({ issueNumber: 101 }))
        .mockResolvedValueOnce(makeIssueResult({ issueNumber: 102 }));

      const orchestrator = new RunOrchestrator(cfg);
      await orchestrator.execute([100, 101, 102]);

      // First issue (i=0) is not rebased — it branches from the base.
      // Successors are rebased onto the *local* predecessor branch (not origin).
      expect(mockRebaseOntoLocalBranch).toHaveBeenCalledTimes(2);
      expect(mockRebaseOntoLocalBranch).toHaveBeenNthCalledWith(
        1,
        "/wt/101",
        "feature/100-first",
        false,
      );
      expect(mockRebaseOntoLocalBranch).toHaveBeenNthCalledWith(
        2,
        "/wt/102",
        "feature/101-second",
        false,
      );
    });

    it("does not rebase when chain mode is off", async () => {
      mockRebaseOntoLocalBranch.mockClear();
      const cfg = makeOrchestratorConfig({
        config: makeConfig({ sequential: true }),
        options: {} as RunOptions,
        issueInfoMap: new Map([
          [100, { title: "Issue 100", labels: [] }],
          [101, { title: "Issue 101", labels: [] }],
        ]),
        worktreeMap: new Map([
          [
            100,
            {
              path: "/wt/100",
              branch: "feature/100-first",
              existed: false,
              rebased: false,
            },
          ],
          [
            101,
            {
              path: "/wt/101",
              branch: "feature/101-second",
              existed: false,
              rebased: false,
            },
          ],
        ]),
      });

      mockRunIssue
        .mockResolvedValueOnce(makeIssueResult({ issueNumber: 100 }))
        .mockResolvedValueOnce(makeIssueResult({ issueNumber: 101 }));

      const orchestrator = new RunOrchestrator(cfg);
      await orchestrator.execute([100, 101]);

      expect(mockRebaseOntoLocalBranch).not.toHaveBeenCalled();
    });

    it("stops the chain when a successor's rebase conflicts (does not run it or later issues)", async () => {
      mockRebaseOntoLocalBranch.mockReset();
      // #101's rebase conflicts; the helper's default (success) is irrelevant
      // because the loop breaks before any further rebase is attempted.
      mockRebaseOntoLocalBranch
        .mockReturnValueOnce({
          performed: true,
          success: false,
          conflict: true,
        })
        .mockReturnValue({ performed: true, success: true, conflict: false });

      const cfg = makeOrchestratorConfig({
        options: { chain: true } as RunOptions,
        issueInfoMap: new Map([
          [100, { title: "Issue 100", labels: [] }],
          [101, { title: "Issue 101", labels: [] }],
          [102, { title: "Issue 102", labels: [] }],
        ]),
        worktreeMap: new Map([
          [
            100,
            {
              path: "/wt/100",
              branch: "feature/100-first",
              existed: false,
              rebased: false,
            },
          ],
          [
            101,
            {
              path: "/wt/101",
              branch: "feature/101-second",
              existed: false,
              rebased: false,
            },
          ],
          [
            102,
            {
              path: "/wt/102",
              branch: "feature/102-third",
              existed: false,
              rebased: false,
            },
          ],
        ]),
      });

      mockRunIssue.mockResolvedValue(makeIssueResult({ issueNumber: 100 }));

      const orchestrator = new RunOrchestrator(cfg);
      const results = await orchestrator.execute([100, 101, 102]);

      // Only #100 executed; #101's failed rebase broke the chain before it ran.
      expect(mockRunIssue).toHaveBeenCalledTimes(1);
      // Exactly one rebase attempt (for #101); the loop broke before #102.
      expect(mockRebaseOntoLocalBranch).toHaveBeenCalledTimes(1);
      // Results: #100 success + a recorded failure for the broken #101 link.
      expect(results).toHaveLength(2);
      expect(results[0].issueNumber).toBe(100);
      expect(results[0].success).toBe(true);
      expect(results[1].issueNumber).toBe(101);
      expect(results[1].success).toBe(false);
      expect(results[1].abortReason).toContain("conflict");
      // #102 was never reached.
      expect(results.some((r) => r.issueNumber === 102)).toBe(false);
    });

    it("warns and continues without rebasing when the predecessor branch is missing from the worktree map", async () => {
      mockRebaseOntoLocalBranch.mockReset();
      mockRebaseOntoLocalBranch.mockReturnValue({
        performed: true,
        success: true,
        conflict: false,
      });
      const warnSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const cfg = makeOrchestratorConfig({
        options: { chain: true } as RunOptions,
        issueInfoMap: new Map([
          [100, { title: "Issue 100", labels: [] }],
          [101, { title: "Issue 101", labels: [] }],
        ]),
        // #100 (the predecessor) is intentionally absent from the worktree map.
        worktreeMap: new Map([
          [
            101,
            {
              path: "/wt/101",
              branch: "feature/101-second",
              existed: false,
              rebased: false,
            },
          ],
        ]),
      });

      mockRunIssue.mockResolvedValue(makeIssueResult());

      const orchestrator = new RunOrchestrator(cfg);
      const results = await orchestrator.execute([100, 101]);

      // No rebase attempted (predecessor branch unavailable), but the gap is
      // surfaced rather than silently skipped, and both issues still run.
      expect(mockRebaseOntoLocalBranch).not.toHaveBeenCalled();
      expect(results).toHaveLength(2);
      const warned = warnSpy.mock.calls
        .flat()
        .some(
          (arg) =>
            typeof arg === "string" && arg.includes("Chain link unverified"),
        );
      expect(warned).toBe(true);
      warnSpy.mockRestore();
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
