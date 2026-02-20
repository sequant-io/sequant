/**
 * Unit tests for git-diff-utils (AC-3, AC-4, AC-12)
 *
 * Tests the git diff parsing utilities for pipeline observability.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import { getGitDiffStats, getCommitHash } from "./git-diff-utils.js";

// Mock child_process
vi.mock("child_process", () => ({
  spawnSync: vi.fn(),
}));

const mockedSpawnSync = vi.mocked(childProcess.spawnSync);

describe("git-diff-utils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("getGitDiffStats (AC-4)", () => {
    describe("happy path", () => {
      it("should parse single file with additions and deletions", () => {
        // Mock numstat output
        mockedSpawnSync.mockImplementation((cmd, args) => {
          if (args?.includes("--numstat")) {
            return {
              status: 0,
              stdout: "10\t5\tsrc/file.ts\n",
              stderr: "",
              pid: 1,
              output: [],
              signal: null,
            };
          }
          if (args?.includes("--name-status")) {
            return {
              status: 0,
              stdout: "M\tsrc/file.ts\n",
              stderr: "",
              pid: 1,
              output: [],
              signal: null,
            };
          }
          return {
            status: 0,
            stdout: "",
            stderr: "",
            pid: 1,
            output: [],
            signal: null,
          };
        });

        const result = getGitDiffStats("/path/to/worktree");

        expect(result.filesModified).toEqual(["src/file.ts"]);
        expect(result.fileDiffStats).toHaveLength(1);
        expect(result.fileDiffStats[0]).toEqual({
          path: "src/file.ts",
          additions: 10,
          deletions: 5,
          status: "modified",
        });
        expect(result.totalAdditions).toBe(10);
        expect(result.totalDeletions).toBe(5);
      });

      it("should parse multiple files with varying stats", () => {
        mockedSpawnSync.mockImplementation((cmd, args) => {
          if (args?.includes("--numstat")) {
            return {
              status: 0,
              stdout:
                "20\t0\tsrc/new.ts\n5\t10\tsrc/changed.ts\n0\t15\tsrc/deleted.ts\n",
              stderr: "",
              pid: 1,
              output: [],
              signal: null,
            };
          }
          if (args?.includes("--name-status")) {
            return {
              status: 0,
              stdout: "A\tsrc/new.ts\nM\tsrc/changed.ts\nD\tsrc/deleted.ts\n",
              stderr: "",
              pid: 1,
              output: [],
              signal: null,
            };
          }
          return {
            status: 0,
            stdout: "",
            stderr: "",
            pid: 1,
            output: [],
            signal: null,
          };
        });

        const result = getGitDiffStats("/path/to/worktree");

        expect(result.filesModified).toHaveLength(3);
        expect(result.totalAdditions).toBe(25);
        expect(result.totalDeletions).toBe(25);

        const newFile = result.fileDiffStats.find(
          (f) => f.path === "src/new.ts",
        );
        expect(newFile?.status).toBe("added");
        expect(newFile?.additions).toBe(20);

        const changedFile = result.fileDiffStats.find(
          (f) => f.path === "src/changed.ts",
        );
        expect(changedFile?.status).toBe("modified");

        const deletedFile = result.fileDiffStats.find(
          (f) => f.path === "src/deleted.ts",
        );
        expect(deletedFile?.status).toBe("deleted");
      });

      it("should handle renamed files", () => {
        mockedSpawnSync.mockImplementation((cmd, args) => {
          if (args?.includes("--numstat")) {
            return {
              status: 0,
              stdout: "0\t0\tnew-name.ts\n",
              stderr: "",
              pid: 1,
              output: [],
              signal: null,
            };
          }
          if (args?.includes("--name-status")) {
            return {
              status: 0,
              stdout: "R100\told-name.ts\tnew-name.ts\n",
              stderr: "",
              pid: 1,
              output: [],
              signal: null,
            };
          }
          return {
            status: 0,
            stdout: "",
            stderr: "",
            pid: 1,
            output: [],
            signal: null,
          };
        });

        const result = getGitDiffStats("/path/to/worktree");

        expect(result.fileDiffStats).toHaveLength(1);
        expect(result.fileDiffStats[0].status).toBe("renamed");
      });
    });

    describe("edge cases", () => {
      it("should handle empty diff (no files changed)", () => {
        mockedSpawnSync.mockReturnValue({
          status: 0,
          stdout: "",
          stderr: "",
          pid: 1,
          output: [],
          signal: null,
        });

        const result = getGitDiffStats("/path/to/worktree");

        expect(result.filesModified).toEqual([]);
        expect(result.fileDiffStats).toEqual([]);
        expect(result.totalAdditions).toBe(0);
        expect(result.totalDeletions).toBe(0);
      });

      it("should handle binary files", () => {
        mockedSpawnSync.mockImplementation((cmd, args) => {
          if (args?.includes("--numstat")) {
            return {
              status: 0,
              stdout: "-\t-\timage.png\n",
              stderr: "",
              pid: 1,
              output: [],
              signal: null,
            };
          }
          if (args?.includes("--name-status")) {
            return {
              status: 0,
              stdout: "M\timage.png\n",
              stderr: "",
              pid: 1,
              output: [],
              signal: null,
            };
          }
          return {
            status: 0,
            stdout: "",
            stderr: "",
            pid: 1,
            output: [],
            signal: null,
          };
        });

        const result = getGitDiffStats("/path/to/worktree");

        expect(result.fileDiffStats).toHaveLength(1);
        expect(result.fileDiffStats[0]).toEqual({
          path: "image.png",
          additions: 0,
          deletions: 0,
          status: "modified",
        });
      });

      it("should handle git command failure gracefully", () => {
        mockedSpawnSync.mockReturnValue({
          status: 1,
          stdout: "",
          stderr: "fatal: not a git repository",
          pid: 1,
          output: [],
          signal: null,
        });

        const result = getGitDiffStats("/invalid/path");

        expect(result.filesModified).toEqual([]);
        expect(result.fileDiffStats).toEqual([]);
        expect(result.totalAdditions).toBe(0);
        expect(result.totalDeletions).toBe(0);
      });
    });

    describe("custom base branch", () => {
      it("should use custom base branch for comparison", () => {
        mockedSpawnSync.mockReturnValue({
          status: 0,
          stdout: "",
          stderr: "",
          pid: 1,
          output: [],
          signal: null,
        });

        getGitDiffStats("/path/to/worktree", "develop");

        // Check that git commands used the custom branch
        expect(mockedSpawnSync).toHaveBeenCalledWith(
          "git",
          expect.arrayContaining(["develop...HEAD"]),
          expect.any(Object),
        );
      });
    });
  });

  describe("getCommitHash (AC-2)", () => {
    it("should return commit SHA on success", () => {
      mockedSpawnSync.mockReturnValue({
        status: 0,
        stdout: "abc123def456\n",
        stderr: "",
        pid: 1,
        output: [],
        signal: null,
      });

      const result = getCommitHash("/path/to/worktree");

      expect(result).toBe("abc123def456");
    });

    it("should return undefined on git failure", () => {
      mockedSpawnSync.mockReturnValue({
        status: 1,
        stdout: "",
        stderr: "fatal: not a git repository",
        pid: 1,
        output: [],
        signal: null,
      });

      const result = getCommitHash("/invalid/path");

      expect(result).toBeUndefined();
    });

    it("should trim whitespace from SHA", () => {
      mockedSpawnSync.mockReturnValue({
        status: 0,
        stdout: "  abc123def456  \n",
        stderr: "",
        pid: 1,
        output: [],
        signal: null,
      });

      const result = getCommitHash("/path/to/worktree");

      expect(result).toBe("abc123def456");
    });
  });
});
