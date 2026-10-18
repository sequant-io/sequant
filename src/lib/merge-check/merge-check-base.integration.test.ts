/**
 * merge --check on a repo whose default branch is not `main` (#1484)
 *
 * Real git: a bare origin whose HEAD is `master` (no `origin/main` anywhere),
 * a real clone, real feature branches. Each case drives one of the four sites
 * that used to hard-code `origin/main`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../workflow/platforms/github.js", () => ({
  GitHubProvider: class {
    fetchIssueTitleSync(n: string) {
      return `Issue ${n}`;
    }
    listOpenPRFilesSync() {
      return [];
    }
  },
}));

import {
  resolveBranches,
  resolveMergeBaseRef,
  runMergeChecks,
} from "./index.js";
import { runCombinedBranchTest } from "./combined-branch-test.js";
import { runOverlapDetection } from "./overlap-detection.js";
import { extractPatternsFromDiff } from "./residual-pattern-scan.js";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

describe("master-default", () => {
  let root: string;
  let repo: string;
  const FILE = "src/target.ts";
  const BASE_LINES = ['const legacy = "legacy-token-value";', "export {};"];

  function featureBranch(name: string, replacement: string): void {
    git(repo, "checkout", "-b", name, "master");
    writeFileSync(
      join(repo, FILE),
      [replacement, BASE_LINES[1], ""].join("\n"),
    );
    git(repo, "add", FILE);
    git(repo, "commit", "-m", `feat: ${name}`);
    git(repo, "push", "-u", "origin", name);
    git(repo, "checkout", "master");
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sequant-base-"));
    repo = join(root, "repo");
    git(root, "init", "--bare", "--initial-branch=master", "origin.git");
    spawnSync("git", ["clone", join(root, "origin.git"), repo], {
      encoding: "utf-8",
    });
    git(repo, "config", "user.email", "test@sequant.test");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "commit.gpgsign", "false");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, FILE), BASE_LINES.join("\n") + "\n");
    git(repo, "add", FILE);
    git(repo, "commit", "-m", "initial commit");
    git(repo, "push", "-u", "origin", "master");
    // A clone of an empty bare repo does not record origin/HEAD.
    git(repo, "remote", "set-head", "origin", "master");
    featureBranch("feature/101-one", 'const legacy = "replaced-by-one";');
    featureBranch("feature/102-two", 'const legacy = "replaced-by-two";');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves origin/master and reports filesModified through runMergeChecks", async () => {
    expect(resolveMergeBaseRef(repo)).toBe("origin/master");
    const report = await runMergeChecks([101], {}, repo);
    expect(report.branches[0].filesModified).toEqual([FILE]);
    expect(report.branches[0].filesModifiedError).toBeUndefined();
  });

  it("creates the combined branch from origin/master", () => {
    const branches = resolveBranches([101], repo, "origin/master");
    const result = runCombinedBranchTest(branches, repo, "origin/master");
    const errors = result.batchFindings.filter((f) =>
      f.message.includes("Failed to create temp branch"),
    );
    expect(errors).toEqual([]);
    expect(
      result.branchResults.flatMap((b) => b.findings).map((f) => f.message),
    ).not.toContain("merge conflict");
  });

  it("reads the branches' hunk ranges for overlap", () => {
    // filesModified is fixed here so only the hunk-range site is under test.
    const branches = resolveBranches([101, 102], repo, "origin/master").map(
      (b) => ({ ...b, filesModified: [FILE] }),
    );
    const result = runOverlapDetection(branches, repo, "origin/master");
    expect(result.batchFindings.map((f) => f.message).join("\n")).toContain(
      "(conflicting)",
    );
  });

  it("reads the branch diff for the residual pattern scan", () => {
    const branches = resolveBranches([101], repo, "origin/master");
    const patterns = extractPatternsFromDiff(
      branches[0],
      repo,
      "origin/master",
    );
    expect(patterns.map((p) => p.pattern).join("\n")).toContain(
      "legacy-token-value",
    );
  });
});
