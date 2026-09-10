/**
 * WIP-commit on the exec no-commit guard (#1032 AC-4 / AC-5).
 *
 * Real temp git repositories, no child_process mocking — the point is that
 * `git add` + `git commit` actually run against a worktree in the
 * `uncommitted` state. `phase-executor.test.ts` mocks execFileSync at module
 * level, which is why these cases live in their own file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mapAgentSuccessToPhaseResult } from "./phase-executor.js";
import type { AgentPhaseResult } from "./drivers/agent-driver.js";

let repo: string;

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

/** A repo whose `main` has one commit and whose feature branch is at main. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wip-commit-"));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "t"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  writeFileSync(join(dir, "README.md"), "base\n");
  git(["add", "README.md"], dir);
  git(["commit", "-q", "-m", "base"], dir);
  // classifyExecChanges resolves the base as origin/main unless a recorded
  // base exists; give it a local origin/main ref pointing at the base.
  git(["update-ref", "refs/remotes/origin/main", "HEAD"], dir);
  git(["checkout", "-q", "-b", "feature/1032-test"], dir);
  return dir;
}

function agentResult(): AgentPhaseResult {
  return { success: true, output: "done" };
}

beforeEach(() => {
  repo = makeRepo();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("AC-4: an uncommitted exec tree is committed as WIP before the phase fails", () => {
  it("commits the dirty paths, still fails, and names the commit", () => {
    writeFileSync(join(repo, "src.ts"), "export const a = 1;\n");
    mkdirSync(join(repo, "lib"));
    writeFileSync(join(repo, "lib/new.ts"), "export const b = 2;\n");
    writeFileSync(join(repo, "README.md"), "base\nedited\n");

    const result = mapAgentSuccessToPhaseResult(
      "exec",
      agentResult(),
      10,
      repo,
      1032,
    );

    expect(result.success).toBe(false);
    expect(git(["rev-list", "--count", "origin/main..HEAD"])).toBe("1");
    expect(git(["status", "--porcelain", "--untracked-files=all"])).toBe("");
    const subject = git(["log", "-1", "--format=%s"]);
    expect(subject).toBe(
      "chore(#1032): wip checkpoint — exec ended with uncommitted work (auto-committed by sequant)",
    );
    expect(result.error).toMatch(/auto-committed as [0-9a-f]{7}/);
    // The original #879 prefix survives for anything that greps for it.
    expect(result.error).toContain(
      "exec left 3 file(s) uncommitted and made no commits",
    );
    expect(result.error).toContain("src.ts");
  });

  it("falls back to the plain #879 message when the commit cannot be made", () => {
    writeFileSync(join(repo, "src.ts"), "export const a = 1;\n");
    // Make the commit fail: an unwritable index lock stands in for any git
    // error on the commit path.
    writeFileSync(join(repo, ".git", "index.lock"), "");

    const result = mapAgentSuccessToPhaseResult(
      "exec",
      agentResult(),
      10,
      repo,
      1032,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "exec left 1 file(s) uncommitted and made no commits",
    );
    expect(result.error).toMatch(/auto-commit failed/);
    expect(result.error).not.toMatch(/auto-committed as/);
    // The work is still preserved in place.
    expect(git(["status", "--porcelain", "--untracked-files=all"])).toContain(
      "src.ts",
    );
  });
});

describe("AC-5: the WIP commit never runs when there is nothing to rescue", () => {
  it("leaves a tree with real commits alone", () => {
    writeFileSync(join(repo, "src.ts"), "export const a = 1;\n");
    git(["add", "src.ts"]);
    git(["commit", "-q", "-m", "feat: real work"]);

    const result = mapAgentSuccessToPhaseResult(
      "exec",
      agentResult(),
      10,
      repo,
      1032,
    );

    expect(result.success).toBe(true);
    expect(git(["rev-list", "--count", "origin/main..HEAD"])).toBe("1");
    expect(git(["log", "-1", "--format=%s"])).toBe("feat: real work");
  });

  it("leaves a clean tree alone (no-changes failure, no commit)", () => {
    const result = mapAgentSuccessToPhaseResult(
      "exec",
      agentResult(),
      10,
      repo,
      1032,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "exec produced no changes (no commits, no uncommitted work)",
    );
    expect(git(["rev-list", "--count", "origin/main..HEAD"])).toBe("0");
  });
});
