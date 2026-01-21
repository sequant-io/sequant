/**
 * Tests for StateManager
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { StateManager, resetStateManager } from "./state-manager.js";
import {
  createEmptyState,
  createIssueState,
  createAcceptanceCriterion,
  createAcceptanceCriteria,
  type WorkflowState,
} from "./state-schema.js";

describe("StateManager", () => {
  let tempDir: string;
  let statePath: string;
  let manager: StateManager;

  beforeEach(() => {
    // Create temp directory for test state files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-test-"));
    statePath = path.join(tempDir, ".sequant", "state.json");
    manager = new StateManager({ statePath });
    resetStateManager();
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("getState", () => {
    it("should return empty state when file does not exist", async () => {
      const state = await manager.getState();

      expect(state.version).toBe(1);
      expect(state.issues).toEqual({});
    });

    it("should read and parse existing state file", async () => {
      // Create state file
      const existingState: WorkflowState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        issues: {
          "42": createIssueState(42, "Test Issue"),
        },
      };

      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(existingState));

      const state = await manager.getState();

      expect(state.issues["42"]).toBeDefined();
      expect(state.issues["42"].number).toBe(42);
      expect(state.issues["42"].title).toBe("Test Issue");
    });

    it("should cache state after first read", async () => {
      const state1 = await manager.getState();
      const state2 = await manager.getState();

      expect(state1).toBe(state2); // Same object reference
    });

    it("should throw on invalid JSON", async () => {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, "not valid json");

      await expect(manager.getState()).rejects.toThrow("Invalid JSON");
    });
  });

  describe("saveState", () => {
    it("should create directory and write state file", async () => {
      const state = createEmptyState();
      state.issues["42"] = createIssueState(42, "Test Issue");

      await manager.saveState(state);

      expect(fs.existsSync(statePath)).toBe(true);

      const savedContent = fs.readFileSync(statePath, "utf-8");
      const savedState = JSON.parse(savedContent);
      expect(savedState.issues["42"].number).toBe(42);
    });

    it("should update lastUpdated timestamp", async () => {
      const state = createEmptyState();
      const originalTime = state.lastUpdated;

      // Wait a bit to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10));

      await manager.saveState(state);

      const savedContent = fs.readFileSync(statePath, "utf-8");
      const savedState = JSON.parse(savedContent);
      expect(savedState.lastUpdated).not.toBe(originalTime);
    });

    it("should use atomic write (temp file + rename)", async () => {
      // This test verifies the atomic write behavior indirectly
      // by checking that concurrent writes don't corrupt the file
      const state = createEmptyState();

      // Write multiple times rapidly (start from 1 since issue numbers must be positive)
      const promises = Array.from({ length: 5 }, (_, i) => {
        const s = { ...state };
        const issueNum = i + 1;
        s.issues[String(issueNum)] = createIssueState(
          issueNum,
          `Issue ${issueNum}`,
        );
        return manager.saveState(s);
      });

      await Promise.all(promises);

      // File should be valid JSON
      const savedContent = fs.readFileSync(statePath, "utf-8");
      expect(() => JSON.parse(savedContent)).not.toThrow();
    });
  });

  describe("initializeIssue", () => {
    it("should create new issue in state", async () => {
      await manager.initializeIssue(42, "Test Issue");

      const state = await manager.getState();
      expect(state.issues["42"]).toBeDefined();
      expect(state.issues["42"].number).toBe(42);
      expect(state.issues["42"].title).toBe("Test Issue");
      expect(state.issues["42"].status).toBe("not_started");
    });

    it("should set worktree and branch if provided", async () => {
      await manager.initializeIssue(42, "Test Issue", {
        worktree: "/path/to/worktree",
        branch: "feature/42-test",
      });

      const state = await manager.getState();
      expect(state.issues["42"].worktree).toBe("/path/to/worktree");
      expect(state.issues["42"].branch).toBe("feature/42-test");
    });

    it("should set quality loop if enabled", async () => {
      await manager.initializeIssue(42, "Test Issue", {
        qualityLoop: true,
        maxIterations: 5,
      });

      const state = await manager.getState();
      expect(state.issues["42"].loop).toBeDefined();
      expect(state.issues["42"].loop?.enabled).toBe(true);
      expect(state.issues["42"].loop?.maxIterations).toBe(5);
    });
  });

  describe("updatePhaseStatus", () => {
    beforeEach(async () => {
      await manager.initializeIssue(42, "Test Issue");
    });

    it("should update phase status", async () => {
      await manager.updatePhaseStatus(42, "spec", "in_progress");

      const state = await manager.getState();
      expect(state.issues["42"].phases["spec"]).toBeDefined();
      expect(state.issues["42"].phases["spec"]?.status).toBe("in_progress");
      expect(state.issues["42"].currentPhase).toBe("spec");
    });

    it("should set startedAt when status is in_progress", async () => {
      await manager.updatePhaseStatus(42, "spec", "in_progress");

      const state = await manager.getState();
      expect(state.issues["42"].phases["spec"]?.startedAt).toBeDefined();
    });

    it("should set completedAt when status is completed", async () => {
      await manager.updatePhaseStatus(42, "spec", "in_progress");
      await manager.updatePhaseStatus(42, "spec", "completed");

      const state = await manager.getState();
      expect(state.issues["42"].phases["spec"]?.completedAt).toBeDefined();
    });

    it("should preserve startedAt when updating to completed", async () => {
      await manager.updatePhaseStatus(42, "spec", "in_progress");
      const state1 = await manager.getState();
      const startedAt = state1.issues["42"].phases["spec"]?.startedAt;

      await manager.updatePhaseStatus(42, "spec", "completed");
      const state2 = await manager.getState();
      expect(state2.issues["42"].phases["spec"]?.startedAt).toBe(startedAt);
    });

    it("should include error when phase fails", async () => {
      await manager.updatePhaseStatus(42, "spec", "failed", {
        error: "Something went wrong",
      });

      const state = await manager.getState();
      expect(state.issues["42"].phases["spec"]?.error).toBe(
        "Something went wrong",
      );
    });

    it("should update issue status to in_progress on first phase start", async () => {
      await manager.updatePhaseStatus(42, "spec", "in_progress");

      const state = await manager.getState();
      expect(state.issues["42"].status).toBe("in_progress");
    });

    it("should throw if issue not found", async () => {
      await expect(
        manager.updatePhaseStatus(999, "spec", "in_progress"),
      ).rejects.toThrow("Issue #999 not found");
    });
  });

  describe("updateIssueStatus", () => {
    beforeEach(async () => {
      await manager.initializeIssue(42, "Test Issue");
    });

    it("should update issue status", async () => {
      await manager.updateIssueStatus(42, "ready_for_merge");

      const state = await manager.getState();
      expect(state.issues["42"].status).toBe("ready_for_merge");
    });

    it("should update lastActivity", async () => {
      const state1 = await manager.getState();
      const lastActivity1 = state1.issues["42"].lastActivity;

      await new Promise((resolve) => setTimeout(resolve, 10));
      await manager.updateIssueStatus(42, "merged");

      const state2 = await manager.getState();
      expect(state2.issues["42"].lastActivity).not.toBe(lastActivity1);
    });
  });

  describe("updatePRInfo", () => {
    beforeEach(async () => {
      await manager.initializeIssue(42, "Test Issue");
    });

    it("should add PR information", async () => {
      await manager.updatePRInfo(42, {
        number: 123,
        url: "https://github.com/owner/repo/pull/123",
      });

      const state = await manager.getState();
      expect(state.issues["42"].pr).toBeDefined();
      expect(state.issues["42"].pr?.number).toBe(123);
      expect(state.issues["42"].pr?.url).toBe(
        "https://github.com/owner/repo/pull/123",
      );
    });
  });

  describe("removeIssue", () => {
    beforeEach(async () => {
      await manager.initializeIssue(42, "Test Issue");
    });

    it("should remove issue from state", async () => {
      await manager.removeIssue(42);

      const state = await manager.getState();
      expect(state.issues["42"]).toBeUndefined();
    });

    it("should be idempotent for non-existent issues", async () => {
      await expect(manager.removeIssue(999)).resolves.not.toThrow();
    });
  });

  describe("getIssueState", () => {
    it("should return issue state if exists", async () => {
      await manager.initializeIssue(42, "Test Issue");

      const issueState = await manager.getIssueState(42);
      expect(issueState).not.toBeNull();
      expect(issueState?.number).toBe(42);
    });

    it("should return null if issue does not exist", async () => {
      const issueState = await manager.getIssueState(999);
      expect(issueState).toBeNull();
    });
  });

  describe("getAllIssueStates", () => {
    it("should return all issues keyed by number", async () => {
      await manager.initializeIssue(42, "Issue 42");
      await manager.initializeIssue(43, "Issue 43");

      const allStates = await manager.getAllIssueStates();

      expect(Object.keys(allStates).length).toBe(2);
      expect(allStates[42]).toBeDefined();
      expect(allStates[43]).toBeDefined();
    });
  });

  describe("getIssuesByStatus", () => {
    beforeEach(async () => {
      await manager.initializeIssue(42, "Issue 42");
      await manager.initializeIssue(43, "Issue 43");
      await manager.initializeIssue(44, "Issue 44");

      await manager.updateIssueStatus(42, "in_progress");
      await manager.updateIssueStatus(43, "ready_for_merge");
    });

    it("should return issues with matching status", async () => {
      const inProgress = await manager.getIssuesByStatus("in_progress");
      expect(inProgress.length).toBe(1);
      expect(inProgress[0].number).toBe(42);
    });

    it("should return empty array if no matches", async () => {
      const merged = await manager.getIssuesByStatus("merged");
      expect(merged.length).toBe(0);
    });
  });

  describe("clearCache", () => {
    it("should force re-read on next access", async () => {
      await manager.initializeIssue(42, "Test Issue");

      // Get current state to compare timestamps
      const state1 = await manager.getState();
      const lastUpdated1 = state1.lastUpdated;

      // Direct file modification (simulating external change)
      // Create a new state object (not from cache)
      const externalState: WorkflowState = {
        version: 1,
        lastUpdated: new Date(Date.now() + 1000).toISOString(), // Future timestamp
        issues: {
          "42": createIssueState(42, "Test Issue"),
          "99": createIssueState(99, "External Issue"),
        },
      };
      fs.writeFileSync(statePath, JSON.stringify(externalState));

      // Without clear, should return cached state (same timestamp)
      const cached = await manager.getState();
      expect(cached.lastUpdated).toBe(lastUpdated1);

      // After clear, should read from file (new timestamp)
      manager.clearCache();
      const fresh = await manager.getState();
      expect(fresh.issues["99"]).toBeDefined();
      expect(fresh.lastUpdated).not.toBe(lastUpdated1);
    });
  });

  describe("updateAcceptanceCriteria", () => {
    beforeEach(async () => {
      await manager.initializeIssue(42, "Test Issue");
    });

    it("should store acceptance criteria for an issue", async () => {
      const items = [
        createAcceptanceCriterion("AC-1", "User can login", "unit_test"),
        createAcceptanceCriterion(
          "AC-2",
          "Session persists",
          "integration_test",
        ),
      ];
      const ac = createAcceptanceCriteria(items);

      await manager.updateAcceptanceCriteria(42, ac);

      const state = await manager.getState();
      expect(state.issues["42"].acceptanceCriteria).toBeDefined();
      expect(state.issues["42"].acceptanceCriteria?.items.length).toBe(2);
      expect(state.issues["42"].acceptanceCriteria?.summary.total).toBe(2);
      expect(state.issues["42"].acceptanceCriteria?.summary.pending).toBe(2);
    });

    it("should throw if issue not found", async () => {
      const ac = createAcceptanceCriteria([]);
      await expect(manager.updateAcceptanceCriteria(999, ac)).rejects.toThrow(
        "Issue #999 not found",
      );
    });
  });

  describe("getAcceptanceCriteria", () => {
    beforeEach(async () => {
      await manager.initializeIssue(42, "Test Issue");
    });

    it("should return acceptance criteria if exists", async () => {
      const items = [
        createAcceptanceCriterion("AC-1", "Test criterion", "manual"),
      ];
      const ac = createAcceptanceCriteria(items);
      await manager.updateAcceptanceCriteria(42, ac);

      const retrieved = await manager.getAcceptanceCriteria(42);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.items.length).toBe(1);
      expect(retrieved?.items[0].id).toBe("AC-1");
    });

    it("should return null if no AC exists", async () => {
      const retrieved = await manager.getAcceptanceCriteria(42);
      expect(retrieved).toBeNull();
    });

    it("should return null if issue does not exist", async () => {
      const retrieved = await manager.getAcceptanceCriteria(999);
      expect(retrieved).toBeNull();
    });
  });

  describe("updateACStatus", () => {
    beforeEach(async () => {
      await manager.initializeIssue(42, "Test Issue");
      const items = [
        createAcceptanceCriterion("AC-1", "First criterion", "unit_test"),
        createAcceptanceCriterion("AC-2", "Second criterion", "manual"),
      ];
      const ac = createAcceptanceCriteria(items);
      await manager.updateAcceptanceCriteria(42, ac);
    });

    it("should update individual AC status", async () => {
      await manager.updateACStatus(42, "AC-1", "met");

      const ac = await manager.getAcceptanceCriteria(42);
      const ac1 = ac?.items.find((i) => i.id === "AC-1");
      expect(ac1?.status).toBe("met");
      expect(ac1?.verifiedAt).toBeDefined();
    });

    it("should recalculate summary counts", async () => {
      await manager.updateACStatus(42, "AC-1", "met");

      const ac = await manager.getAcceptanceCriteria(42);
      expect(ac?.summary.met).toBe(1);
      expect(ac?.summary.pending).toBe(1);
      expect(ac?.summary.total).toBe(2);
    });

    it("should add notes when provided", async () => {
      await manager.updateACStatus(
        42,
        "AC-1",
        "not_met",
        "Failed due to timeout",
      );

      const ac = await manager.getAcceptanceCriteria(42);
      const ac1 = ac?.items.find((i) => i.id === "AC-1");
      expect(ac1?.notes).toBe("Failed due to timeout");
    });

    it("should throw if issue not found", async () => {
      await expect(manager.updateACStatus(999, "AC-1", "met")).rejects.toThrow(
        "Issue #999 not found",
      );
    });

    it("should throw if AC not found", async () => {
      await expect(manager.updateACStatus(42, "AC-999", "met")).rejects.toThrow(
        'AC "AC-999" not found in issue #42',
      );
    });

    it("should throw if issue has no AC", async () => {
      await manager.initializeIssue(43, "No AC Issue");
      await expect(manager.updateACStatus(43, "AC-1", "met")).rejects.toThrow(
        "Issue #43 has no acceptance criteria",
      );
    });
  });
});
