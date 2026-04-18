/**
 * Integration tests for createCheckpointCommit (#528 AC-4)
 *
 * These tests exercise real git against a temp worktree — no mocks.
 * They guard the regression mode described in the issue: chain-mode
 * checkpoints sweeping unrelated dirty files (`.claude/*`, `.sequant-manifest.json`)
 * into the PR base when the worktree is dirty outside the feature scope.
 *
 * Pair with the mocked unit tests in src/commands/run.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCheckpointCommit } from "./worktree-manager.js";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

// Porcelain output must preserve the leading XY columns — do not trim.
function gitRaw(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout;
}

describe("createCheckpointCommit (integration)", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "sequant-checkpoint-"));

    // Initialize repo with main branch + user config scoped to this repo only
    git(repoDir, "init", "--initial-branch=main");
    git(repoDir, "config", "user.email", "test@sequant.test");
    git(repoDir, "config", "user.name", "Test");
    git(repoDir, "config", "commit.gpgsign", "false");

    // Baseline commit on main — includes a tracked infra file to reproduce the
    // real regression (dirty tracked file outside the feature's commit scope)
    writeFileSync(join(repoDir, "README.md"), "# repo\n");
    mkdirSync(join(repoDir, ".claude"), { recursive: true });
    writeFileSync(join(repoDir, ".claude/memory.md"), "initial\n");
    git(repoDir, "add", "README.md", ".claude/memory.md");
    git(repoDir, "commit", "-m", "initial commit");

    // Feature branch with a committed change to src/feature.ts
    git(repoDir, "checkout", "-b", "feature/test");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src/feature.ts"), "export const v = 1;\n");
    git(repoDir, "add", "src/feature.ts");
    git(repoDir, "commit", "-m", "feat: add feature");
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("skips checkpoint and warns when a dirty non-feature file exists (AC-4)", () => {
    // Reproduce the regression: dirty a tracked infra file outside feature scope
    writeFileSync(join(repoDir, ".claude/memory.md"), "dirty infra\n");
    // Also dirty the feature file so there is in-scope work available
    writeFileSync(join(repoDir, "src/feature.ts"), "export const v = 2;\n");

    const headBefore = git(repoDir, "rev-parse", "HEAD");
    const result = createCheckpointCommit(repoDir, 42, false, "main");
    const headAfter = git(repoDir, "rev-parse", "HEAD");

    expect(result).toBe(false);
    // No new commit — the checkpoint was correctly skipped
    expect(headAfter).toBe(headBefore);

    // Both files remain dirty (modified, not staged, not committed)
    const status = gitRaw(repoDir, "status", "--porcelain");
    expect(status).toMatch(/^ M \.claude\/memory\.md$/m);
    expect(status).toMatch(/^ M src\/feature\.ts$/m);
  });

  it("commits only in-scope feature files when the tree is clean outside scope", () => {
    writeFileSync(join(repoDir, "src/feature.ts"), "export const v = 3;\n");

    const headBefore = git(repoDir, "rev-parse", "HEAD");
    const result = createCheckpointCommit(repoDir, 42, false, "main");
    const headAfter = git(repoDir, "rev-parse", "HEAD");

    expect(result).toBe(true);
    expect(headAfter).not.toBe(headBefore);

    // Commit message shape
    const msg = git(repoDir, "log", "-1", "--pretty=%s");
    expect(msg).toBe("checkpoint(#42): QA passed");

    // Only the feature file is in the checkpoint commit
    const changed = git(
      repoDir,
      "show",
      "--name-only",
      "--pretty=format:",
      "HEAD",
    ).trim();
    expect(changed).toBe("src/feature.ts");
  });

  it("returns true with no new commit when the tree is clean (AC-5)", () => {
    const headBefore = git(repoDir, "rev-parse", "HEAD");
    const result = createCheckpointCommit(repoDir, 42, false, "main");
    const headAfter = git(repoDir, "rev-parse", "HEAD");

    expect(result).toBe(true);
    expect(headAfter).toBe(headBefore);
  });

  it("checkpoints paths with unicode/non-ASCII characters", () => {
    // Without -z, git quotes non-ASCII paths ("caf\\303\\251.ts"), which would
    // break path-based staging. This test proves -z avoids that class of bug.
    const unicodePath = "src/café.ts";
    writeFileSync(join(repoDir, unicodePath), "export const v = 1;\n");
    git(repoDir, "add", unicodePath);
    git(repoDir, "commit", "-m", "feat: add unicode-named file");

    // Dirty the unicode-named file
    writeFileSync(join(repoDir, unicodePath), "export const v = 2;\n");

    const headBefore = git(repoDir, "rev-parse", "HEAD");
    const result = createCheckpointCommit(repoDir, 42, false, "main");
    const headAfter = git(repoDir, "rev-parse", "HEAD");

    expect(result).toBe(true);
    expect(headAfter).not.toBe(headBefore);

    // The unicode path appears verbatim in the checkpoint commit.
    // Use -c core.quotePath=false so git doesn't escape non-ASCII in its output.
    const changed = git(
      repoDir,
      "-c",
      "core.quotePath=false",
      "show",
      "--name-only",
      "--pretty=format:",
      "HEAD",
    ).trim();
    expect(changed).toContain(unicodePath);
  });
});
