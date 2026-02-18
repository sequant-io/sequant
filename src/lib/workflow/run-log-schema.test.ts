import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PhaseSchema,
  PhaseStatusSchema,
  IssueStatusSchema,
  PhaseLogSchema,
  IssueLogSchema,
  RunConfigSchema,
  RunLogSchema,
  LOG_PATHS,
  generateLogFilename,
  createEmptyRunLog,
  createPhaseLog,
  completePhaseLog,
  finalizeRunLog,
  type RunConfig,
  type PhaseLog,
  type IssueLog,
} from "./run-log-schema.js";

describe("Zod Schemas", () => {
  describe("PhaseSchema", () => {
    it("accepts valid phases", () => {
      const validPhases = ["spec", "testgen", "exec", "test", "qa", "loop"];
      for (const phase of validPhases) {
        expect(() => PhaseSchema.parse(phase)).not.toThrow();
      }
    });

    it("rejects invalid phases", () => {
      expect(() => PhaseSchema.parse("invalid")).toThrow();
      expect(() => PhaseSchema.parse("")).toThrow();
      expect(() => PhaseSchema.parse(123)).toThrow();
    });
  });

  describe("PhaseStatusSchema", () => {
    it("accepts valid statuses", () => {
      const validStatuses = ["success", "failure", "timeout", "skipped"];
      for (const status of validStatuses) {
        expect(() => PhaseStatusSchema.parse(status)).not.toThrow();
      }
    });

    it("rejects invalid statuses", () => {
      expect(() => PhaseStatusSchema.parse("pending")).toThrow();
      expect(() => PhaseStatusSchema.parse("error")).toThrow();
    });
  });

  describe("IssueStatusSchema", () => {
    it("accepts valid statuses", () => {
      const validStatuses = ["success", "failure", "partial"];
      for (const status of validStatuses) {
        expect(() => IssueStatusSchema.parse(status)).not.toThrow();
      }
    });

    it("rejects invalid statuses", () => {
      expect(() => IssueStatusSchema.parse("pending")).toThrow();
    });
  });

  describe("PhaseLogSchema", () => {
    const validPhaseLog = {
      phase: "spec",
      issueNumber: 123,
      startTime: "2024-01-01T10:00:00.000Z",
      endTime: "2024-01-01T10:05:00.000Z",
      durationSeconds: 300,
      status: "success",
    };

    it("accepts valid phase log", () => {
      expect(() => PhaseLogSchema.parse(validPhaseLog)).not.toThrow();
    });

    it("accepts phase log with optional fields", () => {
      const withOptionals = {
        ...validPhaseLog,
        error: "Something went wrong",
        iterations: 3,
        filesModified: ["file1.ts", "file2.ts"],
        testsRun: 10,
        testsPassed: 8,
      };
      expect(() => PhaseLogSchema.parse(withOptionals)).not.toThrow();
    });

    it("rejects negative issue number", () => {
      expect(() =>
        PhaseLogSchema.parse({ ...validPhaseLog, issueNumber: -1 }),
      ).toThrow();
    });

    it("rejects zero issue number", () => {
      expect(() =>
        PhaseLogSchema.parse({ ...validPhaseLog, issueNumber: 0 }),
      ).toThrow();
    });

    it("rejects non-integer issue number", () => {
      expect(() =>
        PhaseLogSchema.parse({ ...validPhaseLog, issueNumber: 1.5 }),
      ).toThrow();
    });

    it("rejects negative duration", () => {
      expect(() =>
        PhaseLogSchema.parse({ ...validPhaseLog, durationSeconds: -1 }),
      ).toThrow();
    });

    it("accepts zero duration", () => {
      expect(() =>
        PhaseLogSchema.parse({ ...validPhaseLog, durationSeconds: 0 }),
      ).not.toThrow();
    });

    it("rejects invalid datetime format", () => {
      expect(() =>
        PhaseLogSchema.parse({ ...validPhaseLog, startTime: "invalid" }),
      ).toThrow();
    });
  });

  describe("IssueLogSchema", () => {
    const validPhaseLog = {
      phase: "spec",
      issueNumber: 123,
      startTime: "2024-01-01T10:00:00.000Z",
      endTime: "2024-01-01T10:05:00.000Z",
      durationSeconds: 300,
      status: "success",
    };

    const validIssueLog = {
      issueNumber: 123,
      title: "Test Issue",
      labels: ["bug", "priority-high"],
      status: "success",
      phases: [validPhaseLog],
      totalDurationSeconds: 300,
    };

    it("accepts valid issue log", () => {
      expect(() => IssueLogSchema.parse(validIssueLog)).not.toThrow();
    });

    it("accepts empty labels array", () => {
      expect(() =>
        IssueLogSchema.parse({ ...validIssueLog, labels: [] }),
      ).not.toThrow();
    });

    it("accepts empty phases array", () => {
      expect(() =>
        IssueLogSchema.parse({ ...validIssueLog, phases: [] }),
      ).not.toThrow();
    });

    it("rejects missing required fields", () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { title, ...withoutTitle } = validIssueLog;
      expect(() => IssueLogSchema.parse(withoutTitle)).toThrow();
    });
  });

  describe("RunConfigSchema", () => {
    const validConfig = {
      phases: ["spec", "exec", "qa"],
      sequential: false,
      qualityLoop: true,
      maxIterations: 3,
    };

    it("accepts valid config", () => {
      expect(() => RunConfigSchema.parse(validConfig)).not.toThrow();
    });

    it("accepts empty phases array", () => {
      expect(() =>
        RunConfigSchema.parse({ ...validConfig, phases: [] }),
      ).not.toThrow();
    });

    it("rejects zero maxIterations", () => {
      expect(() =>
        RunConfigSchema.parse({ ...validConfig, maxIterations: 0 }),
      ).toThrow();
    });

    it("rejects negative maxIterations", () => {
      expect(() =>
        RunConfigSchema.parse({ ...validConfig, maxIterations: -1 }),
      ).toThrow();
    });

    it("accepts optional chain flag", () => {
      expect(() =>
        RunConfigSchema.parse({ ...validConfig, chain: true }),
      ).not.toThrow();
      expect(() =>
        RunConfigSchema.parse({ ...validConfig, chain: false }),
      ).not.toThrow();
    });

    it("accepts optional qaGate flag", () => {
      expect(() =>
        RunConfigSchema.parse({ ...validConfig, qaGate: true }),
      ).not.toThrow();
      expect(() =>
        RunConfigSchema.parse({ ...validConfig, qaGate: false }),
      ).not.toThrow();
    });

    it("accepts both chain and qaGate flags", () => {
      expect(() =>
        RunConfigSchema.parse({ ...validConfig, chain: true, qaGate: true }),
      ).not.toThrow();
    });

    it("accepts config without chain and qaGate (backwards compatibility)", () => {
      // Existing logs without these fields should still parse
      expect(() => RunConfigSchema.parse(validConfig)).not.toThrow();
    });
  });

  describe("RunLogSchema", () => {
    const validRunLog = {
      version: 1,
      runId: "550e8400-e29b-41d4-a716-446655440000",
      startTime: "2024-01-01T10:00:00.000Z",
      endTime: "2024-01-01T10:30:00.000Z",
      config: {
        phases: ["spec", "exec", "qa"],
        sequential: false,
        qualityLoop: false,
        maxIterations: 3,
      },
      issues: [],
      summary: {
        totalIssues: 0,
        passed: 0,
        failed: 0,
        totalDurationSeconds: 1800,
      },
    };

    it("accepts valid run log", () => {
      expect(() => RunLogSchema.parse(validRunLog)).not.toThrow();
    });

    it("rejects invalid version", () => {
      expect(() =>
        RunLogSchema.parse({ ...validRunLog, version: 2 }),
      ).toThrow();
    });

    it("rejects invalid UUID", () => {
      expect(() =>
        RunLogSchema.parse({ ...validRunLog, runId: "not-a-uuid" }),
      ).toThrow();
    });

    it("validates nested issue logs", () => {
      const withIssues = {
        ...validRunLog,
        issues: [
          {
            issueNumber: 123,
            title: "Test",
            labels: [],
            status: "success",
            phases: [],
            totalDurationSeconds: 100,
          },
        ],
        summary: { ...validRunLog.summary, totalIssues: 1, passed: 1 },
      };
      expect(() => RunLogSchema.parse(withIssues)).not.toThrow();
    });
  });
});

