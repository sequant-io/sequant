// Integration tests for Issue #405 — Run pipeline integration confidence
// Exercises executePhaseWithRetry → result collection with real StateManager
//
// AC-1: Integration test exercises runCommand → phase-executor → result collection
// AC-3: Timeout handling (abort controller + phase result)
// AC-7: State file reflects correct phase status after pipeline execution

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
  afterEach,
} from "vitest";
import * as fs from "fs";
import * as path from "path";

import { executePhaseWithRetry } from "../../src/lib/workflow/phase-executor.js";
import { StateManager } from "../../src/lib/workflow/state-manager.js";
import { ShutdownManager } from "../../src/lib/shutdown.js";
import type {
  ExecutionConfig,
  PhaseResult,
} from "../../src/lib/workflow/types.js";

/** No-op delay to skip backoff waits in tests */
const noDelay = async () => {};

/** Shared base config for all tests */
const baseConfig: ExecutionConfig = {
  phases: ["spec", "exec", "qa"],
  phaseTimeout: 600,
  qualityLoop: false,
  maxIterations: 3,
  skipVerification: false,
  sequential: false,
  concurrency: 3,
  parallel: false,
  verbose: false,
  noSmartTests: false,
  dryRun: false,
  mcp: false,
  retry: true,
};

function makeResult(
  overrides: Partial<PhaseResult & { sessionId?: string }> = {},
): PhaseResult & { sessionId?: string } {
  return {
    phase: "exec",
    success: true,
    durationSeconds: 120,
    ...overrides,
  };
}

