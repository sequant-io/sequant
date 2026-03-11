/**
 * Direct import tests for run-summary module.
 *
 * These tests verify that run-summary exports are importable
 * directly and test pure functions.
 */

import { describe, it, expect, vi } from "vitest";
import { recordRunMetrics, printRunSummary } from "./run-summary.js";
import type { IssueResult } from "./types.js";

describe("run-summary direct imports", () => {
  describe("exports exist", () => {
    it("should export recordRunMetrics", () => {
      expect(typeof recordRunMetrics).toBe("function");
    });

    it("should export printRunSummary", () => {
      expect(typeof printRunSummary).toBe("function");
    });
  });

  describe("printRunSummary", () => {
    it("should return 0 exit code when all pass", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const results: IssueResult[] = [
          {
            issueNumber: 1,
            success: true,
            phaseResults: [
              { phase: "exec", success: true, durationSeconds: 10 },
              { phase: "qa", success: true, durationSeconds: 5 },
            ],
            loopTriggered: false,
            durationSeconds: 15,
          },
        ];

        const exitCode = printRunSummary({
          results,
          logPath: null,
          config: {
            phases: ["exec", "qa"],
            sequential: false,
            dryRun: false,
            verbose: false,
            phaseTimeout: 300,
            qualityLoop: false,
            maxIterations: 3,
            noSmartTests: false,
            mcp: true,
            retry: true,
          },
          mergedOptions: {},
        });

        expect(exitCode).toBe(0);
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it("should return 1 exit code when any fail", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const results: IssueResult[] = [
          {
            issueNumber: 1,
            success: false,
            phaseResults: [
              {
                phase: "exec",
                success: false,
                durationSeconds: 10,
                error: "fail",
              },
            ],
            loopTriggered: false,
            durationSeconds: 10,
          },
        ];

        const exitCode = printRunSummary({
          results,
          logPath: null,
          config: {
            phases: ["exec", "qa"],
            sequential: false,
            dryRun: false,
            verbose: false,
            phaseTimeout: 300,
            qualityLoop: false,
            maxIterations: 3,
            noSmartTests: false,
            mcp: true,
            retry: true,
          },
          mergedOptions: {},
        });

        expect(exitCode).toBe(1);
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it("should return 0 in dry run even with failures", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const results: IssueResult[] = [
          {
            issueNumber: 1,
            success: false,
            phaseResults: [],
            loopTriggered: false,
            durationSeconds: 0,
          },
        ];

        const exitCode = printRunSummary({
          results,
          logPath: null,
          config: {
            phases: ["exec"],
            sequential: false,
            dryRun: true,
            verbose: false,
            phaseTimeout: 300,
            qualityLoop: false,
            maxIterations: 3,
            noSmartTests: false,
            mcp: true,
            retry: true,
          },
          mergedOptions: {},
        });

        expect(exitCode).toBe(0);
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });
});
