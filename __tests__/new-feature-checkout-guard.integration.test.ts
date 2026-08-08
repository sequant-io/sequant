// Tests for Issue #910 — new-feature.sh must not mutate the main checkout.
//
// The bug: the pre-tool checkout guard (#901) inspects only the top-level Bash
// command an agent runs. `./scripts/new-feature.sh <issue>` carries no guarded
// git verb, so it passed the guard — and then ran `git checkout <base>` +
// `git pull` INTERNALLY, in the main checkout. A session that did not hold the
// checkout lock could thereby switch the holder's branch out from under it,
// which is precisely what #901 exists to prevent.
//
// The fix (issue option 2) removes the mutation: the worktree is branched
// directly off the freshly fetched `origin/<base>` via
// `git worktree add -b <branch> <path> origin/<base>`, which resolves the ref
// without ever checking out or pulling into the main tree. These tests drive
// the REAL script against throwaway git repos and assert, behaviorally, that
// the main checkout's branch/HEAD/working-tree are untouched and that the
// worktree is branched off the up-to-date remote ref.
//
// `gh` is stubbed so no GitHub call happens. No package.json is seeded, so the
// dependency-install block is skipped entirely — these tests exercise the
// worktree-creation path, not provisioning.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SCRIPT = join(REPO_ROOT, "templates", "scripts", "new-feature.sh");

const ISSUE = "910";

let sandbox: string;
let repo: string;
let binDir: string;
let origin: string;

function git(args: string[], cwd = repo): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

/**
 * Stub `gh` on PATH: `auth status` succeeds and `issue view --json ...` returns
 * a minimal issue so the script can build a branch name. No network, no real gh.
 */
function stubGh(): void {
  const p = join(binDir, "gh");
  writeFileSync(
    p,
    `#!/bin/bash
case "$1" in
  auth)   exit 0 ;;
  issue)  echo '{"number":${ISSUE},"title":"checkout guard","labels":[]}' ;;
  *)      exit 0 ;;
esac
`,
  );
  chmodSync(p, 0o755);
}

function runNewFeature(extraArgs: string[] = []) {
  return spawnSync("bash", [SCRIPT, ISSUE, ...extraArgs], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
  });
}

/** Absolute path of the worktree the script provisions for ISSUE. */
function worktreeDir(): string {
  return spawnSync(
    "bash",
    ["-c", `ls -d ${join(sandbox, "worktrees")}/feature/${ISSUE}-* | head -1`],
    { encoding: "utf8" },
  ).stdout.trim();
}

/** Configure a fresh throwaway repo the same way the frozen-install fixture does. */
function initRepo(cwd: string): void {
  git(["init", "-q", "-b", "main"], cwd);
  git(["config", "user.email", "t@example.com"], cwd);
  git(["config", "user.name", "t"], cwd);
  // Contributors with a global commit.gpgsign=true have no pinentry in a test
  // run; without this every commit dies "gpg: signing failed".
  git(["config", "commit.gpgsign", "false"], cwd);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "new-feature-910-"));
  repo = join(sandbox, "repo");
  binDir = join(sandbox, "bin");
  origin = join(sandbox, "origin.git");
  mkdirSync(repo, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  initRepo(repo);
  git(["remote", "add", "origin", origin]);
  // A repo with no package.json: the script skips dependency install, so these
  // tests never touch a package manager or the network.
  writeFileSync(join(repo, ".keep"), "");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  git(["push", "-q", "-u", "origin", "main"]);

  stubGh();
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("new-feature.sh does not mutate the main checkout (#910)", () => {
  it("leaves the main checkout's branch and HEAD untouched", () => {
    // Sit the main checkout on an unrelated branch at a distinct commit — the
    // holder's branch the guard is meant to protect.
    git(["checkout", "-q", "-b", "unrelated"]);
    writeFileSync(join(repo, "unrelated.txt"), "held by another session\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "unrelated work"]);
    const branchBefore = git(["symbolic-ref", "--short", "HEAD"]);
    const headBefore = git(["rev-parse", "HEAD"]);

    const r = runNewFeature();
    expect(r.status).toBe(0);

    // The old `git checkout <base>` would have switched this to `main`.
    expect(git(["symbolic-ref", "--short", "HEAD"])).toBe(branchBefore);
    expect(git(["rev-parse", "HEAD"])).toBe(headBefore);

    // And the worktree was still created, on the feature branch.
    const wt = worktreeDir();
    expect(wt).not.toBe("");
    expect(git(["symbolic-ref", "--short", "HEAD"], wt)).toBe(
      `feature/${ISSUE}-checkout-guard`,
    );
  });

  it("creates the worktree even when the main checkout has a dirty working tree", () => {
    git(["checkout", "-q", "-b", "unrelated"]);
    // Uncommitted changes: both a modified tracked file and an untracked one.
    writeFileSync(join(repo, ".keep"), "dirty edit\n");
    writeFileSync(join(repo, "scratch.txt"), "untracked scratch\n");
    const dirtyBefore = git(["status", "--porcelain"]);
    expect(dirtyBefore).not.toBe("");

    const r = runNewFeature();
    // The old dirty-tree guard exited 1 here without --stash; worktree
    // creation must now succeed regardless.
    expect(r.status).toBe(0);
    expect(worktreeDir()).not.toBe("");

    // The dirty changes are left exactly as they were — nothing stashed away.
    expect(git(["status", "--porcelain"])).toBe(dirtyBefore);
  });

  it("branches the worktree off the freshly fetched origin/<base>, not the stale local base", () => {
    // Advance origin/main past the local checkout via a separate clone, so the
    // local `main` ref is behind. A fix that branched off local `main` (or that
    // pulled into it) would diverge from a fix that reads the fetched remote.
    const clone = join(sandbox, "clone");
    spawnSync("git", ["clone", "-q", origin, clone]);
    initRepo(clone); // re-apply user/gpg config in the clone
    writeFileSync(join(clone, "upstream.txt"), "landed on origin/main\n");
    git(["add", "."], clone);
    git(["commit", "-q", "-m", "advance origin/main"], clone);
    git(["push", "-q", "origin", "main"], clone);
    const originHead = git(["rev-parse", "HEAD"], clone);

    // Local main is still at the old commit and must stay there.
    const localMainBefore = git(["rev-parse", "main"]);
    expect(localMainBefore).not.toBe(originHead);

    const r = runNewFeature();
    expect(r.status).toBe(0);

    // Worktree is based on the fetched origin/main tip.
    expect(git(["rev-parse", "HEAD"], worktreeDir())).toBe(originHead);
    // Local main was never pulled into — the script does not touch it.
    expect(git(["rev-parse", "main"])).toBe(localMainBefore);
  });

  it("accepts the deprecated --stash flag as a no-op without failing", () => {
    git(["checkout", "-q", "-b", "unrelated"]);
    writeFileSync(join(repo, ".keep"), "dirty edit\n");

    const r = runNewFeature(["--stash"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--stash is deprecated");
    // Nothing was stashed: the dirty edit is still in the working tree.
    expect(git(["status", "--porcelain"])).not.toBe("");
    expect(git(["stash", "list"])).toBe("");
  });
});
