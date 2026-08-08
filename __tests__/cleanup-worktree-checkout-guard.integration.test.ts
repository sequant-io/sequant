// Tests for the #910 sibling site in cleanup-worktree.sh — the post-cleanup
// "update main" step must not switch the main checkout's branch.
//
// Same root cause as new-feature.sh (see new-feature-checkout-guard
// .integration.test.ts): the pre-tool checkout guard (#901) inspects only the
// top-level Bash command, and `./scripts/cleanup-worktree.sh <branch>` carries
// no guarded git verb — yet the script ran `git checkout main` (plus
// `pull`/`rebase`) INTERNALLY in the main checkout, so a session that lost the
// lock could still yank the holder off its branch.
//
// The fix keeps the "refresh local main" feature without the branch switch:
// when the checkout already sits on main it updates in place exactly as
// before; on any other branch it fast-forwards the local `main` ref via
// `git fetch origin main:main`, which never touches the working tree, and
// skips (with a message) when that is not fast-forwardable. These tests drive
// the REAL script against throwaway git repos.
//
// `gh` is stubbed: `pr list` prints nothing, so PR_STATUS resolves empty
// ("not merged") and `--yes` carries the run past the confirmation gate.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SCRIPT = join(REPO_ROOT, "templates", "scripts", "cleanup-worktree.sh");

const FEATURE_BRANCH = "feature/777-cleanup-fixture";

let sandbox: string;
let repo: string;
let binDir: string;
let origin: string;
let worktree: string;

function git(args: string[], cwd = repo): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

/** Stub `gh` on PATH: `pr list` prints nothing (PR "not merged"), all else ok. */
function stubGh(): void {
  const p = join(binDir, "gh");
  writeFileSync(p, "#!/bin/bash\nexit 0\n");
  chmodSync(p, 0o755);
}

function runCleanup(extraArgs: string[] = []) {
  return spawnSync("bash", [SCRIPT, "--yes", ...extraArgs, FEATURE_BRANCH], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
  });
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

/** Advance origin/main by one commit via a separate clone; returns its new tip. */
function advanceOrigin(): string {
  const clone = join(sandbox, `clone-${Date.now()}`);
  spawnSync("git", ["clone", "-q", origin, clone]);
  initRepo(clone);
  writeFileSync(
    join(clone, `upstream-${Date.now()}.txt`),
    "landed on origin\n",
  );
  git(["add", "."], clone);
  git(["commit", "-q", "-m", "advance origin/main"], clone);
  git(["push", "-q", "origin", "main"], clone);
  return git(["rev-parse", "HEAD"], clone);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "cleanup-worktree-910-"));
  repo = join(sandbox, "repo");
  binDir = join(sandbox, "bin");
  origin = join(sandbox, "origin.git");
  worktree = join(sandbox, "worktrees", "feature", "777-cleanup-fixture");
  mkdirSync(repo, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  initRepo(repo);
  git(["remote", "add", "origin", origin]);
  writeFileSync(join(repo, ".keep"), "");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  git(["push", "-q", "-u", "origin", "main"]);

  // The worktree under cleanup, as new-feature.sh would have provisioned it.
  git(["worktree", "add", "-q", worktree, "-b", FEATURE_BRANCH]);

  stubGh();
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("cleanup-worktree.sh does not switch the main checkout's branch (#910)", () => {
  it("leaves an unrelated branch checked out, yet still tears down and ff-updates the main ref", () => {
    // Sit the main checkout on an unrelated branch at a distinct commit, with
    // a dirty tracked edit — the holder's state the guard is meant to protect.
    git(["checkout", "-q", "-b", "unrelated"]);
    writeFileSync(join(repo, ".keep"), "held by another session\n");
    const branchBefore = git(["symbolic-ref", "--short", "HEAD"]);
    const headBefore = git(["rev-parse", "HEAD"]);
    const dirtyBefore = git(["status", "--porcelain"]);
    expect(dirtyBefore).not.toBe("");

    // origin/main moves ahead so the ref update is observable.
    const originHead = advanceOrigin();
    expect(git(["rev-parse", "main"])).not.toBe(originHead);

    const r = runCleanup();
    expect(r.status).toBe(0);

    // The old `git checkout main` would have switched this to `main` and
    // aborted on the dirty tree. Branch, HEAD and dirt must all be untouched.
    expect(git(["symbolic-ref", "--short", "HEAD"])).toBe(branchBefore);
    expect(git(["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(["status", "--porcelain"])).toBe(dirtyBefore);

    // Teardown still happened: worktree gone, local feature branch gone.
    expect(existsSync(worktree)).toBe(false);
    expect(git(["branch", "--list", FEATURE_BRANCH])).toBe("");

    // And the "update main" feature survived: the local main REF was
    // fast-forwarded to origin/main without any checkout.
    expect(git(["rev-parse", "main"])).toBe(originHead);
  });

  it("still updates main in place when the checkout already sits on main", () => {
    const originHead = advanceOrigin();
    expect(git(["rev-parse", "main"])).not.toBe(originHead);

    const r = runCleanup();
    expect(r.status).toBe(0);

    // Pre-existing behavior preserved: on main, the ff-only pull lands the
    // working tree on the new origin tip.
    expect(git(["symbolic-ref", "--short", "HEAD"])).toBe("main");
    expect(git(["rev-parse", "HEAD"])).toBe(originHead);
    expect(existsSync(worktree)).toBe(false);
  });

  it("skips the main-ref update (without failing) when it is not fast-forwardable", () => {
    // Diverge: local main gains a commit origin never sees, origin advances too.
    writeFileSync(join(repo, "local-only.txt"), "local divergence\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "local-only commit on main"]);
    advanceOrigin();
    const localMain = git(["rev-parse", "main"]);

    // Park the checkout on an unrelated branch so the ref-only path runs.
    git(["checkout", "-q", "-b", "unrelated"]);

    const r = runCleanup();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Skipped local main update");

    // Nothing was forced: the diverged local main ref is exactly as it was,
    // and the checkout never moved.
    expect(git(["rev-parse", "main"])).toBe(localMain);
    expect(git(["symbolic-ref", "--short", "HEAD"])).toBe("unrelated");
    expect(existsSync(worktree)).toBe(false);
  });
});
