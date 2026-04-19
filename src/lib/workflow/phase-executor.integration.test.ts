/**
 * Integration tests for the custom-base zero-diff guard (#537 AC-6).
 *
 * Exercises real git — no mocks. Reproduces the end-to-end scenario from
 * the issue: a worktree branched from a populated feature branch with
 * `--base feature/<branch>` must still have zero-diff exec detected,
 * not masked by the parent branch's commits relative to origin/main.
 *
 * Pair with the mocked unit tests in phase-executor.test.ts. Those cover
 * edge cases in execSync shape; these cover the full real-git behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { hasExecChanges, resolveBaseRef } from "./phase-executor.js";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

/**
 * Build a repo topology that matches the #537 reproducer:
 *
 *   origin/main:        M1
 *   origin/feature/epic: M1 → E1 (1 commit ahead of main)
 *   work HEAD (feature/537-test): branched from feature/epic, base
 *                                 recorded as feature/epic
 *
 * Returns the path of the working repo. `origin` is backed by a local
 * bare repo so `origin/main` and `origin/feature/epic` both resolve.
 */
function makeEpicScenario(): { work: string; cleanup: () => void } {
  const origin = mkdtempSync(join(tmpdir(), "sequant-537-origin-"));
  const work = mkdtempSync(join(tmpdir(), "sequant-537-work-"));

  git(origin, "init", "--bare", "--initial-branch=main");
  git(work, "init", "--initial-branch=main");
  git(work, "config", "user.email", "test@sequant.test");
  git(work, "config", "user.name", "Test");
  git(work, "config", "commit.gpgsign", "false");
  git(work, "remote", "add", "origin", origin);

  // M1: baseline on main
  writeFileSync(join(work, "README.md"), "# repo\n");
  git(work, "add", "README.md");
  git(work, "commit", "-m", "M1: baseline");
  git(work, "push", "-u", "origin", "main");

  // E1: a commit on feature/epic, the parent feature branch
  git(work, "checkout", "-b", "feature/epic");
  mkdirSync(join(work, "src"), { recursive: true });
  writeFileSync(join(work, "src/epic.ts"), "export const epic = 1;\n");
  git(work, "add", "src/epic.ts");
  git(work, "commit", "-m", "E1: epic work");
  git(work, "push", "-u", "origin", "feature/epic");

  // The worktree under test: branched from feature/epic, base recorded
  git(work, "checkout", "-b", "feature/537-test");
  git(work, "config", "branch.feature/537-test.sequantBase", "feature/epic");

  return {
    work,
    cleanup: () => {
      rmSync(origin, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    },
  };
}

describe("hasExecChanges with custom base (integration, #537)", () => {
  let work: string;
  let cleanup: () => void;

  beforeEach(() => {
    const scenario = makeEpicScenario();
    work = scenario.work;
    cleanup = scenario.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it("resolveBaseRef returns origin/feature/epic for the custom-base worktree", () => {
    expect(resolveBaseRef(work)).toBe("origin/feature/epic");
  });

  it("returns false when exec produces zero commits and zero dirty work (primary #537 fix)", () => {
    // Sanity-check the scenario: HEAD IS ahead of origin/main, but NOT ahead of
    // origin/feature/epic. Pre-#537 the guard would count the 1 commit and
    // falsely report the exec as having changes.
    const commitsAheadOfMain = git(
      work,
      "rev-list",
      "--count",
      "origin/main..HEAD",
    );
    expect(Number(commitsAheadOfMain)).toBeGreaterThan(0);
    const commitsAheadOfEpic = git(
      work,
      "rev-list",
      "--count",
      "origin/feature/epic..HEAD",
    );
    expect(commitsAheadOfEpic).toBe("0");

    expect(hasExecChanges(work)).toBe(false);
  });

  it("returns true when exec adds a commit on top of the custom base", () => {
    writeFileSync(join(work, "src/new.ts"), "export const n = 1;\n");
    git(work, "add", "src/new.ts");
    git(work, "commit", "-m", "feat: new work on top of epic");

    expect(hasExecChanges(work)).toBe(true);
  });

  it("returns true when exec leaves uncommitted work even without new commits", () => {
    writeFileSync(join(work, "src/dirty.ts"), "export const d = 1;\n");

    expect(hasExecChanges(work)).toBe(true);
  });
});

describe("hasExecChanges without recorded base (integration, AC-3 fallback)", () => {
  let origin: string;
  let work: string;

  beforeEach(() => {
    origin = mkdtempSync(join(tmpdir(), "sequant-537-origin-"));
    work = mkdtempSync(join(tmpdir(), "sequant-537-work-"));

    git(origin, "init", "--bare", "--initial-branch=main");
    git(work, "init", "--initial-branch=main");
    git(work, "config", "user.email", "test@sequant.test");
    git(work, "config", "user.name", "Test");
    git(work, "config", "commit.gpgsign", "false");
    git(work, "remote", "add", "origin", origin);

    writeFileSync(join(work, "README.md"), "# repo\n");
    git(work, "add", "README.md");
    git(work, "commit", "-m", "M1: baseline");
    git(work, "push", "-u", "origin", "main");

    // Branch with no sequantBase recorded — pre-#537 worktree shape
    git(work, "checkout", "-b", "feature/legacy");
  });

  afterEach(() => {
    rmSync(origin, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  it("resolveBaseRef falls back to origin/main", () => {
    expect(resolveBaseRef(work)).toBe("origin/main");
  });

  it("returns false when exec produced nothing (preserves #534 behavior)", () => {
    expect(hasExecChanges(work)).toBe(false);
  });

  it("returns true when exec produced a commit", () => {
    mkdirSync(join(work, "src"), { recursive: true });
    writeFileSync(join(work, "src/feat.ts"), "export const f = 1;\n");
    git(work, "add", "src/feat.ts");
    git(work, "commit", "-m", "feat: add");
    expect(hasExecChanges(work)).toBe(true);
  });
});

/**
 * End-to-end test using `git worktree add` rather than `git init`.
 *
 * Branch-scoped git config (`branch.<name>.sequantBase`) is stored in
 * `$GIT_COMMON_DIR/config` and shared across all worktrees of a repo.
 * `new-feature.sh` writes the key from inside the worktree directory,
 * and `resolveBaseRef` reads it from the same worktree. This test
 * exercises that actual shape — create a main repo, push `main` and
 * `feature/epic` to a bare origin, then use `git worktree add` to
 * create a sibling worktree branched from `feature/epic`, record the
 * base from the worktree, and verify the guard reads it back.
 *
 * Complements the `git init` integration tests above (which exercise
 * the consumer semantics without the worktree-specific config
 * plumbing).
 */
describe("hasExecChanges via real git worktree add (integration, #537 AC-6 end-to-end)", () => {
  let origin: string;
  let main: string;
  let worktree: string;

  beforeEach(() => {
    origin = mkdtempSync(join(tmpdir(), "sequant-537-wt-origin-"));
    main = mkdtempSync(join(tmpdir(), "sequant-537-wt-main-"));
    // Sibling directory to `main` so git worktree add can use a relative
    // path that does not collide with the main repo layout.
    worktree = join(main, "..", `sequant-537-wt-feat-${Date.now()}`);

    git(origin, "init", "--bare", "--initial-branch=main");
    git(main, "init", "--initial-branch=main");
    git(main, "config", "user.email", "test@sequant.test");
    git(main, "config", "user.name", "Test");
    git(main, "config", "commit.gpgsign", "false");
    git(main, "remote", "add", "origin", origin);

    // M1: baseline
    writeFileSync(join(main, "README.md"), "# repo\n");
    git(main, "add", "README.md");
    git(main, "commit", "-m", "M1: baseline");
    git(main, "push", "-u", "origin", "main");

    // E1: epic branch with a commit ahead of main
    git(main, "checkout", "-b", "feature/epic");
    mkdirSync(join(main, "src"), { recursive: true });
    writeFileSync(join(main, "src/epic.ts"), "export const epic = 1;\n");
    git(main, "add", "src/epic.ts");
    git(main, "commit", "-m", "E1: epic work");
    git(main, "push", "-u", "origin", "feature/epic");

    // Return main to `main` so the worktree add has a clean HEAD to branch from.
    git(main, "checkout", "main");

    // The scenario new-feature.sh produces: a worktree branched from
    // feature/epic, with the base recorded in branch config.
    git(
      main,
      "worktree",
      "add",
      worktree,
      "-b",
      "feature/537-test",
      "feature/epic",
    );
    git(
      worktree,
      "config",
      "branch.feature/537-test.sequantBase",
      "feature/epic",
    );
  });

  afterEach(() => {
    // Order matters: worktree remove clears metadata before rmSync unlinks.
    try {
      git(main, "worktree", "remove", "--force", worktree);
    } catch {
      // Worktree may already be gone; cleanup is best-effort.
    }
    rmSync(origin, { recursive: true, force: true });
    rmSync(main, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("reads the recorded base through the worktree's shared config", () => {
    expect(resolveBaseRef(worktree)).toBe("origin/feature/epic");
  });

  it("detects zero-diff exec on a real custom-base worktree (primary #537 fix, end-to-end)", () => {
    // HEAD is identical to feature/epic; no new commits, no dirty work.
    expect(hasExecChanges(worktree)).toBe(false);
  });

  it("detects real work on top of the recorded base", () => {
    writeFileSync(join(worktree, "src/new.ts"), "export const n = 1;\n");
    git(worktree, "add", "src/new.ts");
    git(worktree, "commit", "-m", "feat: new work on epic");
    expect(hasExecChanges(worktree)).toBe(true);
  });
});
