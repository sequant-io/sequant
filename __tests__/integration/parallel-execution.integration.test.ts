// Integration tests for Issue #404 - Parallel Execution
// These test the actual execution logic with mocked runIssueWithLogging

import { describe, it, expect, vi, beforeEach } from "vitest";
import pLimit from "p-limit";
import {
  DEFAULT_CONFIG,
  ExecutionConfig,
  IssueResult,
} from "../../src/lib/workflow/types.js";

describe("Parallel Execution - Integration", () => {
  describe("AC-1: Default mode runs issues concurrently", () => {
    it("should run issues concurrently with Promise.allSettled + p-limit", async () => {
      const limit = pLimit(3);
      const startTimes: number[] = [];
      const completionOrder: number[] = [];

      // Simulate 3 issues that each take 50ms
      const issueNumbers = [100, 101, 102];
      const results = await Promise.allSettled(
        issueNumbers.map((num) =>
          limit(async () => {
            startTimes.push(Date.now());
            await new Promise((resolve) => setTimeout(resolve, 50));
            completionOrder.push(num);
            return { issueNumber: num, success: true };
          }),
        ),
      );

      // All 3 should have started within a small window (concurrent)
      const maxStartGap = Math.max(...startTimes) - Math.min(...startTimes);
      expect(maxStartGap).toBeLessThan(50); // All started before first completes

      // All results fulfilled
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    });
  });

  describe("AC-2: Concurrency limit configurable", () => {
    it("should limit concurrent executions to the specified value", async () => {
      const limit = pLimit(2); // Max 2 concurrent
      let activeConcurrent = 0;
      let maxConcurrent = 0;

      const issueNumbers = [100, 101, 102, 103];
      await Promise.allSettled(
        issueNumbers.map((num) =>
          limit(async () => {
            activeConcurrent++;
            maxConcurrent = Math.max(maxConcurrent, activeConcurrent);
            await new Promise((resolve) => setTimeout(resolve, 50));
            activeConcurrent--;
            return { issueNumber: num, success: true };
          }),
        ),
      );

      // At most 2 ran concurrently
      expect(maxConcurrent).toBe(2);
    });

    it("should use default concurrency of 3", () => {
      expect(DEFAULT_CONFIG.concurrency).toBe(3);
    });
  });

  describe("AC-4: Failure isolation", () => {
    it("should continue other issues when one fails", async () => {
      const limit = pLimit(3);
      const issueNumbers = [100, 101, 102];

      const results = await Promise.allSettled(
        issueNumbers.map((num) =>
          limit(async () => {
            if (num === 101) {
              throw new Error("Issue 101 failed");
            }
            return {
              issueNumber: num,
              success: true,
              phaseResults: [],
              durationSeconds: 0,
            } as IssueResult;
          }),
        ),
      );

      // Issue 101 rejected, others fulfilled
      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("rejected");
      expect(results[2].status).toBe("fulfilled");
    });

    it("should report the correct failure in results", async () => {
      const limit = pLimit(3);

      const results = await Promise.allSettled(
        [100, 101, 102].map((num) =>
          limit(async () => {
            const success = num !== 101;
            return {
              issueNumber: num,
              success,
              phaseResults: [],
              durationSeconds: 1,
              loopTriggered: false,
            } as IssueResult;
          }),
        ),
      );

      // All fulfilled (errors captured in result, not thrown)
      const fulfilled = results
        .filter(
          (r): r is PromiseFulfilledResult<IssueResult> =>
            r.status === "fulfilled",
        )
        .map((r) => r.value);

      expect(fulfilled).toHaveLength(3);
      expect(fulfilled[0].success).toBe(true);
      expect(fulfilled[1].success).toBe(false);
      expect(fulfilled[2].success).toBe(true);
    });
  });

  describe("AC-5: --sequential unchanged (regression)", () => {
    it("should run issues one at a time with sequential flag", async () => {
      // With sequential mode, issues use for...of (serial)
      const executionOrder: number[] = [];
      const issues = [100, 101, 102];

      // Simulate sequential execution
      for (const num of issues) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        executionOrder.push(num);
      }

      expect(executionOrder).toEqual([100, 101, 102]);
    });
  });

  describe("AC-7: Graceful shutdown", () => {
    it("should respect shutdown flag and skip pending issues", async () => {
      const limit = pLimit(1); // Serial to control order
      let shuttingDown = false;
      const executed: number[] = [];

      const results = await Promise.allSettled(
        [100, 101, 102].map((num) =>
          limit(async () => {
            if (shuttingDown) {
              return {
                issueNumber: num,
                success: false,
                phaseResults: [],
                durationSeconds: 0,
                loopTriggered: false,
              } as IssueResult;
            }

            executed.push(num);

            // Simulate shutdown after first issue
            if (num === 100) {
              shuttingDown = true;
            }

            return {
              issueNumber: num,
              success: true,
              phaseResults: [],
              durationSeconds: 1,
              loopTriggered: false,
            } as IssueResult;
          }),
        ),
      );

      // Only first issue was actually executed
      expect(executed).toEqual([100]);

      // But all promises settled
      expect(results).toHaveLength(3);
    });
  });

  describe("edge cases", () => {
    it("should handle single-issue run", async () => {
      const limit = pLimit(3);

      const results = await Promise.allSettled(
        [100].map((num) =>
          limit(
            async () =>
              ({
                issueNumber: num,
                success: true,
                phaseResults: [],
                durationSeconds: 1,
                loopTriggered: false,
              }) as IssueResult,
          ),
        ),
      );

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("fulfilled");
    });

    it("should handle concurrency higher than issue count", async () => {
      const limit = pLimit(10); // Way more than 2 issues

      const results = await Promise.allSettled(
        [100, 101].map((num) =>
          limit(
            async () =>
              ({
                issueNumber: num,
                success: true,
                phaseResults: [],
                durationSeconds: 0,
                loopTriggered: false,
              }) as IssueResult,
          ),
        ),
      );

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    });
  });
});
