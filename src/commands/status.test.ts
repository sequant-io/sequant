/**
 * Tests for status command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { statusCommand } from "./status.js";
import { StateManager } from "../lib/workflow/state-manager.js";
import {
  createIssueState,
  type WorkflowState,
} from "../lib/workflow/state-schema.js";
import type { RunLog } from "../lib/workflow/run-log-schema.js";

// Mock console.log to capture output
const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

describe("status command", () => {
  let tempDir: string;
  let originalCwd: string;
  let logPath: string;
  let statePath: string;

  beforeEach(() => {
    mockConsoleLog.mockClear();
    // Create temp directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "status-test-"));
    logPath = path.join(tempDir, ".sequant", "logs");
    statePath = path.join(tempDir, ".sequant", "state.json");
    // Create .sequant directory structure
    fs.mkdirSync(logPath, { recursive: true });
    // Save original cwd and change to temp dir
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    // Restore original cwd
    process.chdir(originalCwd);
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("--rebuild flag", () => {
    it("should rebuild state from logs with empty directory", async () => {
      await statusCommand({ rebuild: true });

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Rebuilding state from logs");
      expect(output).toContain("State rebuilt successfully");
      expect(output).toContain("Logs processed: 0");
      expect(output).toContain("Issues found: 0");
    });

    it("should rebuild state from actual log files", async () => {
      // Create a realistic run log
      const runLog: RunLog = {
        version: 1,
        runId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        config: {
          phases: ["spec", "exec", "qa"],
          sequential: true,
          qualityLoop: false,
          maxIterations: 3,
        },
        issues: [
          {
            issueNumber: 42,
            title: "Add feature X",
            labels: ["enhancement"],
            status: "success",
            phases: [
              {
                phase: "spec",
                issueNumber: 42,
                startTime: new Date().toISOString(),
                endTime: new Date().toISOString(),
                durationSeconds: 120,
                status: "success",
              },
              {
                phase: "exec",
                issueNumber: 42,
                startTime: new Date().toISOString(),
                endTime: new Date().toISOString(),
                durationSeconds: 600,
                status: "success",
              },
            ],
            totalDurationSeconds: 720,
          },
        ],
        summary: {
          totalIssues: 1,
          passed: 1,
          failed: 0,
          totalDurationSeconds: 720,
        },
      };

      // Write the log file
      fs.writeFileSync(
        path.join(logPath, "run-2026-01-15T10-00-00-test-run.json"),
        JSON.stringify(runLog),
      );

      await statusCommand({ rebuild: true });

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Logs processed: 1");
      expect(output).toContain("Issues found: 1");

      // Verify state was actually written
      expect(fs.existsSync(statePath)).toBe(true);
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(state.issues["42"]).toBeDefined();
      expect(state.issues["42"].title).toBe("Add feature X");
    });

    it("should return JSON with actual data when --json is used", async () => {
      // Create a log file with valid UUID format
      const runLog: RunLog = {
        version: 1,
        runId: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        config: {
          phases: ["exec"],
          sequential: true,
          qualityLoop: false,
          maxIterations: 3,
        },
        issues: [
          {
            issueNumber: 100,
            title: "Test Issue",
            labels: [],
            status: "success",
            phases: [
              {
                phase: "exec",
                issueNumber: 100,
                startTime: new Date().toISOString(),
                endTime: new Date().toISOString(),
                durationSeconds: 60,
                status: "success",
              },
            ],
            totalDurationSeconds: 60,
          },
        ],
        summary: {
          totalIssues: 1,
          passed: 1,
          failed: 0,
          totalDurationSeconds: 60,
        },
      };

      fs.writeFileSync(
        path.join(logPath, "run-2026-01-15T12-00-00-json-test.json"),
        JSON.stringify(runLog),
      );

      await statusCommand({ rebuild: true, json: true });

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join("\n");
      const result = JSON.parse(output);
      expect(result.success).toBe(true);
      expect(result.logsProcessed).toBe(1);
      expect(result.issuesFound).toBe(1);
    });
  });

  describe("--cleanup flag", () => {
    it("should report no stale entries when state is clean", async () => {
      // Create state with a valid issue (no worktree = nothing to check)
      const manager = new StateManager({ statePath });
      await manager.initializeIssue(42, "Active Issue");

      await statusCommand({ cleanup: true });

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Cleaning up stale entries");
      expect(output).toContain("No stale entries found");
    });

    it("should identify orphaned entries with missing worktrees", async () => {
      // Create state with an issue pointing to a non-existent worktree
      const manager = new StateManager({ statePath });
      await manager.initializeIssue(42, "Orphaned Issue", {
        worktree: "/nonexistent/worktree/path",
        branch: "feature/42-orphaned",
      });

      await statusCommand({ cleanup: true, dryRun: true });

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("dry run");
      expect(output).toContain("Orphaned");
      expect(output).toContain("#42");
    });

    it("should remove old merged issues with --max-age", async () => {
      // Create state with an old merged issue
      const state: WorkflowState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        issues: {
          "99": {
            ...createIssueState(99, "Old Merged Issue"),
            status: "merged",
            lastActivity: new Date(
              Date.now() - 60 * 24 * 60 * 60 * 1000,
            ).toISOString(), // 60 days ago
          },
        },
      };

      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state));

      await statusCommand({ cleanup: true, maxAge: 30, dryRun: true });

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Removed");
      expect(output).toContain("#99");
    });

    it("should return JSON with cleanup results", async () => {
      // Create state with an orphaned issue
      const manager = new StateManager({ statePath });
      await manager.initializeIssue(50, "Orphaned for JSON", {
        worktree: "/does/not/exist",
        branch: "feature/50-test",
      });

      await statusCommand({ cleanup: true, json: true, dryRun: true });

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join("\n");
      const result = JSON.parse(output);
      expect(result.success).toBe(true);
      expect(result.orphaned).toContain(50);
    });

    it("should actually remove entries when not in dry-run mode", async () => {
      // Create state with an orphaned issue
      const manager = new StateManager({ statePath });
      await manager.initializeIssue(42, "Will Be Abandoned", {
        worktree: "/nonexistent/path",
        branch: "feature/42-test",
      });

      // Verify issue exists before cleanup
      let state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(state.issues["42"]).toBeDefined();

      await statusCommand({ cleanup: true });

      // Verify issue was marked as abandoned
      state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(state.issues["42"].status).toBe("abandoned");
    });
  });
});
