/**
 * Direct import tests for worktree-manager module.
 *
 * These tests verify that worktree-manager exports are importable
 * directly (not just via run.ts re-exports), and test pure functions.
 */

import { describe, it, expect } from "vitest";
import {
  slugify,
  getGitRoot,
  findExistingWorktree,
  listWorktrees,
  getWorktreeChangedFiles,
  getWorktreeDiffStats,
  readCacheMetrics,
  // Re-exported from pr-operations
  createCheckpointCommit,
  reinstallIfLockfileChanged,
  rebaseBeforePR,
  createPR,
} from "./worktree-manager.js";

describe("worktree-manager direct imports", () => {
  describe("slugify", () => {
    it("should convert title to lowercase slug", () => {
      expect(slugify("Hello World")).toBe("hello-world");
    });

    it("should remove special characters", () => {
      expect(slugify("feat: add new feature!")).toBe("feat-add-new-feature");
    });

    it("should truncate to 50 chars", () => {
      const long = "a".repeat(60);
      expect(slugify(long).length).toBeLessThanOrEqual(50);
    });

    it("should strip leading/trailing hyphens", () => {
      expect(slugify("--hello--")).toBe("hello");
    });
  });

  describe("getGitRoot", () => {
    it("should return a string path in a git repo", () => {
      const root = getGitRoot();
      expect(root).toBeTruthy();
      expect(typeof root).toBe("string");
    });
  });

  describe("exports exist", () => {
    it("should export all expected functions", () => {
      expect(typeof findExistingWorktree).toBe("function");
      expect(typeof listWorktrees).toBe("function");
      expect(typeof getWorktreeChangedFiles).toBe("function");
      expect(typeof getWorktreeDiffStats).toBe("function");
      expect(typeof readCacheMetrics).toBe("function");
    });

    it("should re-export pr-operations functions", () => {
      expect(typeof createCheckpointCommit).toBe("function");
      expect(typeof reinstallIfLockfileChanged).toBe("function");
      expect(typeof rebaseBeforePR).toBe("function");
      expect(typeof createPR).toBe("function");
    });
  });
});
