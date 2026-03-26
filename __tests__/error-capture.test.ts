// Tests for Issue #447 — Improve error capture for tooling failures
// Run with: npm test -- __tests__/error-capture.test.ts

import { describe, it, expect } from "vitest";
import { RingBuffer } from "../src/lib/workflow/ring-buffer.js";
import {
  classifyError,
  ERROR_CATEGORIES,
} from "../src/lib/workflow/error-classifier.js";
import {
  ErrorContextSchema,
  PhaseLogSchema,
} from "../src/lib/workflow/run-log-schema.js";
import { createPhaseLogFromTiming } from "../src/lib/workflow/log-writer.js";

// === AC-1: Phase runner captures stderr/stdout tail (last 50 lines) ===

describe("RingBuffer", () => {
  describe("AC-1: Output tail capture", () => {
    it("should retain last 50 lines when more than 50 lines are pushed", () => {
      const buffer = new RingBuffer(50);
      for (let i = 0; i < 100; i++) {
        buffer.push(`line-${i}`);
      }

      const lines = buffer.getLines();
      expect(lines).toHaveLength(50);
      expect(lines[0]).toBe("line-50");
      expect(lines[49]).toBe("line-99");
    });

    it("should retain all lines when fewer than capacity are pushed", () => {
      const buffer = new RingBuffer(50);
      for (let i = 0; i < 10; i++) {
        buffer.push(`line-${i}`);
      }

      const lines = buffer.getLines();
      expect(lines).toHaveLength(10);
      expect(lines[0]).toBe("line-0");
      expect(lines[9]).toBe("line-9");
    });

    it("should handle empty buffer gracefully", () => {
      const buffer = new RingBuffer(50);
      expect(buffer.getLines()).toEqual([]);
    });

    // === FAILURE PATHS ===
    describe("error handling", () => {
      it("should handle lines with special characters (unicode, newlines)", () => {
        const buffer = new RingBuffer(5);
        buffer.push("Hello 🌍");
        buffer.push("日本語テスト");
        buffer.push("line\twith\ttabs");

        const lines = buffer.getLines();
        expect(lines).toHaveLength(3);
        expect(lines[0]).toBe("Hello 🌍");
        expect(lines[1]).toBe("日本語テスト");
        expect(lines[2]).toBe("line\twith\ttabs");
      });

      it("should handle very long lines without truncation", () => {
        const buffer = new RingBuffer(5);
        const longLine = "x".repeat(20_000);
        buffer.push(longLine);

        const lines = buffer.getLines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toHaveLength(20_000);
      });
    });
  });
});

// === AC-2: Structured error info stored in PhaseLog ===

describe("ErrorContext in PhaseLog", () => {
  describe("AC-2: errorContext field in PhaseLog", () => {
    it("should include errorContext when created from a failed phase with captured output", () => {
      const startTime = new Date("2026-01-01T00:00:00Z");
      const endTime = new Date("2026-01-01T00:05:00Z");

      const phaseLog = createPhaseLogFromTiming(
        "exec",
        123,
        startTime,
        endTime,
        "failure",
        {
          error: "Process exited with code 1",
          errorContext: {
            stderrTail: ["error: Cannot find module 'foo'"],
            stdoutTail: ["Building..."],
            exitCode: 1,
            category: "build_error",
          },
        },
      );

      expect(phaseLog.errorContext).toBeDefined();
      expect(phaseLog.errorContext!.category).toBe("build_error");
      expect(phaseLog.errorContext!.stderrTail).toEqual([
        "error: Cannot find module 'foo'",
      ]);
      expect(phaseLog.errorContext!.stdoutTail).toEqual(["Building..."]);
      expect(phaseLog.errorContext!.exitCode).toBe(1);
    });

    it("should validate errorContext against ErrorContextSchema", () => {
      const valid = {
        stderrTail: ["error line 1", "error line 2"],
        stdoutTail: [],
        exitCode: 1,
        category: "api_error" as const,
      };

      const result = ErrorContextSchema.parse(valid);
      expect(result.category).toBe("api_error");
      expect(result.stderrTail).toHaveLength(2);
    });

    it("should serialize errorContext to JSON log on disk correctly", () => {
      const startTime = new Date("2026-01-01T00:00:00Z");
      const endTime = new Date("2026-01-01T00:05:00Z");

      const phaseLog = createPhaseLogFromTiming(
        "exec",
        42,
        startTime,
        endTime,
        "failure",
        {
          error: "exit code 1",
          errorContext: {
            stderrTail: ["line1", "line2"],
            stdoutTail: [],
            category: "unknown",
          },
        },
      );

      const json = JSON.stringify(phaseLog);
      const parsed = JSON.parse(json);
      const validated = PhaseLogSchema.parse(parsed);

      expect(validated.errorContext).toBeDefined();
      expect(validated.errorContext!.stderrTail).toEqual(["line1", "line2"]);
      expect(validated.errorContext!.category).toBe("unknown");
    });

    it("should round-trip exitCode through createPhaseLogFromTiming and schema", () => {
      const startTime = new Date("2026-01-01T00:00:00Z");
      const endTime = new Date("2026-01-01T00:05:00Z");

      const phaseLog = createPhaseLogFromTiming(
        "exec",
        123,
        startTime,
        endTime,
        "failure",
        {
          error: "Aider exited with code 2",
          errorContext: {
            stderrTail: ["some error"],
            stdoutTail: [],
            exitCode: 2,
            category: "unknown",
          },
        },
      );

      expect(phaseLog.errorContext!.exitCode).toBe(2);

      // Round-trip through JSON + schema validation
      const json = JSON.stringify(phaseLog);
      const parsed = PhaseLogSchema.parse(JSON.parse(json));
      expect(parsed.errorContext!.exitCode).toBe(2);
    });

    it("should allow errorContext without exitCode (SDK-based drivers)", () => {
      const ctx = {
        stderrTail: ["error"],
        stdoutTail: [],
        category: "unknown" as const,
      };
      const result = ErrorContextSchema.parse(ctx);
      expect(result.exitCode).toBeUndefined();
    });

    // === FAILURE PATHS ===
    describe("error handling", () => {
      it("should allow PhaseLog without errorContext (backward compat)", () => {
        const phaseLog = {
          phase: "exec",
          issueNumber: 1,
          startTime: "2026-01-01T00:00:00.000Z",
          endTime: "2026-01-01T00:05:00.000Z",
          durationSeconds: 300,
          status: "failure",
          error: "Process exited with code 1",
        };

        const result = PhaseLogSchema.parse(phaseLog);
        expect(result.errorContext).toBeUndefined();
      });

      it("should handle empty stderrTail and stdoutTail arrays", () => {
        const ctx = {
          stderrTail: [],
          stdoutTail: [],
          category: "unknown" as const,
        };

        const result = ErrorContextSchema.parse(ctx);
        expect(result.stderrTail).toEqual([]);
        expect(result.stdoutTail).toEqual([]);
      });
    });
  });
});

