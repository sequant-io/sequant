/**
 * Tests for worktree isolation module.
 *
 * Tests branch naming, merge result formatting, and settings integration.
 * Git operations are tested via mocking execSync; actual git worktree
 * operations are validated by the investigation tests in AC-2/AC-4.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process and fs before imports
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  symlinkSync: vi.fn(),
  copyFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  rmdirSync: vi.fn(),
}));

import { execSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  copyFileSync,
  readFileSync,
} from "fs";
import {
  agentBranchName,
  createSubWorktree,
  mergeBackSubWorktree,
  mergeAllSubWorktrees,
  cleanupSubWorktree,
  formatMergeResult,
  getIncludeFiles,
  SUB_WORKTREE_DIR,
  WORKTREE_INCLUDE_FILE,
  type SubWorktreeInfo,
  type MergeBackResult,
} from "./worktree-isolation.js";

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockSymlinkSync = vi.mocked(symlinkSync);
const mockCopyFileSync = vi.mocked(copyFileSync);
const mockReadFileSync = vi.mocked(readFileSync);

describe("worktree-isolation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("agentBranchName", () => {
    it("extracts issue number from worktree path", () => {
      const branch = agentBranchName(
        "/worktrees/feature/485-evaluate-worktree",
        0,
      );
      expect(branch).toBe("exec-agent-485-0");
    });

    it("handles different agent indices", () => {
      const branch = agentBranchName("/worktrees/feature/123-fix-bug", 2);
      expect(branch).toBe("exec-agent-123-2");
    });

    it("uses directory prefix when no issue number pattern", () => {
      const branch = agentBranchName("/worktrees/feature/custom-branch", 0);
      expect(branch).toBe("exec-agent-custom-bra-0");
    });
  });

  describe("getIncludeFiles", () => {
    it("returns defaults when .worktreeinclude does not exist", () => {
      mockExistsSync.mockReturnValue(false);

      const files = getIncludeFiles("/some/worktree");

      expect(files).toContain(".env");
      expect(files).toContain(".env.local");
      expect(files).toContain(".claude/settings.local.json");
    });

    it("reads from .worktreeinclude when it exists", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        "# Comment\n.env\n.env.production\n\ncustom/config.json\n",
      );

      const files = getIncludeFiles("/some/worktree");

      expect(files).toEqual([".env", ".env.production", "custom/config.json"]);
    });

    it("skips comments and blank lines", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        "# header\n\n.env\n# another\n.env.local\n",
      );

      const files = getIncludeFiles("/some/worktree");

      expect(files).toEqual([".env", ".env.local"]);
    });

    it("falls back to defaults on read error", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => {
        throw new Error("permission denied");
      });

      const files = getIncludeFiles("/some/worktree");

      expect(files).toContain(".env");
    });
  });

  describe("SUB_WORKTREE_DIR", () => {
    it("is .exec-agents", () => {
      expect(SUB_WORKTREE_DIR).toBe(".exec-agents");
    });
  });

  describe("createSubWorktree", () => {
    const issueWorktree = "/worktrees/feature/485-eval";

    it("creates sub-worktree with correct branch and path", () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("" as any);

      const result = createSubWorktree(issueWorktree, 0);

      expect(result).not.toBeNull();
      expect(result!.branch).toBe("exec-agent-485-0");
      expect(result!.path).toBe(
        "/worktrees/feature/485-eval/.exec-agents/agent-0",
      );
      expect(result!.agentIndex).toBe(0);
    });

    it("creates .exec-agents directory if missing", () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("" as any);

      createSubWorktree(issueWorktree, 0);

      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining(".exec-agents"),
        { recursive: true },
      );
    });

    it("symlinks node_modules when available", () => {
      mockExistsSync.mockImplementation((path) => {
        const p = String(path);
        if (p.endsWith("node_modules") && p.includes(".exec-agents")) {
          return false; // agent doesn't have node_modules yet
        }
        if (p.endsWith("node_modules")) return true; // issue worktree has it
        return false;
      });
      mockExecSync.mockReturnValue("" as any);

      createSubWorktree(issueWorktree, 0);

      expect(mockSymlinkSync).toHaveBeenCalledWith(
        expect.stringContaining("485-eval/node_modules"),
        expect.stringContaining("agent-0/node_modules"),
      );
    });

    it("copies env files when they exist", () => {
      mockExistsSync.mockImplementation((path) => {
        const p = String(path);
        return p.endsWith(".env") || p.endsWith(".exec-agents");
      });
      mockExecSync.mockReturnValue("" as any);

      createSubWorktree(issueWorktree, 0);

      expect(mockCopyFileSync).toHaveBeenCalledWith(
        expect.stringContaining("485-eval/.env"),
        expect.stringContaining("agent-0/.env"),
      );
    });

    it("returns null on failure", () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockImplementation(() => {
        throw new Error("git worktree add failed");
      });

      const result = createSubWorktree(issueWorktree, 0);
      expect(result).toBeNull();
    });
  });

  describe("mergeBackSubWorktree", () => {
    const issueWorktree = "/worktrees/feature/485-eval";
    const subWorktree: SubWorktreeInfo = {
      path: "/worktrees/feature/485-eval/.exec-agents/agent-0",
      branch: "exec-agent-485-0",
      agentIndex: 0,
    };

    it("succeeds when merge is clean", () => {
      mockExecSync.mockImplementation((cmd) => {
        const c = String(cmd);
        if (c.includes("log")) return "abc1234 some change" as any;
        if (c.includes("merge")) return "" as any;
        return "" as any;
      });

      const result = mergeBackSubWorktree(issueWorktree, subWorktree);

      expect(result.success).toBe(true);
      expect(result.conflictFiles).toEqual([]);
    });

    it("succeeds when no changes to merge", () => {
      mockExecSync.mockImplementation((cmd) => {
        const c = String(cmd);
        if (c.includes("log")) return "" as any;
        return "" as any;
      });

      const result = mergeBackSubWorktree(issueWorktree, subWorktree);

      expect(result.success).toBe(true);
      expect(result.conflictFiles).toEqual([]);
    });

    it("reports conflict files on merge failure", () => {
      let callCount = 0;
      mockExecSync.mockImplementation((cmd) => {
        const c = String(cmd);
        if (c.includes("log")) return "abc1234 change" as any;
        if (c.includes("merge --no-ff")) {
          throw new Error("merge conflict");
        }
        if (c.includes("diff --name-only"))
          return "package.json\nindex.ts" as any;
        if (c.includes("merge --abort")) return "" as any;
        return "" as any;
      });

      const result = mergeBackSubWorktree(issueWorktree, subWorktree);

      expect(result.success).toBe(false);
      expect(result.conflictFiles).toEqual(["package.json", "index.ts"]);
      expect(result.error).toContain("2 file(s)");
    });
  });

  describe("mergeAllSubWorktrees", () => {
    const issueWorktree = "/worktrees/feature/485-eval";

    it("merges multiple agents and reports aggregate", () => {
      const subs: SubWorktreeInfo[] = [
        {
          path: `${issueWorktree}/.exec-agents/agent-0`,
          branch: "exec-agent-485-0",
          agentIndex: 0,
        },
        {
          path: `${issueWorktree}/.exec-agents/agent-1`,
          branch: "exec-agent-485-1",
          agentIndex: 1,
        },
      ];

      // Both have changes, both merge cleanly
      mockExecSync.mockImplementation((cmd) => {
        const c = String(cmd);
        if (c.includes("log")) return "abc1234 change" as any;
        if (c.includes("merge")) return "" as any;
        return "" as any;
      });

      const result = mergeAllSubWorktrees(issueWorktree, subs);

      expect(result.merged).toBe(2);
      expect(result.conflicts).toBe(0);
      expect(result.results).toHaveLength(2);
    });

    it("continues merging after one agent conflicts", () => {
      const subs: SubWorktreeInfo[] = [
        {
          path: `${issueWorktree}/.exec-agents/agent-0`,
          branch: "exec-agent-485-0",
          agentIndex: 0,
        },
        {
          path: `${issueWorktree}/.exec-agents/agent-1`,
          branch: "exec-agent-485-1",
          agentIndex: 1,
        },
      ];

      let mergeCallCount = 0;
      mockExecSync.mockImplementation((cmd) => {
        const c = String(cmd);
        if (c.includes("log")) return "abc1234 change" as any;
        if (c.includes("merge --no-ff")) {
          mergeCallCount++;
          if (mergeCallCount === 1) {
            throw new Error("conflict");
          }
          return "" as any;
        }
        if (c.includes("diff --name-only")) return "shared.ts" as any;
        if (c.includes("merge --abort")) return "" as any;
        return "" as any;
      });

      const result = mergeAllSubWorktrees(issueWorktree, subs);

      expect(result.merged).toBe(1);
      expect(result.conflicts).toBe(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[1].success).toBe(true);
    });
  });

  describe("cleanupSubWorktree", () => {
    const issueWorktree = "/worktrees/feature/485-eval";
    const sub: SubWorktreeInfo = {
      path: `${issueWorktree}/.exec-agents/agent-0`,
      branch: "exec-agent-485-0",
      agentIndex: 0,
    };

    it("removes worktree and branch", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecSync.mockReturnValue("" as any);

      cleanupSubWorktree(issueWorktree, sub);

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("worktree remove"),
        expect.any(Object),
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("branch -D exec-agent-485-0"),
        expect.any(Object),
      );
    });

    it("skips worktree removal if path does not exist", () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("" as any);

      cleanupSubWorktree(issueWorktree, sub);

      // Should still try to delete the branch
      const calls = mockExecSync.mock.calls.map((c) => String(c[0]));
      expect(calls.some((c) => c.includes("worktree remove"))).toBe(false);
      expect(calls.some((c) => c.includes("branch -D"))).toBe(true);
    });
  });

  describe("formatMergeResult", () => {
    it("formats successful result", () => {
      const result: MergeBackResult = {
        merged: 3,
        conflicts: 0,
        results: [
          { success: true, branch: "a", agentIndex: 0, conflictFiles: [] },
          { success: true, branch: "b", agentIndex: 1, conflictFiles: [] },
          { success: true, branch: "c", agentIndex: 2, conflictFiles: [] },
        ],
      };

      const output = formatMergeResult(result);
      expect(output).toContain("3/3 agents merged successfully");
      expect(output).not.toContain("Conflicts");
    });

    it("formats result with conflicts", () => {
      const result: MergeBackResult = {
        merged: 1,
        conflicts: 1,
        results: [
          { success: true, branch: "a", agentIndex: 0, conflictFiles: [] },
          {
            success: false,
            branch: "b",
            agentIndex: 1,
            conflictFiles: ["shared.ts"],
            error: "Merge conflict in 1 file(s): shared.ts",
          },
        ],
      };

      const output = formatMergeResult(result);
      expect(output).toContain("1/2 agents merged");
      expect(output).toContain("1 agent(s) had merge conflicts");
      expect(output).toContain("Agent 1");
      expect(output).toContain("shared.ts");
    });
  });
});

describe("settings integration", () => {
  it("isolateParallel defaults to false", async () => {
    const { DEFAULT_AGENT_SETTINGS } = await import("./settings.js");
    expect(DEFAULT_AGENT_SETTINGS.isolateParallel).toBe(false);
  });
});
