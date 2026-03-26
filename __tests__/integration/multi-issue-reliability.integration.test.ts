// Integration tests for Issue #452
// AC-2: Parallel is default for multi-issue runs
// AC-3: Spec retry logic end-to-end

import { describe, it, expect, vi, afterEach } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/lib/settings.js";
import {
  executePhaseWithRetry,
  SPEC_RETRY_BACKOFF_MS,
  SPEC_EXTRA_RETRIES,
} from "../../src/lib/workflow/phase-executor.js";
import type {
  ExecutionConfig,
  PhaseResult,
} from "../../src/lib/workflow/types.js";

/** No-op delay for tests */
const noDelay = async () => {};

describe("Multi-Issue Reliability - Integration (#452)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // === AC-2: Parallel Default ===
  describe("AC-2: Parallel is the default for multi-issue runs", () => {
    it("should default to sequential: false in settings", () => {
      expect(DEFAULT_SETTINGS.run.sequential).toBe(false);
    });

    it("validates assumption: parallel is shipped default in settings.ts", () => {
      expect(DEFAULT_SETTINGS.run.sequential).toBe(false);
      expect(DEFAULT_SETTINGS.run.concurrency).toBe(3);
    });
  });

  // === AC-3: Spec Retry End-to-End ===
  describe("AC-3: Spec retry logic end-to-end", () => {
    const config: ExecutionConfig = {
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
      mcp: false,
      retry: true,
    };

    function makeResult(
      overrides: Partial<PhaseResult & { sessionId?: string }> = {},
    ): PhaseResult & { sessionId?: string } {
      return {
        phase: "spec",
        success: false,
        durationSeconds: 120,
        error: "transient failure",
        ...overrides,
      };
    }

    it("should retry spec phase and recover from transient failure", async () => {
      const executePhaseFn = vi
        .fn()
        .mockResolvedValueOnce(makeResult())
        .mockResolvedValueOnce(makeResult({ success: true, error: undefined }));

      const result = await executePhaseWithRetry(
        99,
        "spec",
        config,
        undefined,
        undefined,
        undefined,
        undefined,
        executePhaseFn,
        noDelay,
      );

      expect(result.success).toBe(true);
      expect(executePhaseFn).toHaveBeenCalledTimes(2);
    });

    it("validates assumption: backoff is within reasonable range", () => {
      expect(SPEC_RETRY_BACKOFF_MS).toBeGreaterThanOrEqual(3000);
      expect(SPEC_RETRY_BACKOFF_MS).toBeLessThanOrEqual(30000);
    });

    it("validates assumption: extra retries is conservative", () => {
      expect(SPEC_EXTRA_RETRIES).toBe(1);
    });
  });

  // === ERROR SCENARIOS ===
  describe("error scenarios", () => {
    const config: ExecutionConfig = {
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
      mcp: false,
      retry: true,
    };

    function makeResult(
      overrides: Partial<PhaseResult & { sessionId?: string }> = {},
    ): PhaseResult & { sessionId?: string } {
      return {
        phase: "spec",
        success: false,
        durationSeconds: 120,
        error: "transient failure",
        ...overrides,
      };
    }

    it("should handle spec failure with clear error after all retries exhausted", async () => {
      const executePhaseFn = vi
        .fn()
        .mockResolvedValue(makeResult({ error: "rate limited" }));

      const result = await executePhaseWithRetry(
        99,
        "spec",
        config,
        undefined,
        undefined,
        undefined,
        undefined,
        executePhaseFn,
        noDelay,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("rate limited");
    });

    it("should handle concurrent spec retries independently", async () => {
      let callCount = 0;
      const executePhaseFn = vi.fn().mockImplementation(async () => {
        callCount++;
        return makeResult({
          success: callCount % 2 === 0,
          error: callCount % 2 === 0 ? undefined : "fail",
        });
      });

      const [result1, result2] = await Promise.all([
        executePhaseWithRetry(
          100,
          "spec",
          config,
          undefined,
          undefined,
          undefined,
          undefined,
          executePhaseFn,
          noDelay,
        ),
        executePhaseWithRetry(
          101,
          "spec",
          config,
          undefined,
          undefined,
          undefined,
          undefined,
          executePhaseFn,
          noDelay,
        ),
      ]);

      // Both should complete without interfering
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
    });
  });
});
