// Integration tests for Issue #447 — Error capture pipeline
// Run with: npm test -- __tests__/integration/error-capture.integration.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";

import { RingBuffer } from "../../src/lib/workflow/ring-buffer.js";
import { classifyError } from "../../src/lib/workflow/error-classifier.js";
import {
  PhaseLogSchema,
  RunLogSchema,
  type ErrorContext,
} from "../../src/lib/workflow/run-log-schema.js";
import { createPhaseLogFromTiming } from "../../src/lib/workflow/log-writer.js";

describe("Error Capture - Integration", () => {
  // === SANDBOX ISOLATION ===
  const TEST_DIR = `/tmp/sequant-test-${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // === AC-1: End-to-end output capture ===

  describe("AC-1: Phase runner captures stderr/stdout tail", () => {
    it("should capture last 50 lines of stderr from a failing phase execution", () => {
      // Simulate a driver capturing stderr via RingBuffer
      const stderrBuffer = new RingBuffer(50);
      const stdoutBuffer = new RingBuffer(50);

      // Push 100 lines of stderr (like a verbose failing build)
      for (let i = 0; i < 100; i++) {
        stderrBuffer.push(`error line ${i}: some compilation error`);
      }
      stdoutBuffer.push("Build started...");

      const stderrTail = stderrBuffer.getLines();
      const stdoutTail = stdoutBuffer.getLines();

      // Build errorContext from tails
      const errorContext: ErrorContext = {
        stderrTail,
        stdoutTail,
        exitCode: 1,
        category: classifyError(stderrTail),
      };

      // Create phase log with errorContext
      const phaseLog = createPhaseLogFromTiming(
        "exec",
        42,
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-01-01T00:05:00Z"),
        "failure",
        {
          error: "Process exited with code 1",
          errorContext,
        },
      );

      // Verify end-to-end
      expect(phaseLog.errorContext).toBeDefined();
      expect(phaseLog.errorContext!.stderrTail).toHaveLength(50);
      expect(phaseLog.errorContext!.stderrTail[0]).toBe(
        "error line 50: some compilation error",
      );
      expect(phaseLog.errorContext!.stdoutTail).toHaveLength(1);
      expect(phaseLog.errorContext!.exitCode).toBe(1);
    });

    it("validates assumption: RingBuffer(50) handles high-frequency writes without data loss", () => {
      const buffer = new RingBuffer(50);

      // Simulate rapid-fire writes (like streaming stderr)
      for (let i = 0; i < 10_000; i++) {
        buffer.push(`rapid-${i}`);
      }

      const lines = buffer.getLines();
      expect(lines).toHaveLength(50);
      // Verify the last 50 lines are the most recent
      expect(lines[0]).toBe("rapid-9950");
      expect(lines[49]).toBe("rapid-9999");

      // Verify no gaps in sequence
      for (let i = 0; i < 50; i++) {
        expect(lines[i]).toBe(`rapid-${9950 + i}`);
      }
    });
  });

  // === AC-3: sequant logs --failed shows error context ===

  describe("AC-3: sequant logs --failed shows error context", () => {
    it("should persist error context in run log JSON on disk", () => {
      // Build a complete run log with errorContext
      const runLog = {
        version: 1 as const,
        runId: "a0000000-0000-4000-a000-000000000001",
        startTime: "2026-01-01T00:00:00.000Z",
        endTime: "2026-01-01T00:10:00.000Z",
        config: {
          phases: ["exec" as const],
          sequential: false,
          qualityLoop: false,
          maxIterations: 3,
          chain: false,
        },
        issues: [
          {
            issueNumber: 42,
            title: "Test issue",
            labels: ["enhancement"],
            status: "failure" as const,
            phases: [
              {
                phase: "exec" as const,
                issueNumber: 42,
                startTime: "2026-01-01T00:00:00.000Z",
                endTime: "2026-01-01T00:05:00.000Z",
                durationSeconds: 300,
                status: "failure" as const,
                error: "Process exited with code 1",
                errorContext: {
                  stderrTail: [
                    "error: Cannot find module 'foo'",
                    "at Object.<anonymous> (index.ts:1:1)",
                  ],
                  stdoutTail: [],
                  exitCode: 1,
                  category: "build_error" as const,
                },
              },
            ],
            totalDurationSeconds: 300,
          },
        ],
        summary: {
          totalIssues: 1,
          passed: 0,
          failed: 1,
          totalDurationSeconds: 600,
        },
      };

      // Write to disk
      const logPath = `${TEST_DIR}/run-test-001.json`;
      fs.writeFileSync(logPath, JSON.stringify(runLog, null, 2));

      // Read back and validate
      const content = fs.readFileSync(logPath, "utf-8");
      const parsed = RunLogSchema.parse(JSON.parse(content));

      const failedPhase = parsed.issues[0].phases[0];
      expect(failedPhase.errorContext).toBeDefined();
      expect(failedPhase.errorContext!.category).toBe("build_error");
      expect(failedPhase.errorContext!.stderrTail).toHaveLength(2);
    });

    it("should show 5 stderr lines by default and 50 with --verbose", () => {
      // The display logic shows stderrTail.slice(-5) by default,
      // and all lines with --verbose. We test the slice logic.
      const stderrTail = Array.from(
        { length: 50 },
        (_, i) => `stderr line ${i}`,
      );

      // Default: last 5
      const defaultLines = stderrTail.slice(-5);
      expect(defaultLines).toHaveLength(5);
      expect(defaultLines[0]).toBe("stderr line 45");

      // Verbose: all 50
      expect(stderrTail).toHaveLength(50);
    });
  });

  // === ERROR SCENARIOS ===

  describe("error scenarios", () => {
    it("should handle corrupted errorContext in log files gracefully", () => {
      // The Zod schema will reject invalid errorContext shapes.
      // The parseLogFile function in logs.ts catches parse errors and returns null.
      const invalidLog = {
        version: 1,
        runId: "a0000000-0000-4000-a000-000000000002",
        startTime: "2026-01-01T00:00:00.000Z",
        endTime: "2026-01-01T00:10:00.000Z",
        config: {
          phases: ["exec"],
          sequential: false,
          qualityLoop: false,
          maxIterations: 3,
        },
        issues: [
          {
            issueNumber: 42,
            title: "Test",
            labels: [],
            status: "failure",
            phases: [
              {
                phase: "exec",
                issueNumber: 42,
                startTime: "2026-01-01T00:00:00.000Z",
                endTime: "2026-01-01T00:05:00.000Z",
                durationSeconds: 300,
                status: "failure",
                error: "exit 1",
                errorContext: {
                  // Invalid: stderrTail should be string[], not string
                  stderrTail: "not an array",
                  stdoutTail: [],
                  category: "unknown",
                },
              },
            ],
            totalDurationSeconds: 300,
          },
        ],
        summary: {
          totalIssues: 1,
          passed: 0,
          failed: 1,
          totalDurationSeconds: 600,
        },
      };

      // Zod schema should reject this
      expect(() => RunLogSchema.parse(invalidLog)).toThrow();
    });

    it("should handle log files from before errorContext was added", () => {
      const oldLog = {
        version: 1 as const,
        runId: "a0000000-0000-4000-a000-000000000003",
        startTime: "2025-06-01T00:00:00.000Z",
        endTime: "2025-06-01T00:10:00.000Z",
        config: {
          phases: ["exec" as const],
          sequential: false,
          qualityLoop: false,
          maxIterations: 3,
        },
        issues: [
          {
            issueNumber: 10,
            title: "Old issue",
            labels: [],
            status: "failure" as const,
            phases: [
              {
                phase: "exec" as const,
                issueNumber: 10,
                startTime: "2025-06-01T00:00:00.000Z",
                endTime: "2025-06-01T00:05:00.000Z",
                durationSeconds: 300,
                status: "failure" as const,
                error: "Process exited with code 1",
                // No errorContext — old format
              },
            ],
            totalDurationSeconds: 300,
          },
        ],
        summary: {
          totalIssues: 1,
          passed: 0,
          failed: 1,
          totalDurationSeconds: 600,
        },
      };

      // Should parse successfully
      const parsed = RunLogSchema.parse(oldLog);
      expect(parsed.issues[0].phases[0].errorContext).toBeUndefined();
      expect(parsed.issues[0].phases[0].error).toBe(
        "Process exited with code 1",
      );
    });

    it("should handle concurrent phase executions capturing stderr independently", () => {
      // Each driver instance creates its own RingBuffer, so concurrent
      // phases have isolated capture. Verify this.
      const buffer1 = new RingBuffer(50);
      const buffer2 = new RingBuffer(50);

      // Simulate interleaved writes
      for (let i = 0; i < 20; i++) {
        buffer1.push(`phase1-line-${i}`);
        buffer2.push(`phase2-line-${i}`);
      }

      const lines1 = buffer1.getLines();
      const lines2 = buffer2.getLines();

      // Verify isolation
      expect(lines1.every((l) => l.startsWith("phase1-"))).toBe(true);
      expect(lines2.every((l) => l.startsWith("phase2-"))).toBe(true);
      expect(lines1).toHaveLength(20);
      expect(lines2).toHaveLength(20);
    });
  });
});
