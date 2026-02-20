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
  checkPRMergeStatus,
  reconcileStateAtStartup,
  isBranchMergedIntoMain,
  isIssueMergedIntoMain,
} from "./state-utils.js";
import { StateManager } from "./state-manager.js";
import { createIssueState, type WorkflowState } from "./state-schema.js";
import type { RunLog } from "./run-log-schema.js";

// Mock child_process module for testing checkPRMergeStatus
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync),
  };
});

// Get mocked spawnSync for configuring in tests
import { spawnSync } from "child_process";
const mockSpawnSync = vi.mocked(spawnSync);

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

  describe("checkPRMergeStatus", () => {
    beforeEach(() => {
      mockSpawnSync.mockReset();
    });

    it("should return MERGED when gh returns merged state", () => {
      // Mock spawnSync to return merged state
      mockSpawnSync.mockReturnValueOnce({
        status: 0,
        stdout: Buffer.from("merged\n"),
        stderr: Buffer.from(""),
        pid: 0,
        output: [null, Buffer.from("merged\n"), Buffer.from("")],
        signal: null,
      });

      const result = checkPRMergeStatus(123);
      expect(result).toBe("MERGED");
    });

    it("should return CLOSED when gh returns closed state", () => {
      mockSpawnSync.mockReturnValueOnce({
        status: 0,
        stdout: Buffer.from("CLOSED\n"),
        stderr: Buffer.from(""),
        pid: 0,
        output: [null, Buffer.from("CLOSED\n"), Buffer.from("")],
        signal: null,
      });

      const result = checkPRMergeStatus(456);
      expect(result).toBe("CLOSED");
    });

    it("should return OPEN when gh returns open state", () => {
      mockSpawnSync.mockReturnValueOnce({
        status: 0,
        stdout: Buffer.from("open\n"),
        stderr: Buffer.from(""),
        pid: 0,
        output: [null, Buffer.from("open\n"), Buffer.from("")],
        signal: null,
      });

      const result = checkPRMergeStatus(789);
      expect(result).toBe("OPEN");
    });

    it("should return null when gh command fails", () => {
      mockSpawnSync.mockReturnValueOnce({
        status: 1,
        stdout: Buffer.from(""),
        stderr: Buffer.from("not found"),
        pid: 0,
        output: [null, Buffer.from(""), Buffer.from("not found")],
        signal: null,
      });

      const result = checkPRMergeStatus(999);
      expect(result).toBe(null);
    });

    it("should return null when gh throws an error", () => {
      mockSpawnSync.mockImplementationOnce(() => {
        throw new Error("gh not installed");
      });

      const result = checkPRMergeStatus(123);
      expect(result).toBe(null);
    });
  });

  describe("cleanupStaleEntries with PR detection", () => {
    beforeEach(() => {
      mockSpawnSync.mockReset();
    });

    it("should auto-remove orphaned entries with merged PRs", async () => {
      // Create state with an orphaned issue that has a PR
      const state: WorkflowState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        issues: {
          "42": {
            ...createIssueState(42, "Issue with merged PR"),
            worktree: "/nonexistent/worktree/path/that/does/not/exist",
            branch: "feature/42-test",
            pr: { number: 100, url: "https://github.com/test/repo/pull/100" },
          },
        },
      };
      fs.writeFileSync(statePath, JSON.stringify(state));

      // Mock gh to return merged status
      mockSpawnSync.mockImplementation((cmd, args) => {
        if (
          cmd === "gh" &&
          args?.includes("pr") &&
          args?.includes("view") &&
          args?.includes("100")
        ) {
          return {
            status: 0,
            stdout: Buffer.from("MERGED\n"),
            stderr: Buffer.from(""),
            pid: 0,
            output: [null, Buffer.from("MERGED\n"), Buffer.from("")],
            signal: null,
          };
        }
        // Mock git worktree list to return empty (no worktrees)
        if (cmd === "git" && args?.includes("worktree")) {
          return {
            status: 0,
            stdout: Buffer.from(""),
            stderr: Buffer.from(""),
            pid: 0,
            output: [null, Buffer.from(""), Buffer.from("")],
            signal: null,
          };
        }
        return {
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 0,
          output: [null, Buffer.from(""), Buffer.from("")],
          signal: null,
        };
      });

      const result = await cleanupStaleEntries({ statePath });

      expect(result.success).toBe(true);
      expect(result.merged).toContain(42);
      expect(result.removed).toContain(42);

      // Verify state was updated
      const updatedState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(updatedState.issues["42"]).toBeUndefined();
    });

    it("should mark orphaned entries without merged PRs as abandoned", async () => {
      // Create state with an orphaned issue that has an open PR
      const state: WorkflowState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        issues: {
          "43": {
            ...createIssueState(43, "Issue with open PR"),
            worktree: "/nonexistent/worktree/path/that/does/not/exist",
            branch: "feature/43-test",
            pr: { number: 101, url: "https://github.com/test/repo/pull/101" },
          },
        },
      };
      fs.writeFileSync(statePath, JSON.stringify(state));

      // Mock gh to return open status
      mockSpawnSync.mockImplementation((cmd, args) => {
        if (cmd === "gh" && args?.includes("pr") && args?.includes("101")) {
          return {
            status: 0,
            stdout: Buffer.from("OPEN\n"),
            stderr: Buffer.from(""),
            pid: 0,
            output: [null, Buffer.from("OPEN\n"), Buffer.from("")],
            signal: null,
          };
        }
        // Mock git worktree list to return empty
        if (cmd === "git" && args?.includes("worktree")) {
          return {
            status: 0,
            stdout: Buffer.from(""),
            stderr: Buffer.from(""),
            pid: 0,
            output: [null, Buffer.from(""), Buffer.from("")],
            signal: null,
          };
        }
        return {
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 0,
          output: [null, Buffer.from(""), Buffer.from("")],
          signal: null,
        };
      });

      const result = await cleanupStaleEntries({ statePath });

      expect(result.success).toBe(true);
      expect(result.orphaned).toContain(43);
      expect(result.merged).not.toContain(43);
      expect(result.removed).not.toContain(43);

      // Verify state was updated to abandoned
      const updatedState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(updatedState.issues["43"]).toBeDefined();
      expect(updatedState.issues["43"].status).toBe("abandoned");
    });

    it("should remove all orphaned entries with --removeAll flag", async () => {
      // Create state with multiple orphaned issues
      const state: WorkflowState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        issues: {
          "44": {
            ...createIssueState(44, "Abandoned issue 1"),
            worktree: "/nonexistent/worktree/path/that/does/not/exist",
            branch: "feature/44-test",
            status: "in_progress",
          },
          "45": {
            ...createIssueState(45, "Abandoned issue 2"),
            worktree: "/another/nonexistent/worktree/path",
            branch: "feature/45-test",
            status: "in_progress",
          },
        },
      };
      fs.writeFileSync(statePath, JSON.stringify(state));

      // Mock git worktree list to return empty
      mockSpawnSync.mockImplementation((cmd, args) => {
        if (cmd === "git" && args?.includes("worktree")) {
          return {
            status: 0,
            stdout: Buffer.from(""),
            stderr: Buffer.from(""),
            pid: 0,
            output: [null, Buffer.from(""), Buffer.from("")],
            signal: null,
          };
        }
        return {
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 0,
          output: [null, Buffer.from(""), Buffer.from("")],
          signal: null,
        };
      });

      const result = await cleanupStaleEntries({ statePath, removeAll: true });

      expect(result.success).toBe(true);
      expect(result.orphaned).toContain(44);
      expect(result.orphaned).toContain(45);
      expect(result.removed).toContain(44);
      expect(result.removed).toContain(45);

      // Verify state was cleared
      const updatedState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(updatedState.issues["44"]).toBeUndefined();
      expect(updatedState.issues["45"]).toBeUndefined();
    });

    it("should return merged array in result even for empty state", async () => {
      const result = await cleanupStaleEntries({ statePath });

      expect(result.success).toBe(true);
      expect(result.merged).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.orphaned).toEqual([]);
    });
  });

  // ============================================================================
  // Tests for #305: Pre-flight state guard and worktree lifecycle
  // ============================================================================

  describe("reconcileStateAtStartup (#305 AC-5)", () => {
    beforeEach(() => {
      mockSpawnSync.mockReset();
    });

    it("should return success when no state file exists", async () => {
      const result = await reconcileStateAtStartup({ statePath });

      expect(result.success).toBe(true);
      expect(result.advanced).toEqual([]);
      expect(result.stillPending).toEqual([]);
    });

    it("should advance ready_for_merge issues to merged when PR is merged", async () => {
      // Create state with a ready_for_merge issue that has a merged PR
      const state: WorkflowState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        issues: {
          "42": {
            ...createIssueState(42, "Issue with merged PR"),
            status: "ready_for_merge",
            pr: { number: 100, url: "https://github.com/test/repo/pull/100" },
          },
        },
      };
      fs.writeFileSync(statePath, JSON.stringify(state));

      // Mock gh to return merged status
      mockSpawnSync.mockImplementation((cmd, args) => {
        if (
          cmd === "gh" &&
          args?.includes("pr") &&
          args?.includes("view") &&
          args?.includes("100")
        ) {
          return {
            status: 0,
            stdout: Buffer.from("MERGED\n"),
            stderr: Buffer.from(""),
            pid: 0,
            output: [null, Buffer.from("MERGED\n"), Buffer.from("")],
            signal: null,
          };
        }
        return {
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 0,
          output: [null, Buffer.from(""), Buffer.from("")],
          signal: null,
        };
      });

      const result = await reconcileStateAtStartup({ statePath });

      expect(result.success).toBe(true);
      expect(result.advanced).toContain(42);
      expect(result.stillPending).not.toContain(42);

      // Verify state was updated
      const updatedState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(updatedState.issues["42"].status).toBe("merged");
    });

    it("should keep ready_for_merge issues pending when PR is still open", async () => {
      // Create state with a ready_for_merge issue with open PR
      const state: WorkflowState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        issues: {
          "43": {
            ...createIssueState(43, "Issue with open PR"),
            status: "ready_for_merge",
            pr: { number: 101, url: "https://github.com/test/repo/pull/101" },
          },
        },
      };
      fs.writeFileSync(statePath, JSON.stringify(state));

      // Mock gh to return open status
      mockSpawnSync.mockImplementation((cmd, args) => {
        if (cmd === "gh" && args?.includes("pr") && args?.includes("101")) {
          return {
            status: 0,
            stdout: Buffer.from("OPEN\n"),
            stderr: Buffer.from(""),
            pid: 0,
            output: [null, Buffer.from("OPEN\n"), Buffer.from("")],
            signal: null,
          };
        }
        // Mock git branch -a to return no matching branches
        if (cmd === "git" && args?.includes("branch") && args?.includes("-a")) {
          return {
            status: 0,
            stdout: Buffer.from("  main\n  origin/main\n"),
            stderr: Buffer.from(""),
            pid: 0,
            output: [
              null,
              Buffer.from("  main\n  origin/main\n"),
              Buffer.from(""),
            ],
            signal: null,
          };
        }
        // Mock git log to return no merge commits
        if (cmd === "git" && args?.includes("log")) {
          return {
            status: 0,
            stdout: Buffer.from(""),
            stderr: Buffer.from(""),
            pid: 0,
            output: [null, Buffer.from(""), Buffer.from("")],
            signal: null,
          };
        }
        return {
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 0,
          output: [null, Buffer.from(""), Buffer.from("")],
          signal: null,
        };
      });

      const result = await reconcileStateAtStartup({ statePath });

      expect(result.success).toBe(true);
      expect(result.advanced).not.toContain(43);
      expect(result.stillPending).toContain(43);

      // Verify state was NOT changed
      const updatedState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(updatedState.issues["43"].status).toBe("ready_for_merge");
    });

    it("should not affect issues with other statuses", async () => {
      // Create state with issues in various states
      const state: WorkflowState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        issues: {
          "44": {
            ...createIssueState(44, "In progress issue"),
            status: "in_progress",
          },
          "45": {
            ...createIssueState(45, "Not started issue"),
            status: "not_started",
          },
          "46": {
            ...createIssueState(46, "Already merged issue"),
            status: "merged",
          },
        },
      };
      fs.writeFileSync(statePath, JSON.stringify(state));

      const result = await reconcileStateAtStartup({ statePath });

      expect(result.success).toBe(true);
      expect(result.advanced).toEqual([]);
      expect(result.stillPending).toEqual([]);

      // Verify states were not changed
      const updatedState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(updatedState.issues["44"].status).toBe("in_progress");
      expect(updatedState.issues["45"].status).toBe("not_started");
      expect(updatedState.issues["46"].status).toBe("merged");
    });

    it("should detect merged issues via git branch check when no PR info (#305)", async () => {
      // Create state with ready_for_merge issue WITHOUT PR info
      const state: WorkflowState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        issues: {
          "47": {
            ...createIssueState(47, "Issue merged directly"),
            status: "ready_for_merge",
            branch: "feature/47-some-feature",
            // No PR info - was merged directly
          },
        },
      };
      fs.writeFileSync(statePath, JSON.stringify(state));

      // Mock git commands to show branch is merged
      mockSpawnSync.mockImplementation((cmd, args) => {
        // Mock git branch -a to return the feature branch
        if (cmd === "git" && args?.includes("branch") && args?.includes("-a")) {
          return {
            status: 0,
            stdout: Buffer.from(
              "  main\n  feature/47-some-feature\n  origin/main\n",
            ),
            stderr: Buffer.from(""),
            pid: 0,
            output: [
              null,
              Buffer.from("  main\n  feature/47-some-feature\n  origin/main\n"),
              Buffer.from(""),
            ],
            signal: null,
          };
        }
        // Mock git branch --merged main to show our branch is merged
        if (
          cmd === "git" &&
          args?.includes("--merged") &&
          args?.includes("main")
        ) {
          return {
            status: 0,
            stdout: Buffer.from("  main\n  feature/47-some-feature\n"),
            stderr: Buffer.from(""),
            pid: 0,
            output: [
              null,
              Buffer.from("  main\n  feature/47-some-feature\n"),
              Buffer.from(""),
            ],
            signal: null,
          };
        }
        return {
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 0,
          output: [null, Buffer.from(""), Buffer.from("")],
          signal: null,
        };
      });

      const result = await reconcileStateAtStartup({ statePath });

      expect(result.success).toBe(true);
      expect(result.advanced).toContain(47);

      // Verify state was updated
      const updatedState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(updatedState.issues["47"].status).toBe("merged");
    });
  });

  describe("isBranchMergedIntoMain (#305)", () => {
    beforeEach(() => {
      mockSpawnSync.mockReset();
    });

    it("should return true when branch is in git branch --merged main output", () => {
      mockSpawnSync.mockReturnValueOnce({
        status: 0,
        stdout: Buffer.from("  main\n  feature/123-test\n"),
        stderr: Buffer.from(""),
        pid: 0,
        output: [
          null,
          Buffer.from("  main\n  feature/123-test\n"),
          Buffer.from(""),
        ],
        signal: null,
      });

      expect(isBranchMergedIntoMain("feature/123-test")).toBe(true);
    });

    it("should return false when branch is not in merged output", () => {
      mockSpawnSync.mockReturnValueOnce({
        status: 0,
        stdout: Buffer.from("  main\n"),
        stderr: Buffer.from(""),
        pid: 0,
        output: [null, Buffer.from("  main\n"), Buffer.from("")],
        signal: null,
      });

      expect(isBranchMergedIntoMain("feature/456-other")).toBe(false);
    });

    it("should return false when git command fails", () => {
      mockSpawnSync.mockReturnValueOnce({
        status: 1,
        stdout: Buffer.from(""),
        stderr: Buffer.from("error"),
        pid: 0,
        output: [null, Buffer.from(""), Buffer.from("error")],
        signal: null,
      });

      expect(isBranchMergedIntoMain("feature/789-branch")).toBe(false);
    });
  });

  describe("isIssueMergedIntoMain (#305)", () => {
    beforeEach(() => {
      mockSpawnSync.mockReset();
    });

    it("should return true when feature branch is merged", () => {
      mockSpawnSync.mockImplementation((cmd, args) => {
        // First call: git branch -a
        if (args?.includes("-a")) {
          return {
            status: 0,
            stdout: Buffer.from("  main\n  feature/50-test-feature\n"),
            stderr: Buffer.from(""),
            pid: 0,
            output: [
              null,
              Buffer.from("  main\n  feature/50-test-feature\n"),
              Buffer.from(""),
            ],
            signal: null,
          };
        }
        // Second call: git branch --merged main
        if (args?.includes("--merged")) {
          return {
            status: 0,
            stdout: Buffer.from("  main\n  feature/50-test-feature\n"),
            stderr: Buffer.from(""),
            pid: 0,
            output: [
              null,
              Buffer.from("  main\n  feature/50-test-feature\n"),
              Buffer.from(""),
            ],
            signal: null,
          };
        }
        return {
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 0,
          output: [null, Buffer.from(""), Buffer.from("")],
          signal: null,
        };
      });

      expect(isIssueMergedIntoMain(50)).toBe(true);
    });

    it("should return false when no feature branch exists for issue", () => {
      mockSpawnSync.mockImplementation((cmd, args) => {
        if (args?.includes("-a")) {
          return {
            status: 0,
            stdout: Buffer.from("  main\n  feature/99-other\n"),
            stderr: Buffer.from(""),
            pid: 0,
            output: [
              null,
              Buffer.from("  main\n  feature/99-other\n"),
              Buffer.from(""),
            ],
            signal: null,
          };
        }
        if (args?.includes("log")) {
          return {
            status: 0,
            stdout: Buffer.from(""),
            stderr: Buffer.from(""),
            pid: 0,
            output: [null, Buffer.from(""), Buffer.from("")],
            signal: null,
          };
        }
        return {
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 0,
          output: [null, Buffer.from(""), Buffer.from("")],
          signal: null,
        };
      });

      expect(isIssueMergedIntoMain(51)).toBe(false);
    });
  });
});