// === AC-4: Failure categorization in stats ===

describe("Error Classifier", () => {
  describe("AC-4: Failure categorization", () => {
    it("should classify context overflow errors", () => {
      expect(
        classifyError(["Error: context window exceeded, max tokens reached"]),
      ).toBe("context_overflow");
    });

    it("should classify API errors", () => {
      expect(classifyError(["Error 429: rate limit exceeded"])).toBe(
        "api_error",
      );
    });

    it("should classify hook failures", () => {
      expect(classifyError(["HOOK_BLOCKED: pre-commit hook failed"])).toBe(
        "hook_failure",
      );
    });

    it("should classify build/syntax errors", () => {
      expect(classifyError(["error TS2304: Cannot find name 'foo'."])).toBe(
        "build_error",
      );
    });

    it("should classify timeout errors", () => {
      expect(classifyError(["Process timed out after 1800s"])).toBe("timeout");
    });

    it("should fall back to unknown for unrecognized patterns", () => {
      expect(classifyError(["Something went wrong in an unexpected way"])).toBe(
        "unknown",
      );
    });

    // === FAILURE PATHS ===
    describe("error handling", () => {
      it("should handle empty stderr array", () => {
        expect(classifyError([])).toBe("unknown");
      });

      it("should NOT classify HTTP codes embedded in larger numbers", () => {
        expect(classifyError(["connecting on port 50200"])).toBe("unknown");
        expect(classifyError(["processed batch 4290 records"])).toBe("unknown");
        expect(classifyError(["reference ID 15029"])).toBe("unknown");
      });

      it("should handle stderr with multiple matching patterns (first wins)", () => {
        // "timeout" has higher priority than "api_error"
        const result = classifyError([
          "connection timeout after 30s",
          "api error: 503 service unavailable",
        ]);
        expect(result).toBe("timeout");
      });
    });
  });
});

// === AC-4: Stats grouping by error category ===

