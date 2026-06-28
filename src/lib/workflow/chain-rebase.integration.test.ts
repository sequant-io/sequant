/**
 * Integration tests for chain successor rebasing (#748)
 *
 * Real git, no mocks of `ensureWorktreesChain` or the rebase step. These guard
 * the regression: on a fresh `--chain` run, successors are provisioned up-front
 * (branching each from the base while the predecessor branch still points at
 * main), so each successor effectively branches from `main` and misses its
 * predecessor's committed work.
 *
 * The fix (`rebaseOntoLocalBranch`, called from `executeSequential` once the
 * predecessor has committed) re-chains the successor onto the predecessor's
 * *local* tip. We reproduce the up-front-provisioning shape with real worktrees
 * here rather than calling `ensureWorktreesChain` directly, because that path
 * installs dependencies and operates on the process cwd — neither of which a
 * unit test should do. The actual rebase step under test is the real function.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { rebaseOntoLocalBranch } from "./worktree-manager.js";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

/** True iff `ancestor` is an ancestor of `descendant` (the chain contract). */
function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): boolean {
  const result = spawnSync(
    "git",
    ["-C", cwd, "merge-base", "--is-ancestor", ancestor, descendant],
    { encoding: "utf-8" },
  );
  return result.status === 0;
}

describe("chain successor rebasing (integration)", () => {
  let root: string;
  let mainRepo: string;
  let predWorktree: string;
  let succWorktree: string;
  const predBranch = "feature/125-pred";
  const succBranch = "feature/126-succ";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sequant-chain-"));
    mainRepo = join(root, "repo");

    // Baseline repo on main — this commit is the run's startCommit (== main).
    git(root, "init", "--initial-branch=main", "repo");
    git(mainRepo, "config", "user.email", "test@sequant.test");
    git(mainRepo, "config", "user.name", "Test");
    git(mainRepo, "config", "commit.gpgsign", "false");
    writeFileSync(join(mainRepo, "README.md"), "# repo\n");
    git(mainRepo, "add", "README.md");
    git(mainRepo, "commit", "-m", "initial commit");

    // Reproduce up-front provisioning: BOTH successor and predecessor branches
    // are cut from main, because at provisioning time the predecessor branch
    // still points at main (it hasn't executed/committed yet). This is exactly
    // the timing bug in `ensureWorktreesChain`.
    predWorktree = join(root, "worktrees", predBranch);
    succWorktree = join(root, "worktrees", succBranch);
    git(mainRepo, "worktree", "add", "-b", predBranch, predWorktree, "main");
    git(mainRepo, "worktree", "add", "-b", succBranch, succWorktree, "main");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("re-chains a successor onto its predecessor's committed exec work (AC-1, AC-2)", () => {
    // Predecessor executes and commits its work (as the sequential loop would
    // before the successor runs).
    writeFileSync(
      join(predWorktree, "feature-125.ts"),
      "export const a = 1;\n",
    );
    git(predWorktree, "add", "feature-125.ts");
    git(predWorktree, "commit", "-m", "feat(#125): exec work");
    const predExecCommit = git(predWorktree, "rev-parse", "HEAD");

    // BUG state (pre-fix): the successor was branched from main, so the
    // predecessor's exec commit is NOT yet an ancestor of the successor HEAD.
    const succHeadBefore = git(succWorktree, "rev-parse", "HEAD");
    expect(isAncestor(mainRepo, predExecCommit, succHeadBefore)).toBe(false);

    // FIX: rebase the successor's worktree onto the predecessor's local branch.
    const rebase = rebaseOntoLocalBranch(succWorktree, predBranch, false);
    expect(rebase.success).toBe(true);
    expect(rebase.conflict).toBe(false);

    // AC-2: the predecessor's exec commit is now an ancestor of successor HEAD.
    const succHeadAfter = git(succWorktree, "rev-parse", "HEAD");
    expect(isAncestor(mainRepo, predExecCommit, succHeadAfter)).toBe(true);
  });

  it("carries the successor's own commits forward on top of the predecessor", () => {
    // Predecessor commits exec work.
    writeFileSync(
      join(predWorktree, "feature-125.ts"),
      "export const a = 1;\n",
    );
    git(predWorktree, "add", "feature-125.ts");
    git(predWorktree, "commit", "-m", "feat(#125): exec work");
    const predExecCommit = git(predWorktree, "rev-parse", "HEAD");

    // Successor already has a commit of its own (e.g. from a prior iteration).
    writeFileSync(
      join(succWorktree, "feature-126.ts"),
      "export const b = 2;\n",
    );
    git(succWorktree, "add", "feature-126.ts");
    git(succWorktree, "commit", "-m", "feat(#126): exec work");

    const rebase = rebaseOntoLocalBranch(succWorktree, predBranch, false);
    expect(rebase.success).toBe(true);

    // Both the predecessor's and the successor's work are present.
    const succHead = git(succWorktree, "rev-parse", "HEAD");
    expect(isAncestor(mainRepo, predExecCommit, succHead)).toBe(true);
    const files = git(succWorktree, "ls-files");
    expect(files).toContain("feature-125.ts");
    expect(files).toContain("feature-126.ts");
  });

  it("aborts and reports a conflict without changing the successor branch", () => {
    // Predecessor and successor both edit the same file with diverging content
    // — rebasing the successor onto the predecessor must conflict.
    writeFileSync(
      join(predWorktree, "shared.ts"),
      "export const x = 'pred';\n",
    );
    git(predWorktree, "add", "shared.ts");
    git(predWorktree, "commit", "-m", "feat(#125): edit shared");

    writeFileSync(
      join(succWorktree, "shared.ts"),
      "export const x = 'succ';\n",
    );
    git(succWorktree, "add", "shared.ts");
    git(succWorktree, "commit", "-m", "feat(#126): edit shared");
    const succHeadBefore = git(succWorktree, "rev-parse", "HEAD");

    const rebase = rebaseOntoLocalBranch(succWorktree, predBranch, false);

    expect(rebase.success).toBe(false);
    expect(rebase.conflict).toBe(true);
    // Aborted: the successor branch is restored to its original tip and there is
    // no in-progress rebase left behind.
    expect(git(succWorktree, "rev-parse", "HEAD")).toBe(succHeadBefore);
    const status = spawnSync(
      "git",
      ["-C", succWorktree, "status", "--porcelain"],
      { encoding: "utf-8" },
    ).stdout.trim();
    expect(status).toBe("");
  });
});
