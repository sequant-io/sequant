/**
 * Tests for pr-status.ts merge-detection helpers — Issue #1044.
 *
 * These use real git repositories rather than mocked `spawnSync`: the bug
 * being fixed is about what `git log --grep` actually matches against a real
 * commit subject, so mocking git out would test nothing. Each test builds an
 * isolated temp repo and `chdir`s into it, since `isBranchMergedIntoMain` and
 * `isIssueMergedIntoMain` default to `baseBranch: "main"` and shell out via
 * `spawnSync` against the process cwd (no `cwd` option is exposed).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Per-test override returned by GitHubProvider.getPRMergeStatusSync, used by
// the AC-2c linked-PR case (checkPRMergeStatus does not shell out to git).
let mockPRStatus: import("./platforms/github.js").PRMergeStatus = null;
const mockGetPRMergeStatusSync = vi.fn(() => mockPRStatus);

vi.mock("./platforms/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./platforms/github.js")>();
  return {
    ...actual,
    GitHubProvider: class MockGitHubProvider {
      getPRMergeStatusSync = mockGetPRMergeStatusSync;
    },
  };
});

const { isIssueMergedIntoMain, isBranchMergedIntoMain, checkPRMergeStatus } =
  await import("./pr-status.js");

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr?.toString()}`,
    );
  }
}

/** Create an isolated git repo with one commit on `main`. */
function initRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  git(
    root,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "chore: initial commit",
  );
}

describe("pr-status.ts (#1044)", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "pr-status-test-"));
    initRepo(tempDir);
    originalCwd = process.cwd();
    process.chdir(tempDir);
    mockPRStatus = null;
    mockGetPRMergeStatusSync.mockClear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("isIssueMergedIntoMain", () => {
    it("AC-1: returns false when main has a squash commit that merely mentions (#N) and the issue's branch is unmerged", () => {
      // Reproduces #1030's false positive: an unrelated PR's squash-merge
      // subject cites issue 1030 in prose, but nothing was actually merged
      // for issue 1030 itself.
      git(
        tempDir,
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "docs(graph): wave-2 plan — node 09 (#1030), ledger update",
      );
      git(tempDir, "branch", "feature/1030-fix-state-reconcile");

      expect(isIssueMergedIntoMain(1030)).toBe(false);
    });

    it("AC-2a: returns true for a real 'Merge #N ...' commit subject", () => {
      git(
        tempDir,
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "Merge #42 some manually-authored merge commit",
      );

      expect(isIssueMergedIntoMain(42)).toBe(true);
    });

    it("AC-2b: returns true when the issue's feature branch tip is a non-first parent of a real merge commit on main", () => {
      git(tempDir, "checkout", "--quiet", "-b", "feature/55-thing");
      git(
        tempDir,
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "feat: do the thing",
      );
      git(tempDir, "checkout", "--quiet", "main");
      git(
        tempDir,
        "merge",
        "--quiet",
        "--no-ff",
        "feature/55-thing",
        "-m",
        "Merge branch 'feature/55-thing'",
      );

      expect(isIssueMergedIntoMain(55)).toBe(true);
      expect(isBranchMergedIntoMain("feature/55-thing")).toBe(true);
    });
  });

  describe("checkPRMergeStatus (AC-2c)", () => {
    it("returns MERGED via GitHubProvider.getPRMergeStatusSync for a linked, merged PR", () => {
      mockPRStatus = "MERGED";

      expect(checkPRMergeStatus(1042)).toBe("MERGED");
      expect(mockGetPRMergeStatusSync).toHaveBeenCalledWith(1042);
    });
  });
});