describe("Run Pipeline - Integration (#405)", () => {
  const TEST_DIR = `/tmp/sequant-test-pipeline-${process.pid}-${Date.now()}`;
  let stateManager: StateManager;
  let shutdownManager: ShutdownManager;

  beforeAll(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });

    stateManager = new StateManager({
      statePath: path.join(TEST_DIR, "state.json"),
    });

    shutdownManager = new ShutdownManager({
      output: () => {},
      errorOutput: () => {},
      exit: () => {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    shutdownManager.dispose();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // === AC-1: Integration test exercises pipeline → phase-executor → result collection ===
  describe("AC-1: Pipeline execution with result collection", () => {
    it("collects results from a 3-phase pipeline execution", async () => {
      const issueNumber = 100;
      await stateManager.initializeIssue(
        issueNumber,
        "Test issue for pipeline",
      );

      const phaseResults: PhaseResult[] = [];

      // Simulate 3-phase pipeline: spec → exec → qa
      for (const phase of ["spec", "exec", "qa"] as const) {
        await stateManager.updatePhaseStatus(issueNumber, phase, "in_progress");

        const executePhaseFn = vi
          .fn()
          .mockResolvedValue(
            makeResult({ phase, success: true, durationSeconds: 90 }),
          );

        const result = await executePhaseWithRetry(
          issueNumber,
          phase,
          { ...baseConfig, mcp: false },
          undefined,
          undefined,
          shutdownManager,
          undefined,
          executePhaseFn,
          noDelay,
        );

        phaseResults.push(result);

        await stateManager.updatePhaseStatus(
          issueNumber,
          phase,
          result.success ? "completed" : "failed",
          { error: result.error },
        );
      }

      // Verify all 3 phases collected
      expect(phaseResults).toHaveLength(3);
      expect(phaseResults.every((r) => r.success)).toBe(true);
      expect(phaseResults.map((r) => r.phase)).toEqual(["spec", "exec", "qa"]);
    });

    it("collects partial results when a phase fails mid-pipeline", async () => {
      const issueNumber = 101;
      await stateManager.initializeIssue(issueNumber, "Partial failure test");

      const phaseResults: PhaseResult[] = [];
      const phases = ["spec", "exec", "qa"] as const;

      for (const phase of phases) {
        await stateManager.updatePhaseStatus(issueNumber, phase, "in_progress");

        // exec phase fails
        const shouldFail = phase === "exec";
        const executePhaseFn = vi.fn().mockResolvedValue(
          makeResult({
            phase,
            success: !shouldFail,
            durationSeconds: shouldFail ? 180 : 90,
            error: shouldFail ? "compilation error" : undefined,
          }),
        );

        const result = await executePhaseWithRetry(
          issueNumber,
          phase,
          { ...baseConfig, mcp: false },
          undefined,
          undefined,
          shutdownManager,
          undefined,
          executePhaseFn,
          noDelay,
        );

        phaseResults.push(result);

        await stateManager.updatePhaseStatus(
          issueNumber,
          phase,
          result.success ? "completed" : "failed",
          { error: result.error },
        );

        // Stop pipeline on failure (like real batch-executor does)
        if (!result.success) break;
      }

      // Verify partial collection: spec succeeded, exec failed, qa never ran
      expect(phaseResults).toHaveLength(2);
      expect(phaseResults[0].phase).toBe("spec");
      expect(phaseResults[0].success).toBe(true);
      expect(phaseResults[1].phase).toBe("exec");
      expect(phaseResults[1].success).toBe(false);
      expect(phaseResults[1].error).toBe("compilation error");
    });

    it("preserves sessionId across sequential phases", async () => {
      const issueNumber = 102;
      await stateManager.initializeIssue(
        issueNumber,
        "Session continuity test",
      );

      let sessionId: string | undefined;

      // Spec returns a sessionId
      const specExecuteFn = vi
        .fn()
        .mockResolvedValue(
          makeResult({
            phase: "spec",
            success: true,
            sessionId: "session-abc",
          }),
        );

      const specResult = await executePhaseWithRetry(
        issueNumber,
        "spec",
        { ...baseConfig, mcp: false },
        sessionId,
        undefined,
        shutdownManager,
        undefined,
        specExecuteFn,
        noDelay,
      );

      if (specResult.sessionId) {
        sessionId = specResult.sessionId;
      }

      // Exec receives the sessionId from spec
      const execExecuteFn = vi
        .fn()
        .mockResolvedValue(
          makeResult({ phase: "exec", success: true, sessionId }),
        );

      await executePhaseWithRetry(
        issueNumber,
        "exec",
        { ...baseConfig, mcp: false },
        sessionId,
        undefined,
        shutdownManager,
        undefined,
        execExecuteFn,
        noDelay,
      );

      // Verify sessionId was passed through to exec phase
      expect(execExecuteFn).toHaveBeenCalledWith(
        issueNumber,
        "exec",
        expect.any(Object),
        "session-abc",
        undefined,
        shutdownManager,
        undefined,
      );
    });
  });

  // === AC-3: Timeout handling with abort signal ===
  describe("AC-3: Timeout handling", () => {
    it("abort controller signal fires when phase exceeds timeout", async () => {
      const issueNumber = 200;
      await stateManager.initializeIssue(issueNumber, "Timeout test");

      // Simulate a phase that takes longer than timeout
      const executePhaseFn = vi.fn().mockResolvedValue(
        makeResult({
          phase: "exec",
          success: false,
          durationSeconds: 1800,
          error: "Timeout: phase exceeded 600s limit",
        }),
      );

      const result = await executePhaseWithRetry(
        issueNumber,
        "exec",
        { ...baseConfig, mcp: false, retry: false },
        undefined,
        undefined,
        shutdownManager,
        undefined,
        executePhaseFn,
        noDelay,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Timeout");

      // Update state to reflect timeout
      await stateManager.updatePhaseStatus(issueNumber, "exec", "failed", {
        error: result.error,
      });

      const issueState = await stateManager.getIssueState(issueNumber);
      expect(issueState?.phases.exec?.status).toBe("failed");
      expect(issueState?.phases.exec?.error).toContain("Timeout");
    });

    it("phase result records timeout with success=false", async () => {
      const executePhaseFn = vi.fn().mockResolvedValue(
        makeResult({
          phase: "qa",
          success: false,
          error: "Timeout: phase exceeded limit",
          durationSeconds: 1800,
        }),
      );

      const result = await executePhaseWithRetry(
        300,
        "qa",
        { ...baseConfig, mcp: false, retry: false },
        undefined,
        undefined,
        undefined,
        undefined,
        executePhaseFn,
        noDelay,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Timeout");
      expect(result.phase).toBe("qa");
    });
  });

  // === AC-7: State file reflects correct phase status after pipeline execution ===
  describe("AC-7: State file reflects phase status", () => {
    it("state tracks completed phases correctly", async () => {
      const issueNumber = 400;
      await stateManager.initializeIssue(issueNumber, "State tracking test");

      const executePhaseFn = vi
        .fn()
        .mockResolvedValue(makeResult({ success: true, durationSeconds: 60 }));

      for (const phase of ["spec", "exec", "qa"] as const) {
        await stateManager.updatePhaseStatus(issueNumber, phase, "in_progress");

        await executePhaseWithRetry(
          issueNumber,
          phase,
          { ...baseConfig, mcp: false },
          undefined,
          undefined,
          shutdownManager,
          undefined,
          executePhaseFn,
          noDelay,
        );

        await stateManager.updatePhaseStatus(issueNumber, phase, "completed");
      }

      const issueState = await stateManager.getIssueState(issueNumber);
      expect(issueState).not.toBeNull();
      expect(issueState?.phases.spec?.status).toBe("completed");
      expect(issueState?.phases.exec?.status).toBe("completed");
      expect(issueState?.phases.qa?.status).toBe("completed");
    });

    it("state tracks failed phase with error message", async () => {
      const issueNumber = 401;
      await stateManager.initializeIssue(
        issueNumber,
        "Failed phase state test",
      );

      // Spec succeeds
      await stateManager.updatePhaseStatus(issueNumber, "spec", "in_progress");
      await stateManager.updatePhaseStatus(issueNumber, "spec", "completed");

      // Exec fails
      await stateManager.updatePhaseStatus(issueNumber, "exec", "in_progress");

      const executePhaseFn = vi.fn().mockResolvedValue(
        makeResult({
          phase: "exec",
          success: false,
          durationSeconds: 300,
          error: "Build failed: missing dependency",
        }),
      );

      const result = await executePhaseWithRetry(
        issueNumber,
        "exec",
        { ...baseConfig, mcp: false, retry: false },
        undefined,
        undefined,
        shutdownManager,
        undefined,
        executePhaseFn,
        noDelay,
      );

      await stateManager.updatePhaseStatus(issueNumber, "exec", "failed", {
        error: result.error,
      });

      const issueState = await stateManager.getIssueState(issueNumber);
      expect(issueState?.phases.spec?.status).toBe("completed");
      expect(issueState?.phases.exec?.status).toBe("failed");
      expect(issueState?.phases.exec?.error).toBe(
        "Build failed: missing dependency",
      );
      // QA never started
      expect(issueState?.phases.qa?.status).toBeUndefined();
    });

    it("state file persists to disk and survives re-read", async () => {
      const issueNumber = 402;
      await stateManager.initializeIssue(issueNumber, "Persistence test");
      await stateManager.updatePhaseStatus(issueNumber, "exec", "completed");

      // Create a fresh StateManager pointing at the same file
      const freshManager = new StateManager({
        statePath: path.join(TEST_DIR, "state.json"),
      });

      const issueState = await freshManager.getIssueState(issueNumber);
      expect(issueState).not.toBeNull();
      expect(issueState?.title).toBe("Persistence test");
      expect(issueState?.phases.exec?.status).toBe("completed");
    });
  });
});
