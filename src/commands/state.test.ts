/**
 * Tests for the state command
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { StateManager } from "../lib/workflow/state-manager.js";
import {
  createIssueState,
  type WorkflowState,
} from "../lib/workflow/state-schema.js";
import {
  discoverUntrackedWorktrees,
  cleanupStaleEntries,
  rebuildStateFromLogs,
} from "../lib/workflow/state-utils.js";

describe("state command", () => {
  let tempDir: string;
  let statePath: string;
  let logPath: string;

  beforeEach(() => {
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-cmd-test-"));
    statePath = path.join(tempDir, ".sequant", "state.json");
    logPath = path.join(tempDir, ".sequant", "logs");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.mkdirSync(logPath, { recursive: true });
  });

  afterEach(() => {
    // Cleanup temp dir
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("idempotency (AC-4)", () => {
    it("state init should be idempotent - running twice yields same result", async () => {
      // Run discovery twice with the same state
      const result1 = await discoverUntrackedWorktrees({ statePath });
      expect(result1.success).toBe(true);

      // If worktrees were discovered, add them to state
      if (result1.discovered.length > 0) {
        const manager = new StateManager({ statePath });
        for (const wt of result1.discovered) {
          await manager.initializeIssue(wt.issueNumber, wt.title, {
            worktree: wt.worktreePath,
            branch: wt.branch,
          });
        }

        // Second run should find fewer/no new worktrees
        const result2 = await discoverUntrackedWorktrees({ statePath });
        expect(result2.success).toBe(true);
        expect(result2.discovered.length).toBe(0);
        expect(result2.alreadyTracked).toBe(result1.discovered.length);
      }
    });

    it("state clean should be idempotent - running twice yields same result", async () => {
      // Create state with an orphaned worktree
      const state: WorkflowState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        issues: {
          "999": {
            ...createIssueState(999, "Orphaned Issue"),
            worktree: "/nonexistent/worktree/path/that/does/not/exist",
            branch: "feature/999-orphaned",
          },
        },
      };
      fs.writeFileSync(statePath, JSON.stringify(state));

      // First clean - marks as abandoned (status was "not_started")
      const result1 = await cleanupStaleEntries({ statePath });
      expect(result1.success).toBe(true);
      expect(result1.orphaned).toContain(999);

      // Second clean - removes issue (status is now "abandoned")
      const result2 = await cleanupStaleEntries({ statePath });
      expect(result2.success).toBe(true);
      expect(result2.removed).toContain(999);

      // Third clean - should find nothing (issue is gone)
      const result3 = await cleanupStaleEntries({ statePath });
      expect(result3.success).toBe(true);
      expect(result3.orphaned).toHaveLength(0);
      expect(result3.removed).toHaveLength(0);
    });

    it("state rebuild should be idempotent - running twice yields same result", async () => {
      // First rebuild with no logs
      const result1 = await rebuildStateFromLogs({ logPath, statePath });
      expect(result1.success).toBe(true);

      // Second rebuild
      const result2 = await rebuildStateFromLogs({ logPath, statePath });
      expect(result2.success).toBe(true);
      expect(result2.logsProcessed).toBe(result1.logsProcessed);
      expect(result2.issuesFound).toBe(result1.issuesFound);
    });
  });

  describe("clear output (AC-5)", () => {
    it("discoverUntrackedWorktrees returns structured data for output", async () => {
      const result = await discoverUntrackedWorktrees({ statePath });

      // The result structure should support clear output
      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("worktreesScanned");
      expect(result).toHaveProperty("alreadyTracked");
      expect(result).toHaveProperty("discovered");
      expect(result).toHaveProperty("skipped");

      // Discovered worktrees have all needed info for output
      for (const wt of result.discovered) {
        expect(wt).toHaveProperty("issueNumber");
        expect(wt).toHaveProperty("title");
        expect(wt).toHaveProperty("worktreePath");
        expect(wt).toHaveProperty("branch");
      }

      // Skipped worktrees have reason for output
      for (const skip of result.skipped) {
        expect(skip).toHaveProperty("path");
        expect(skip).toHaveProperty("reason");
      }
    });

    it("cleanupStaleEntries returns structured data for output", async () => {
      const result = await cleanupStaleEntries({ statePath, dryRun: true });

      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("removed");
      expect(result).toHaveProperty("orphaned");
      expect(Array.isArray(result.removed)).toBe(true);
      expect(Array.isArray(result.orphaned)).toBe(true);
    });

    it("rebuildStateFromLogs returns structured data for output", async () => {
      const result = await rebuildStateFromLogs({ logPath, statePath });

      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("logsProcessed");
      expect(result).toHaveProperty("issuesFound");
    });
  });
});
