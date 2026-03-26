// Unit tests for Issue #452 — Spec phase retry logic
// AC-3: Add retry logic (1 retry with backoff) for spec phase failures
// AC-6: Named constants for retry delay/count
// AC-7: Unit tests for spec retry
// AC-8: Log retry attempts with backoff duration

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  executePhaseWithRetry,
  SPEC_RETRY_BACKOFF_MS,
  SPEC_EXTRA_RETRIES,
} from "./phase-executor.js";
import type { ExecutionConfig, PhaseResult } from "./types.js";

/** No-op delay for tests — avoids real timers entirely */
const noDelay = async () => {};

describe("Spec Phase Retry Logic (#452)", () => {
  const baseConfig: ExecutionConfig = {
    phases: ["spec"],
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
    mcp: false, // Disable MCP to isolate spec retry behavior
    retry: true,
  };

  function makeResult(
    overrides: Partial<PhaseResult & { sessionId?: string }> = {},
  ): PhaseResult & { sessionId?: string } {
    return {
      phase: "spec",
      success: false,
      durationSeconds: 120, // genuine failure (above cold-start threshold)
      error: "process exited with code 1",
      ...overrides,
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // === AC-6: Named Constants ===
  describe("AC-6: Named constants for retry configuration", () => {
    it("should export SPEC_RETRY_BACKOFF_MS as 5000", () => {
      expect(SPEC_RETRY_BACKOFF_MS).toBe(5000);
    });

    it("should export SPEC_EXTRA_RETRIES as 1", () => {
      expect(SPEC_EXTRA_RETRIES).toBe(1);
    });
  });

  // === AC-3: Spec retry on genuine failure ===
  describe("AC-3: Spec retry on genuine failure", () => {
    it("should retry spec phase once after genuine failure and succeed", async () => {
      const executePhaseFn = vi
        .fn()
        .mockResolvedValueOnce(makeResult()) // first call: genuine failure
        .mockResolvedValueOnce(makeResult({ success: true, error: undefined })); // spec retry: success

      const result = await executePhaseWithRetry(
        42,
        "spec",
        baseConfig,
        undefined,
        undefined,
        undefined,
        undefined,
        executePhaseFn,
        noDelay,
      );

      expect(result.success).toBe(true);
      // 1 initial + 1 spec retry = 2 calls
      expect(executePhaseFn).toHaveBeenCalledTimes(2);
    });

    it("should return failure when both spec attempts fail", async () => {
      const executePhaseFn = vi
        .fn()
        .mockResolvedValue(
          makeResult({ error: "GitHub API rate limit exceeded" }),
        );

      const result = await executePhaseWithRetry(
        42,
        "spec",
        baseConfig,
        undefined,
        undefined,
        undefined,
        undefined,
        executePhaseFn,
        noDelay,
      );

      expect(result.success).toBe(false);
      // Original error preserved
      expect(result.error).toBe("GitHub API rate limit exceeded");
      // 1 initial + 1 spec retry = 2
      expect(executePhaseFn).toHaveBeenCalledTimes(2);
    });

    it("should recover via spec retry after cold-start retries are exhausted", async () => {
      // durationSeconds: 30 is below COLD_START_THRESHOLD_SECONDS (60),
      // so all 3 cold-start attempts run and fail, then Phase 3 (spec retry) succeeds
      const executePhaseFn = vi
        .fn()
        .mockResolvedValueOnce(makeResult({ durationSeconds: 30 })) // cold-start attempt 1
        .mockResolvedValueOnce(makeResult({ durationSeconds: 30 })) // cold-start attempt 2
        .mockResolvedValueOnce(makeResult({ durationSeconds: 30 })) // cold-start attempt 3
        .mockResolvedValueOnce(makeResult({ success: true, error: undefined })); // spec retry

      const result = await executePhaseWithRetry(
        42,
        "spec",
        baseConfig,
        undefined,
        undefined,
        undefined,
        undefined,
        executePhaseFn,
        noDelay,
      );

      expect(result.success).toBe(true);
      // 3 cold-start + 1 spec retry = 4 calls (mcp: false skips Phase 2)
      expect(executePhaseFn).toHaveBeenCalledTimes(4);
    });

    it("should NOT apply spec retry to non-spec phases", async () => {
      const executePhaseFn = vi
        .fn()
        .mockResolvedValue(makeResult({ phase: "exec" }));

      const result = await executePhaseWithRetry(
        42,
        "exec",
        baseConfig,
        undefined,
        undefined,
        undefined,
        undefined,
        executePhaseFn,
        noDelay,
      );

      expect(result.success).toBe(false);
      // Only 1 call — no spec retry for exec phase
      expect(executePhaseFn).toHaveBeenCalledTimes(1);
    });

    it("should not apply spec retry when config.retry is false", async () => {
      const executePhaseFn = vi.fn().mockResolvedValue(makeResult());

      const result = await executePhaseWithRetry(
        42,
        "spec",
        { ...baseConfig, retry: false },
        undefined,
        undefined,
        undefined,
        undefined,
        executePhaseFn,
        noDelay,
      );

      expect(result.success).toBe(false);
      // Only 1 call — retry disabled entirely
      expect(executePhaseFn).toHaveBeenCalledTimes(1);
    });
  });

  // === AC-8: Logging ===
  describe("AC-8: Log retry attempts with backoff duration", () => {
    it("should log when spec retry is triggered", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const executePhaseFn = vi
        .fn()
        .mockResolvedValueOnce(makeResult())
        .mockResolvedValueOnce(makeResult({ success: true, error: undefined }));

      await executePhaseWithRetry(
        42,
        "spec",
        baseConfig,
        undefined,
        undefined,
        undefined,
        undefined,
        executePhaseFn,
        noDelay,
      );

      const logCalls = consoleSpy.mock.calls.map((args) => String(args[0]));
      const retryLog = logCalls.find(
        (msg) =>
          msg.includes("Spec phase failed") &&
          msg.includes(`${SPEC_RETRY_BACKOFF_MS}ms backoff`),
      );
      expect(retryLog).toBeDefined();

      const successLog = logCalls.find((msg) =>
        msg.includes("Spec phase succeeded on retry"),
      );
      expect(successLog).toBeDefined();
    });

    it("should not log retry when spec succeeds on first attempt", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const executePhaseFn = vi
        .fn()
        .mockResolvedValue(makeResult({ success: true, error: undefined }));

      await executePhaseWithRetry(
        42,
        "spec",
        baseConfig,
        undefined,
        undefined,
        undefined,
        undefined,
        executePhaseFn,
        noDelay,
      );

      const logCalls = consoleSpy.mock.calls.map((args) => String(args[0]));
      const retryLog = logCalls.find((msg) =>
        msg.includes("Spec phase failed"),
      );
      expect(retryLog).toBeUndefined();
    });
  });

  // === FAILURE PATHS ===
  describe("error handling", () => {
    it("should preserve original error message through spec retry", async () => {
      const executePhaseFn = vi
        .fn()
        .mockResolvedValueOnce(
          makeResult({ error: "GitHub API rate limit exceeded" }),
        )
        .mockResolvedValueOnce(makeResult({ error: "context overflow" }));

      const result = await executePhaseWithRetry(
        42,
        "spec",
        baseConfig,
        undefined,
        undefined,
        undefined,
        undefined,
        executePhaseFn,
        noDelay,
      );

      expect(result.success).toBe(false);
      // Original error is preserved, not the retry error
      expect(result.error).toBe("GitHub API rate limit exceeded");
    });

    it("should call delayFn with SPEC_RETRY_BACKOFF_MS before spec retry", async () => {
      const mockDelay = vi.fn().mockResolvedValue(undefined);
      const executePhaseFn = vi.fn().mockResolvedValue(makeResult());

      await executePhaseWithRetry(
        42,
        "spec",
        baseConfig,
        undefined,
        undefined,
        undefined,
        undefined,
        executePhaseFn,
        mockDelay,
      );

      expect(mockDelay).toHaveBeenCalledTimes(1);
      expect(mockDelay).toHaveBeenCalledWith(SPEC_RETRY_BACKOFF_MS);
    });
  });
});
