/**
 * Unit tests for LogWriter
 *
 * Tests the structured logging system that writes JSON run logs to disk.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { LogWriter, createPhaseLogFromTiming } from "./log-writer.js";
import type { RunConfig, PhaseLog } from "./run-log-schema.js";

// Mock fs module - include all functions needed by log-rotation.ts
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ mtime: new Date(), size: 1024 })),
  unlinkSync: vi.fn(),
}));

// Mock crypto.randomUUID for deterministic tests
const mockUUID = "12345678-1234-1234-1234-123456789abc";
vi.mock("node:crypto", () => ({
  randomUUID: () => mockUUID,
}));

describe("LogWriter", () => {
  const mockConfig: RunConfig = {
    phases: ["spec", "exec", "qa"],
    sequential: false,
    qualityLoop: true,
    maxIterations: 3,
  };

  const mockPhaseLog: PhaseLog = {
    phase: "spec",
    issueNumber: 123,
    startTime: "2024-01-15T10:00:00.000Z",
    endTime: "2024-01-15T10:01:30.000Z",
    durationSeconds: 90,
    status: "success",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T10:00:00.000Z"));
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("should use default options when none provided", () => {
      const writer = new LogWriter();
      // Can't directly test private fields, but we can verify behavior
      expect(writer.getRunLog()).toBeNull();
      expect(writer.getRunId()).toBeNull();
    });

    it("should accept custom log path", async () => {
      const writer = new LogWriter({ logPath: "/custom/logs" });
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      await writer.initialize(mockConfig);

      expect(fs.mkdirSync).toHaveBeenCalledWith("/custom/logs", {
        recursive: true,
      });
    });

    it("should respect writeToUserLogs option", async () => {
      const writer = new LogWriter({ writeToUserLogs: true });
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      await writer.initialize(mockConfig);

      // Should create both project and user log directories
      const expectedUserPath = path.join(os.homedir(), ".sequant/logs");
      expect(fs.mkdirSync).toHaveBeenCalledWith(expectedUserPath, {
        recursive: true,
      });
    });

    it("should respect verbose option", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const writer = new LogWriter({ verbose: true });

      await writer.initialize(mockConfig);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Log initialized"),
      );
      consoleSpy.mockRestore();
    });
  });

  describe("initialize", () => {
    it("should create a run log with correct structure", async () => {
      const writer = new LogWriter();
      await writer.initialize(mockConfig);

      const runLog = writer.getRunLog();
      expect(runLog).not.toBeNull();
      expect(runLog!.version).toBe(1);
      expect(runLog!.runId).toBe(mockUUID);
      expect(runLog!.config).toEqual(mockConfig);
      expect(runLog!.issues).toEqual([]);
      expect(runLog!.summary).toEqual({
        totalIssues: 0,
        passed: 0,
        failed: 0,
        totalDurationSeconds: 0,
      });
    });

    it("should create log directory if it does not exist", async () => {
      const writer = new LogWriter({ logPath: "/test/logs" });
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      await writer.initialize(mockConfig);

      expect(fs.mkdirSync).toHaveBeenCalledWith("/test/logs", {
        recursive: true,
      });
    });

    it("should not create directory if it already exists", async () => {
      const writer = new LogWriter();
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

      await writer.initialize(mockConfig);

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it("should resolve ~ in paths to home directory", async () => {
      const writer = new LogWriter({ logPath: "~/custom/logs" });
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      await writer.initialize(mockConfig);

      const expectedPath = path.join(os.homedir(), "custom/logs");
      expect(fs.mkdirSync).toHaveBeenCalledWith(expectedPath, {
        recursive: true,
      });
    });
  });

  describe("startIssue", () => {
    it("should initialize a new issue", async () => {
      const writer = new LogWriter();
      await writer.initialize(mockConfig);

      writer.startIssue(123, "Test Issue", ["bug", "priority"]);

      // Issue is not added to runLog until completeIssue()
      const runLog = writer.getRunLog();
      expect(runLog!.issues).toHaveLength(0);
    });

    it("should throw if not initialized", () => {
      const writer = new LogWriter();

      expect(() => {
        writer.startIssue(123, "Test Issue", []);
      }).toThrow("LogWriter not initialized");
    });

    it("should log to console in verbose mode", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const writer = new LogWriter({ verbose: true });
      await writer.initialize(mockConfig);

      writer.startIssue(123, "Test Issue", []);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Started logging issue #123"),
      );
      consoleSpy.mockRestore();
    });
  });

  describe("logPhase", () => {
    it("should add phase to current issue", async () => {
      const writer = new LogWriter();
      await writer.initialize(mockConfig);
      writer.startIssue(123, "Test Issue", []);

      writer.logPhase(mockPhaseLog);
      writer.completeIssue();

      const runLog = writer.getRunLog();
      expect(runLog!.issues[0].phases).toHaveLength(1);
      expect(runLog!.issues[0].phases[0]).toEqual(mockPhaseLog);
    });

    it("should update issue status to failure when phase fails", async () => {
      const writer = new LogWriter();
      await writer.initialize(mockConfig);
      writer.startIssue(123, "Test Issue", []);

      const failedPhase: PhaseLog = {
        ...mockPhaseLog,
        status: "failure",
        error: "Something went wrong",
      };
      writer.logPhase(failedPhase);
      writer.completeIssue();

      const runLog = writer.getRunLog();
      expect(runLog!.issues[0].status).toBe("failure");
    });

    it("should update issue status to partial when phase times out", async () => {
      const writer = new LogWriter();
      await writer.initialize(mockConfig);
      writer.startIssue(123, "Test Issue", []);

      const timedOutPhase: PhaseLog = {
        ...mockPhaseLog,
        status: "timeout",
      };
      writer.logPhase(timedOutPhase);
      writer.completeIssue();

      const runLog = writer.getRunLog();
      expect(runLog!.issues[0].status).toBe("partial");
    });

    it("should keep failure status even if subsequent phase times out", async () => {
      const writer = new LogWriter();
      await writer.initialize(mockConfig);
      writer.startIssue(123, "Test Issue", []);

      const failedPhase: PhaseLog = { ...mockPhaseLog, status: "failure" };
      const timedOutPhase: PhaseLog = { ...mockPhaseLog, status: "timeout" };

      writer.logPhase(failedPhase);
      writer.logPhase(timedOutPhase);
      writer.completeIssue();

      const runLog = writer.getRunLog();
      expect(runLog!.issues[0].status).toBe("failure");
    });

    it("should throw if no current issue", async () => {
      const writer = new LogWriter();
      await writer.initialize(mockConfig);

      expect(() => {
        writer.logPhase(mockPhaseLog);
      }).toThrow("No current issue");
    });

    it("should log to console in verbose mode", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const writer = new LogWriter({ verbose: true });
      await writer.initialize(mockConfig);
      writer.startIssue(123, "Test Issue", []);

      writer.logPhase(mockPhaseLog);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Logged phase: spec (success)"),
      );
      consoleSpy.mockRestore();
    });
  });

  describe("completeIssue", () => {
    it("should calculate total duration from phases", async () => {
      const writer = new LogWriter();
      await writer.initialize(mockConfig);
      writer.startIssue(123, "Test Issue", []);

      const phase1: PhaseLog = { ...mockPhaseLog, durationSeconds: 30 };
      const phase2: PhaseLog = {
        ...mockPhaseLog,
        phase: "exec",
        durationSeconds: 60,
      };
      const phase3: PhaseLog = {
        ...mockPhaseLog,
        phase: "qa",
        durationSeconds: 45,
      };

      writer.logPhase(phase1);
      writer.logPhase(phase2);
      writer.logPhase(phase3);
      writer.completeIssue();

      const runLog = writer.getRunLog();
      expect(runLog!.issues[0].totalDurationSeconds).toBe(135);
    });

    it("should add issue to run log", async () => {
      const writer = new LogWriter();
      await writer.initialize(mockConfig);
      writer.startIssue(123, "Test Issue", ["bug"]);
      writer.logPhase(mockPhaseLog);
      writer.completeIssue();

      const runLog = writer.getRunLog();
      expect(runLog!.issues).toHaveLength(1);
      expect(runLog!.issues[0].issueNumber).toBe(123);
      expect(runLog!.issues[0].title).toBe("Test Issue");
      expect(runLog!.issues[0].labels).toEqual(["bug"]);
    });

    it("should allow starting a new issue after completing", async () => {
      const writer = new LogWriter();
      await writer.initialize(mockConfig);

      writer.startIssue(123, "First Issue", []);
      writer.logPhase(mockPhaseLog);
      writer.completeIssue();

      writer.startIssue(456, "Second Issue", []);
      writer.logPhase({ ...mockPhaseLog, issueNumber: 456 });
      writer.completeIssue();

      const runLog = writer.getRunLog();
      expect(runLog!.issues).toHaveLength(2);
      expect(runLog!.issues[0].issueNumber).toBe(123);
      expect(runLog!.issues[1].issueNumber).toBe(456);
    });

    it("should throw if no current issue", async () => {
      const writer = new LogWriter();
      await writer.initialize(mockConfig);

      expect(() => {
        writer.completeIssue();
      }).toThrow("No current issue to complete");
    });

    it("should throw if writer not initialized", () => {
      const writer = new LogWriter();

      expect(() => {
        writer.completeIssue();
      }).toThrow("No current issue to complete");
    });
  });

  describe("finalize", () => {
    it("should write log file to disk", async () => {
      const writer = new LogWriter({ logPath: "/test/logs" });
      await writer.initialize(mockConfig);
      writer.startIssue(123, "Test Issue", []);
      writer.logPhase(mockPhaseLog);
      writer.completeIssue();

      const logPath = await writer.finalize();

      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(logPath).toContain("/test/logs/");
      expect(logPath).toContain(".json");
    });

    it("should auto-complete pending issue before finalizing", async () => {
      const writer = new LogWriter({ logPath: "/test/logs" });
      await writer.initialize(mockConfig);
      writer.startIssue(123, "Test Issue", []);
      writer.logPhase(mockPhaseLog);
      // Note: not calling completeIssue()

      await writer.finalize();

      const writeCall = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock
        .calls[0];
      const writtenLog = JSON.parse(writeCall[1] as string);
      expect(writtenLog.issues).toHaveLength(1);
    });

    it("should write to user logs when option is enabled", async () => {
      const writer = new LogWriter({
        logPath: "/project/logs",
        writeToUserLogs: true,
      });
      await writer.initialize(mockConfig);
      writer.startIssue(123, "Test", []);
      writer.logPhase(mockPhaseLog);
      writer.completeIssue();

      await writer.finalize();

      // Should write to both project and user paths
      expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
    });

    it("should throw if not initialized", async () => {
      const writer = new LogWriter();

      await expect(writer.finalize()).rejects.toThrow(
        "LogWriter not initialized",
      );
    });

    it("should return correct log path", async () => {
      const writer = new LogWriter({ logPath: "/test/logs" });
      await writer.initialize(mockConfig);

      const logPath = await writer.finalize();

      expect(logPath).toMatch(/^\/test\/logs\/run-\d{4}-\d{2}-\d{2}T.*\.json$/);
    });

    it("should create directory if it does not exist when writing", async () => {
      const writer = new LogWriter({ logPath: "/new/path" });
      (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
        (p: string) => {
          // Directory exists during initialize but not during write
          return !p.includes("/new/path");
        },
      );

      await writer.initialize(mockConfig);
      await writer.finalize();

      expect(fs.mkdirSync).toHaveBeenCalled();
    });

    it("should include summary statistics in finalized log", async () => {
      const writer = new LogWriter({ logPath: "/test/logs" });
      await writer.initialize(mockConfig);

      // Add a successful issue
      writer.startIssue(123, "Success", []);
      writer.logPhase(mockPhaseLog);
      writer.completeIssue();

      // Add a failed issue
      writer.startIssue(456, "Failure", []);
      writer.logPhase({ ...mockPhaseLog, status: "failure" });
      writer.completeIssue();

      await writer.finalize();

      const writeCall = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock
        .calls[0];
      const writtenLog = JSON.parse(writeCall[1] as string);

      expect(writtenLog.summary.totalIssues).toBe(2);
      expect(writtenLog.summary.passed).toBe(1);
      expect(writtenLog.summary.failed).toBe(1);
    });

    it("should log to console in verbose mode", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const writer = new LogWriter({ verbose: true, logPath: "/test/logs" });
      await writer.initialize(mockConfig);

      await writer.finalize();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Log written:"),
      );
      consoleSpy.mockRestore();
    });
  });

  describe("getRunLog", () => {
    it("should return null before initialization", () => {
      const writer = new LogWriter();
      expect(writer.getRunLog()).toBeNull();
    });

    it("should return run log after initialization", async () => {
      const writer = new LogWriter();
      await writer.initialize(mockConfig);

      const runLog = writer.getRunLog();
      expect(runLog).not.toBeNull();
      expect(runLog!.config).toEqual(mockConfig);
    });
  });

  describe("getRunId", () => {
    it("should return null before initialization", () => {
      const writer = new LogWriter();
      expect(writer.getRunId()).toBeNull();
    });

    it("should return run ID after initialization", async () => {
      const writer = new LogWriter();
      await writer.initialize(mockConfig);

      expect(writer.getRunId()).toBe(mockUUID);
    });
  });
});

describe("createPhaseLogFromTiming", () => {
  it("should create phase log from start and end times", () => {
    const startTime = new Date("2024-01-15T10:00:00.000Z");
    const endTime = new Date("2024-01-15T10:02:30.000Z");

    const log = createPhaseLogFromTiming(
      "spec",
      123,
      startTime,
      endTime,
      "success",
    );

    expect(log).toEqual({
      phase: "spec",
      issueNumber: 123,
      startTime: "2024-01-15T10:00:00.000Z",
      endTime: "2024-01-15T10:02:30.000Z",
      durationSeconds: 150,
      status: "success",
    });
  });

  it("should include optional fields when provided", () => {
    const startTime = new Date("2024-01-15T10:00:00.000Z");
    const endTime = new Date("2024-01-15T10:01:00.000Z");

    const log = createPhaseLogFromTiming(
      "exec",
      456,
      startTime,
      endTime,
      "failure",
      {
        error: "Build failed",
        filesModified: ["src/index.ts", "src/utils.ts"],
      },
    );

    expect(log.error).toBe("Build failed");
    expect(log.filesModified).toEqual(["src/index.ts", "src/utils.ts"]);
  });

  it("should calculate correct duration for sub-second intervals", () => {
    const startTime = new Date("2024-01-15T10:00:00.000Z");
    const endTime = new Date("2024-01-15T10:00:00.500Z");

    const log = createPhaseLogFromTiming(
      "qa",
      789,
      startTime,
      endTime,
      "success",
    );

    expect(log.durationSeconds).toBe(0.5);
  });

  it("should support all phase types", () => {
    const startTime = new Date("2024-01-15T10:00:00.000Z");
    const endTime = new Date("2024-01-15T10:01:00.000Z");

    const phases = ["spec", "testgen", "exec", "test", "qa", "loop"] as const;

    for (const phase of phases) {
      const log = createPhaseLogFromTiming(
        phase,
        123,
        startTime,
        endTime,
        "success",
      );
      expect(log.phase).toBe(phase);
    }
  });

  it("should support all status types", () => {
    const startTime = new Date("2024-01-15T10:00:00.000Z");
    const endTime = new Date("2024-01-15T10:01:00.000Z");

    const statuses = ["success", "failure", "timeout", "skipped"] as const;

    for (const status of statuses) {
      const log = createPhaseLogFromTiming(
        "spec",
        123,
        startTime,
        endTime,
        status,
      );
      expect(log.status).toBe(status);
    }
  });

  it("should include test metrics when provided", () => {
    const startTime = new Date("2024-01-15T10:00:00.000Z");
    const endTime = new Date("2024-01-15T10:05:00.000Z");

    const log = createPhaseLogFromTiming(
      "test",
      123,
      startTime,
      endTime,
      "success",
      {
        testsRun: 50,
        testsPassed: 48,
      },
    );

    expect(log.testsRun).toBe(50);
    expect(log.testsPassed).toBe(48);
  });

  it("should include iteration count for loop phase", () => {
    const startTime = new Date("2024-01-15T10:00:00.000Z");
    const endTime = new Date("2024-01-15T10:10:00.000Z");

    const log = createPhaseLogFromTiming(
      "loop",
      123,
      startTime,
      endTime,
      "success",
      {
        iterations: 3,
      },
    );

    expect(log.iterations).toBe(3);
  });
});