describe("Stats with error categories", () => {
  describe("AC-4: calculateStats groups failures by category", () => {
    // Note: calculateStats is not exported, so we test the logic
    // through the schema structure and error classifier directly.
    // Integration test covers the full flow.

    it("should group failures by errorContext.category", () => {
      // Verify that PhaseLog with errorContext parses correctly
      // for stats consumption
      const phaseLogs = [
        {
          phase: "exec",
          issueNumber: 1,
          startTime: "2026-01-01T00:00:00.000Z",
          endTime: "2026-01-01T00:05:00.000Z",
          durationSeconds: 300,
          status: "failure",
          error: "exit 1",
          errorContext: {
            stderrTail: ["context window exceeded"],
            stdoutTail: [],
            category: "context_overflow",
          },
        },
        {
          phase: "exec",
          issueNumber: 2,
          startTime: "2026-01-01T00:10:00.000Z",
          endTime: "2026-01-01T00:15:00.000Z",
          durationSeconds: 300,
          status: "failure",
          error: "exit 1",
          errorContext: {
            stderrTail: ["rate limit"],
            stdoutTail: [],
            category: "api_error",
          },
        },
      ];

      // Validate each log parses with errorContext
      for (const log of phaseLogs) {
        const parsed = PhaseLogSchema.parse(log);
        expect(parsed.errorContext?.category).toBeDefined();
      }

      // Simulate the stats grouping logic
      const categories = new Map<string, number>();
      for (const log of phaseLogs) {
        const key = log.errorContext?.category
          ? `${log.phase}: [${log.errorContext.category}]`
          : `${log.phase}: ${log.error?.slice(0, 100)}`;
        categories.set(key, (categories.get(key) ?? 0) + 1);
      }

      expect(categories.get("exec: [context_overflow]")).toBe(1);
      expect(categories.get("exec: [api_error]")).toBe(1);
    });

    it("should fall back to truncated error string for old logs without errorContext", () => {
      const oldLog = {
        phase: "exec",
        issueNumber: 1,
        startTime: "2026-01-01T00:00:00.000Z",
        endTime: "2026-01-01T00:05:00.000Z",
        durationSeconds: 300,
        status: "failure",
        error: "Process exited with code 1",
      };

      const parsed = PhaseLogSchema.parse(oldLog);
      expect(parsed.errorContext).toBeUndefined();

      // Stats should fall back to truncated error
      const key = parsed.errorContext?.category
        ? `${parsed.phase}: [${parsed.errorContext.category}]`
        : `${parsed.phase}: ${parsed.error?.slice(0, 100)}`;
      expect(key).toBe("exec: Process exited with code 1");
    });

    // === FAILURE PATHS ===
    describe("error handling", () => {
      it("should handle mix of old and new log formats", () => {
        const logs = [
          {
            phase: "exec",
            issueNumber: 1,
            startTime: "2026-01-01T00:00:00.000Z",
            endTime: "2026-01-01T00:05:00.000Z",
            durationSeconds: 300,
            status: "failure",
            error: "old error",
          },
          {
            phase: "spec",
            issueNumber: 2,
            startTime: "2026-01-01T00:10:00.000Z",
            endTime: "2026-01-01T00:15:00.000Z",
            durationSeconds: 300,
            status: "failure",
            error: "exit 1",
            errorContext: {
              stderrTail: ["timeout"],
              stdoutTail: [],
              category: "timeout",
            },
          },
        ];

        // Both should parse
        for (const log of logs) {
          expect(() => PhaseLogSchema.parse(log)).not.toThrow();
        }
      });
    });
  });
});

// === Derived AC-5: Backward compatibility ===

describe("Backward Compatibility", () => {
  describe("AC-5: Old logs without errorContext render correctly", () => {
    it("should parse old PhaseLog format without errorContext", () => {
      const oldPhaseLog = {
        phase: "exec",
        issueNumber: 42,
        startTime: "2025-12-01T00:00:00.000Z",
        endTime: "2025-12-01T00:10:00.000Z",
        durationSeconds: 600,
        status: "failure",
        error: "Process exited with code 1",
      };

      const result = PhaseLogSchema.parse(oldPhaseLog);
      expect(result.errorContext).toBeUndefined();
      expect(result.error).toBe("Process exited with code 1");
    });

    it("should display old logs in sequant logs --failed without errors", () => {
      // Verify that code can safely access errorContext on old logs
      const phaseLog = PhaseLogSchema.parse({
        phase: "exec",
        issueNumber: 42,
        startTime: "2025-12-01T00:00:00.000Z",
        endTime: "2025-12-01T00:10:00.000Z",
        durationSeconds: 600,
        status: "failure",
        error: "Process exited with code 1",
      });

      // This is the guard pattern used in logs.ts
      if (phaseLog.errorContext) {
        // Should not reach here for old logs
        expect.unreachable("Old logs should not have errorContext");
      }

      // No crash — test passes
      expect(phaseLog.error).toBeDefined();
    });
  });
});

// === Derived AC-7: Error categories as constants ===

describe("Error Category Constants", () => {
  describe("AC-7: Categories defined as constants", () => {
    it("should export error categories as a readonly array", () => {
      expect(ERROR_CATEGORIES).toBeDefined();
      expect(ERROR_CATEGORIES).toContain("context_overflow");
      expect(ERROR_CATEGORIES).toContain("api_error");
      expect(ERROR_CATEGORIES).toContain("hook_failure");
      expect(ERROR_CATEGORIES).toContain("build_error");
      expect(ERROR_CATEGORIES).toContain("timeout");
      expect(ERROR_CATEGORIES).toContain("unknown");
      expect(ERROR_CATEGORIES).toHaveLength(6);
    });
  });
});
