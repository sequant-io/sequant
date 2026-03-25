// Tests for Issue #404
// Default execution mode is serial despite being labeled parallel

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { DEFAULT_CONFIG, ExecutionConfig } from "../src/lib/workflow/types.js";
import {
  LogWriter,
  createPhaseLogFromTiming,
} from "../src/lib/workflow/log-writer.js";
import * as fs from "fs";

describe("Parallel Execution", () => {
  describe("AC-2: Concurrency limit configurable", () => {
    it("should default concurrency to 3", () => {
      expect(DEFAULT_CONFIG.concurrency).toBe(3);
    });

    it("should accept concurrency in ExecutionConfig", () => {
      const config: ExecutionConfig = {
        ...DEFAULT_CONFIG,
        concurrency: 5,
      };
      expect(config.concurrency).toBe(5);
    });

    it("should propagate concurrency to ExecutionConfig", () => {
      const config: ExecutionConfig = {
        ...DEFAULT_CONFIG,
        concurrency: 2,
      };
      expect(config.concurrency).toBe(2);
    });

    describe("error handling", () => {
      it("should have concurrency as a positive integer in DEFAULT_CONFIG", () => {
        expect(DEFAULT_CONFIG.concurrency).toBeGreaterThan(0);
        expect(Number.isInteger(DEFAULT_CONFIG.concurrency)).toBe(true);
      });
    });
  });

  describe("AC-8: Log writer concurrent handling", () => {
    let logWriter: LogWriter;
    const logDir = `/tmp/sequant-test-logwriter-${process.pid}-${Date.now()}`;

    beforeEach(async () => {
      logWriter = new LogWriter({ logPath: logDir });
      await logWriter.initialize({
        phases: ["exec", "qa"],
        sequential: false,
        qualityLoop: false,
        maxIterations: 1,
      });
    });

    afterAll(() => {
      fs.rmSync(logDir, { recursive: true, force: true });
    });

    it("should track multiple issues simultaneously via Map", () => {
      logWriter.startIssue(100, "Issue 100", ["bug"]);
      logWriter.startIssue(101, "Issue 101", ["feature"]);
      logWriter.startIssue(102, "Issue 102", ["enhancement"]);

      // All 3 issues can receive phases independently
      const phase100 = createPhaseLogFromTiming(
        "exec",
        100,
        new Date(),
        new Date(),
        "success",
      );
      const phase101 = createPhaseLogFromTiming(
        "exec",
        101,
        new Date(),
        new Date(),
        "success",
      );
      const phase102 = createPhaseLogFromTiming(
        "exec",
        102,
        new Date(),
        new Date(),
        "failure",
      );

      // No errors thrown
      logWriter.logPhase(phase100);
      logWriter.logPhase(phase101);
      logWriter.logPhase(phase102);
    });

    it("should log phases to the correct issue", async () => {
      logWriter.startIssue(100, "Issue 100", []);
      logWriter.startIssue(101, "Issue 101", []);

      const phase101 = createPhaseLogFromTiming(
        "exec",
        101,
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-01-01T00:01:00Z"),
        "success",
      );
      logWriter.logPhase(phase101);

      logWriter.completeIssue(100);
      logWriter.completeIssue(101);

      const logPath = await logWriter.finalize();
      const log = JSON.parse(fs.readFileSync(logPath, "utf-8"));

      // Issue 101 should have the phase, issue 100 should not
      const issue100 = log.issues.find(
        (i: { issueNumber: number }) => i.issueNumber === 100,
      );
      const issue101 = log.issues.find(
        (i: { issueNumber: number }) => i.issueNumber === 101,
      );

      expect(issue100.phases).toHaveLength(0);
      expect(issue101.phases).toHaveLength(1);
      expect(issue101.phases[0].phase).toBe("exec");
    });

    it("should setPRInfo for a specific issue", async () => {
      logWriter.startIssue(100, "Issue 100", []);
      logWriter.startIssue(101, "Issue 101", []);

      logWriter.setPRInfo(42, "https://github.com/test/42", 100);

      logWriter.completeIssue(100);
      logWriter.completeIssue(101);

      const logPath = await logWriter.finalize();
      const log = JSON.parse(fs.readFileSync(logPath, "utf-8"));

      const issue100 = log.issues.find(
        (i: { issueNumber: number }) => i.issueNumber === 100,
      );
      const issue101 = log.issues.find(
        (i: { issueNumber: number }) => i.issueNumber === 101,
      );

      expect(issue100.prNumber).toBe(42);
      expect(issue101.prNumber).toBeUndefined();
    });

    it("should completeIssue for a specific issue without affecting others", async () => {
      logWriter.startIssue(100, "Issue 100", []);
      logWriter.startIssue(101, "Issue 101", []);
      logWriter.startIssue(102, "Issue 102", []);

      // Complete only 101
      logWriter.completeIssue(101);

      // 100 and 102 should still be able to receive phases
      const phase100 = createPhaseLogFromTiming(
        "qa",
        100,
        new Date(),
        new Date(),
        "success",
      );
      logWriter.logPhase(phase100);

      // Complete remaining
      logWriter.completeIssue(100);
      logWriter.completeIssue(102);

      const logPath = await logWriter.finalize();
      const log = JSON.parse(fs.readFileSync(logPath, "utf-8"));

      expect(log.issues).toHaveLength(3);
      const issue100 = log.issues.find(
        (i: { issueNumber: number }) => i.issueNumber === 100,
      );
      expect(issue100.phases).toHaveLength(1);
    });

    it("should produce valid JSON log with all concurrent issues after finalize", async () => {
      logWriter.startIssue(100, "Issue 100", ["bug"]);
      logWriter.startIssue(101, "Issue 101", ["feature"]);
      logWriter.startIssue(102, "Issue 102", []);

      // Log phases to each
      for (const num of [100, 101, 102]) {
        const phase = createPhaseLogFromTiming(
          "exec",
          num,
          new Date(),
          new Date(),
          num === 101 ? "failure" : "success",
        );
        logWriter.logPhase(phase);
      }

      logWriter.completeIssue(100);
      logWriter.completeIssue(101);
      logWriter.completeIssue(102);

      const logPath = await logWriter.finalize();
      const log = JSON.parse(fs.readFileSync(logPath, "utf-8"));

      expect(log.issues).toHaveLength(3);
      expect(log.issues[0].issueNumber).toBe(100);
      expect(log.issues[1].issueNumber).toBe(101);
      expect(log.issues[2].issueNumber).toBe(102);

      // Issue 101 failed
      expect(log.issues[1].status).toBe("failure");
      // Others succeeded
      expect(log.issues[0].status).toBe("success");
      expect(log.issues[2].status).toBe("success");
    });

    describe("error handling", () => {
      it("should throw when logging phase for unknown issue", () => {
        const phase = createPhaseLogFromTiming(
          "exec",
          999,
          new Date(),
          new Date(),
          "success",
        );
        // No issue started with number 999, and no currentIssue either
        expect(() => logWriter.logPhase(phase)).toThrow(/No active issue/);
      });

      it("should throw when completing a non-existent issue number", () => {
        expect(() => logWriter.completeIssue(999)).toThrow(
          /No active issue #999/,
        );
      });
    });
  });

  describe("AC-10: Remove unused forceParallel from ExecutionConfig", () => {
    it("should not have forceParallel in DEFAULT_CONFIG", () => {
      expect(DEFAULT_CONFIG).not.toHaveProperty("forceParallel");
    });

    it("should have concurrency in DEFAULT_CONFIG instead", () => {
      expect(DEFAULT_CONFIG).toHaveProperty("concurrency");
      expect(DEFAULT_CONFIG.concurrency).toBe(3);
    });
  });

  describe("AC-3: Output isolation — parallel flag in config", () => {
    it("should default parallel to false in DEFAULT_CONFIG", () => {
      expect(DEFAULT_CONFIG.parallel).toBe(false);
    });

    it("should accept parallel flag in ExecutionConfig", () => {
      const config: ExecutionConfig = {
        ...DEFAULT_CONFIG,
        parallel: true,
      };
      expect(config.parallel).toBe(true);
    });
  });
});