describe("LOG_PATHS", () => {
  it("has user path with home directory placeholder", () => {
    expect(LOG_PATHS.user).toBe("~/.sequant/logs");
  });

  it("has project-relative path", () => {
    expect(LOG_PATHS.project).toBe(".sequant/logs");
  });
});

describe("generateLogFilename", () => {
  it("generates filename with timestamp and runId", () => {
    const runId = "550e8400-e29b-41d4-a716-446655440000";
    const startTime = new Date("2024-01-15T14:30:45.123Z");

    const filename = generateLogFilename(runId, startTime);

    expect(filename).toBe(`run-2024-01-15T14-30-45-${runId}.json`);
  });

  it("replaces colons and dots in timestamp", () => {
    const runId = "test-uuid";
    const startTime = new Date("2024-12-31T23:59:59.999Z");

    const filename = generateLogFilename(runId, startTime);

    expect(filename).not.toContain(":");
    expect(filename).toMatch(/^run-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
  });

  it("ends with .json extension", () => {
    const filename = generateLogFilename("id", new Date());
    expect(filename).toMatch(/\.json$/);
  });
});

describe("createEmptyRunLog", () => {
  const config: RunConfig = {
    phases: ["spec", "exec", "qa"],
    sequential: false,
    qualityLoop: true,
    maxIterations: 3,
  };

  it("creates log with provided config", () => {
    const log = createEmptyRunLog(config);

    expect(log.config).toEqual(config);
  });

  it("generates valid UUID for runId", () => {
    const log = createEmptyRunLog(config);

    // UUID v4 format
    expect(log.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("sets version to 1", () => {
    const log = createEmptyRunLog(config);

    expect(log.version).toBe(1);
  });

  it("sets startTime to current time", () => {
    const before = new Date();
    const log = createEmptyRunLog(config);
    const after = new Date();

    const startTime = new Date(log.startTime);
    expect(startTime.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(startTime.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("initializes empty issues array", () => {
    const log = createEmptyRunLog(config);

    expect(log.issues).toEqual([]);
  });

  it("initializes summary with zeros", () => {
    const log = createEmptyRunLog(config);

    expect(log.summary).toEqual({
      totalIssues: 0,
      passed: 0,
      failed: 0,
      totalDurationSeconds: 0,
    });
  });

  it("does not include endTime", () => {
    const log = createEmptyRunLog(config);

    expect(log).not.toHaveProperty("endTime");
  });
});

describe("createPhaseLog", () => {
  it("creates log with provided phase and issue number", () => {
    const log = createPhaseLog("exec", 456);

    expect(log.phase).toBe("exec");
    expect(log.issueNumber).toBe(456);
  });

  it("sets startTime to current time", () => {
    const before = new Date();
    const log = createPhaseLog("spec", 123);
    const after = new Date();

    const startTime = new Date(log.startTime);
    expect(startTime.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(startTime.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("does not include endTime, durationSeconds, or status", () => {
    const log = createPhaseLog("qa", 789);

    expect(log).not.toHaveProperty("endTime");
    expect(log).not.toHaveProperty("durationSeconds");
    expect(log).not.toHaveProperty("status");
  });
});

describe("completePhaseLog", () => {
  let partialLog: Omit<PhaseLog, "endTime" | "durationSeconds" | "status">;

  beforeEach(() => {
    // Create a phase log with a known start time
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T10:00:00.000Z"));
    partialLog = createPhaseLog("exec", 123);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds endTime, durationSeconds, and status", () => {
    vi.setSystemTime(new Date("2024-01-01T10:05:00.000Z"));

    const completed = completePhaseLog(partialLog, "success");

    expect(completed.endTime).toBe("2024-01-01T10:05:00.000Z");
    expect(completed.durationSeconds).toBe(300); // 5 minutes
    expect(completed.status).toBe("success");
  });

  it("calculates duration correctly", () => {
    vi.setSystemTime(new Date("2024-01-01T10:00:30.500Z"));

    const completed = completePhaseLog(partialLog, "success");

    expect(completed.durationSeconds).toBe(30.5);
  });

  it("preserves original fields", () => {
    vi.setSystemTime(new Date("2024-01-01T10:01:00.000Z"));

    const completed = completePhaseLog(partialLog, "failure");

    expect(completed.phase).toBe("exec");
    expect(completed.issueNumber).toBe(123);
    expect(completed.startTime).toBe("2024-01-01T10:00:00.000Z");
  });

  it("adds optional error field", () => {
    vi.setSystemTime(new Date("2024-01-01T10:01:00.000Z"));

    const completed = completePhaseLog(partialLog, "failure", {
      error: "Build failed",
    });

    expect(completed.error).toBe("Build failed");
  });

  it("adds optional iterations field", () => {
    vi.setSystemTime(new Date("2024-01-01T10:01:00.000Z"));

    const completed = completePhaseLog(partialLog, "success", {
      iterations: 3,
    });

    expect(completed.iterations).toBe(3);
  });

  it("adds optional filesModified field", () => {
    vi.setSystemTime(new Date("2024-01-01T10:01:00.000Z"));

    const completed = completePhaseLog(partialLog, "success", {
      filesModified: ["src/index.ts", "src/utils.ts"],
    });

    expect(completed.filesModified).toEqual(["src/index.ts", "src/utils.ts"]);
  });

  it("adds optional test count fields", () => {
    vi.setSystemTime(new Date("2024-01-01T10:01:00.000Z"));

    const completed = completePhaseLog(partialLog, "success", {
      testsRun: 50,
      testsPassed: 48,
    });

    expect(completed.testsRun).toBe(50);
    expect(completed.testsPassed).toBe(48);
  });

  it("handles all optional fields together", () => {
    vi.setSystemTime(new Date("2024-01-01T10:01:00.000Z"));

    const completed = completePhaseLog(partialLog, "failure", {
      error: "2 tests failed",
      iterations: 2,
      filesModified: ["test.ts"],
      testsRun: 10,
      testsPassed: 8,
    });

    expect(completed.error).toBe("2 tests failed");
    expect(completed.iterations).toBe(2);
    expect(completed.filesModified).toEqual(["test.ts"]);
    expect(completed.testsRun).toBe(10);
    expect(completed.testsPassed).toBe(8);
  });
});

describe("finalizeRunLog", () => {
  const config: RunConfig = {
    phases: ["spec", "exec", "qa"],
    sequential: false,
    qualityLoop: false,
    maxIterations: 3,
  };

  let partialRunLog: Omit<ReturnType<typeof createEmptyRunLog>, "summary"> & {
    issues: IssueLog[];
    summary: {
      totalIssues: number;
      passed: number;
      failed: number;
      totalDurationSeconds: number;
    };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T10:00:00.000Z"));

    const emptyLog = createEmptyRunLog(config);
    partialRunLog = {
      ...emptyLog,
      issues: [],
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds endTime", () => {
    vi.setSystemTime(new Date("2024-01-01T10:30:00.000Z"));

    const finalized = finalizeRunLog(partialRunLog);

    expect(finalized.endTime).toBe("2024-01-01T10:30:00.000Z");
  });

  it("calculates totalDurationSeconds", () => {
    vi.setSystemTime(new Date("2024-01-01T10:30:00.000Z"));

    const finalized = finalizeRunLog(partialRunLog);

    expect(finalized.summary.totalDurationSeconds).toBe(1800); // 30 minutes
  });

  it("counts passed issues correctly", () => {
    partialRunLog.issues = [
      createMockIssueLog(1, "success"),
      createMockIssueLog(2, "success"),
      createMockIssueLog(3, "failure"),
    ];
    vi.setSystemTime(new Date("2024-01-01T10:30:00.000Z"));

    const finalized = finalizeRunLog(partialRunLog);

    expect(finalized.summary.passed).toBe(2);
  });

  it("counts failed issues correctly", () => {
    partialRunLog.issues = [
      createMockIssueLog(1, "success"),
      createMockIssueLog(2, "failure"),
      createMockIssueLog(3, "failure"),
    ];
    vi.setSystemTime(new Date("2024-01-01T10:30:00.000Z"));

    const finalized = finalizeRunLog(partialRunLog);

    expect(finalized.summary.failed).toBe(2);
  });

  it("counts partial status as neither passed nor failed", () => {
    partialRunLog.issues = [
      createMockIssueLog(1, "success"),
      createMockIssueLog(2, "partial"),
      createMockIssueLog(3, "failure"),
    ];
    vi.setSystemTime(new Date("2024-01-01T10:30:00.000Z"));

    const finalized = finalizeRunLog(partialRunLog);

    expect(finalized.summary.passed).toBe(1);
    expect(finalized.summary.failed).toBe(1);
    expect(finalized.summary.totalIssues).toBe(3);
  });

  it("sets totalIssues from issues array length", () => {
    partialRunLog.issues = [
      createMockIssueLog(1, "success"),
      createMockIssueLog(2, "success"),
    ];
    vi.setSystemTime(new Date("2024-01-01T10:30:00.000Z"));

    const finalized = finalizeRunLog(partialRunLog);

    expect(finalized.summary.totalIssues).toBe(2);
  });

  it("handles empty issues array", () => {
    vi.setSystemTime(new Date("2024-01-01T10:30:00.000Z"));

    const finalized = finalizeRunLog(partialRunLog);

    expect(finalized.summary.totalIssues).toBe(0);
    expect(finalized.summary.passed).toBe(0);
    expect(finalized.summary.failed).toBe(0);
  });

  it("preserves original fields", () => {
    vi.setSystemTime(new Date("2024-01-01T10:30:00.000Z"));

    const finalized = finalizeRunLog(partialRunLog);

    expect(finalized.version).toBe(1);
    expect(finalized.runId).toBe(partialRunLog.runId);
    expect(finalized.startTime).toBe(partialRunLog.startTime);
    expect(finalized.config).toEqual(config);
  });

  it("produces valid RunLog according to schema", () => {
    partialRunLog.issues = [createMockIssueLog(1, "success")];
    vi.setSystemTime(new Date("2024-01-01T10:30:00.000Z"));

    const finalized = finalizeRunLog(partialRunLog);

    expect(() => RunLogSchema.parse(finalized)).not.toThrow();
  });
});

// Helper function for tests
function createMockIssueLog(
  issueNumber: number,
  status: "success" | "failure" | "partial",
): IssueLog {
  return {
    issueNumber,
    title: `Issue #${issueNumber}`,
    labels: [],
    status,
    phases: [],
    totalDurationSeconds: 100,
  };
}
