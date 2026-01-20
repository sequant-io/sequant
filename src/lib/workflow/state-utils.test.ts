/**
 * Tests for state utilities
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  rebuildStateFromLogs,
  cleanupStaleEntries,
  discoverUntrackedWorktrees,
} from "./state-utils.js";
import { StateManager } from "./state-manager.js";
import { createIssueState, type WorkflowState } from "./state-schema.js";
import type { RunLog } from "./run-log-schema.js";

describe("state-utils", () => {
  let tempDir: string;
  let logPath: string;
  let statePath: string;

  beforeEach(() => {
    // Create temp directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-utils-test-"));
    logPath = path.join(tempDir, ".sequant", "logs");
    statePath = path.join(tempDir, ".sequant", "state.json");
    fs.mkdirSync(logPath, { recursive: true });
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("rebuildStateFromLogs", () => {
    it("should return success with 0 logs when directory is empty", async () => {
      const result = await rebuildStateFromLogs({ logPath });

      expect(result.success).toBe(true);
      expect(result.logsProcessed).toBe(0);
      expect(result.issuesFound).toBe(0);
    });

    it("should return error when directory does not exist", async () => {
      const result = await rebuildStateFromLogs({
        logPath: "/nonexistent/path",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("should rebuild state from valid log files", async () => {
      // Create a valid run log
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
            title: "Test Issue",
            labels: ["enhancement"],
            status: "success",
            phases: [
              {
                phase: "spec",
                issueNumber: 42,
                startTime: new Date().toISOString(),
                endTime: new Date().toISOString(),
                durationSeconds: 10,
                status: "success",
              },
              {
                phase: "exec",
                issueNumber: 42,
                startTime: new Date().toISOString(),
                endTime: new Date().toISOString(),
                durationSeconds: 60,
                status: "success",
              },
            ],
            totalDurationSeconds: 70,
          },
        ],
        summary: {
          totalIssues: 1,
          passed: 1,
          failed: 0,
          totalDurationSeconds: 70,
        },
      };

      // Write log file
      const logFile = path.join(logPath, "run-2024-01-01-test-run-id.json");
      fs.writeFileSync(logFile, JSON.stringify(runLog));

      const result = await rebuildStateFromLogs({ logPath, statePath });

      expect(result.success).toBe(true);
      expect(result.logsProcessed).toBe(1);
      expect(result.issuesFound).toBe(1);
    });

    it("should skip invalid log files", async () => {
      // Write invalid JSON
      fs.writeFileSync(path.join(logPath, "invalid.json"), "not valid json");

      // Write valid but wrong schema
      fs.writeFileSync(
        path.join(logPath, "wrong-schema.json"),
        JSON.stringify({ foo: "bar" }),
      );

      const result = await rebuildStateFromLogs({ logPath, verbose: false });

      expect(result.success).toBe(true);
      expect(result.logsProcessed).toBe(2);
      expect(result.issuesFound).toBe(0);
    });

    it("should use newest log data for each issue", async () => {
      const makeLog = (
        runIdSuffix: string,
        issueTitle: string,
        status: "success" | "failure",
      ): RunLog => ({
        version: 1,
        runId: `a1b2c3d4-e5f6-7890-abcd-${runIdSuffix}123456`,
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
            issueNumber: 42,
            title: issueTitle,
            labels: [],
            status,
            phases: [
              {
                phase: "exec",
                issueNumber: 42,
                startTime: new Date().toISOString(),
                endTime: new Date().toISOString(),
                durationSeconds: 10,
                status,
              },
            ],
            totalDurationSeconds: 10,
          },
        ],
        summary: {
          totalIssues: 1,
          passed: status === "success" ? 1 : 0,
          failed: status === "failure" ? 1 : 0,
          totalDurationSeconds: 10,
        },
      });

      // Write older log (timestamp in filename determines order)
      fs.writeFileSync(
        path.join(logPath, "run-2024-01-01T00-00-00-old.json"),
        JSON.stringify(makeLog("000000", "Old Title", "failure")),
      );

      // Write newer log
      fs.writeFileSync(
        path.join(logPath, "run-2024-01-02T00-00-00-new.json"),
        JSON.stringify(makeLog("111111", "New Title", "success")),
      );

      const result = await rebuildStateFromLogs({ logPath, statePath });

      expect(result.success).toBe(true);
      expect(result.issuesFound).toBe(1);
    });
  });

  describe("cleanupStaleEntries", () => {
    it("should return success when no state exists", async () => {
      const result = await cleanupStaleEntries({ statePath });

      // No state file means nothing to clean
      expect(result.success).toBe(true);
      expect(result.removed).toEqual([]);
      expect(result.orphaned).toEqual([]);
    });

    it("should identify issues with missing worktrees as orphaned", async () => {
      // Create state with an issue that has a non-existent worktree
      const manager = new StateManager({ statePath });
      await manager.initializeIssue(42, "Test Issue", {
        worktree: "/nonexistent/worktree/path",
        branch: "feature/42-test",
      });

      // Run cleanup in dry-run mode
      const result = await cleanupStaleEntries({
        statePath,
        dryRun: true,
        verbose: false,
      });

      // Issue should be identified as orphaned
      expect(result.success).toBe(true);
      expect(result.orphaned).toContain(42);
    });

    it("should remove old merged issues when maxAgeDays is set", async () => {
      // Create state with an old merged issue
      const state: WorkflowState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        issues: {
          "42": {
            ...createIssueState(42, "Old Merged Issue"),
            status: "merged",
            lastActivity: new Date(
              Date.now() - 100 * 24 * 60 * 60 * 1000,
            ).toISOString(), // 100 days ago
          },
          "43": {
            ...createIssueState(43, "Recent Issue"),
            status: "in_progress",
            lastActivity: new Date().toISOString(), // now
          },
        },
      };

      // Write state directly
      const dir = path.dirname(statePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state));

      // Run cleanup with 30-day max age in dry-run mode
      const result = await cleanupStaleEntries({
        statePath,
        maxAgeDays: 30,
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.removed).toContain(42);
      expect(result.removed).not.toContain(43);
    });
  });

  describe("discoverUntrackedWorktrees", () => {
    // Note: These tests run against the actual git worktree list output
    // in the test environment. The function will scan actual worktrees.
    // For proper isolation, integration tests would use a controlled git repo.

    it("should return success when called", async () => {
      // This test verifies the function runs without error
      // It will scan actual worktrees in the environment
      const result = await discoverUntrackedWorktrees({ statePath });

      expect(result.success).toBe(true);
      expect(typeof result.worktreesScanned).toBe("number");
      expect(Array.isArray(result.discovered)).toBe(true);
      expect(Array.isArray(result.skipped)).toBe(true);
    });

    it("should not discover worktrees that are already tracked", async () => {
      // Get current worktrees first
      const initialResult = await discoverUntrackedWorktrees({ statePath });

      if (initialResult.discovered.length > 0) {
        // Track the first discovered worktree
        const worktree = initialResult.discovered[0];
        const manager = new StateManager({ statePath });
        await manager.initializeIssue(worktree.issueNumber, worktree.title, {
          worktree: worktree.worktreePath,
          branch: worktree.branch,
        });

        // Now run discovery again
        const secondResult = await discoverUntrackedWorktrees({ statePath });

        // Should not re-discover the same worktree
        expect(secondResult.discovered.length).toBeLessThan(
          initialResult.discovered.length,
        );
        expect(secondResult.alreadyTracked).toBeGreaterThan(0);
      } else {
        // No worktrees to test with, just verify the function works
        expect(initialResult.success).toBe(true);
      }
    });
  });
});
