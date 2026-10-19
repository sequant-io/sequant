// Tests for Issue #1491 — new-feature.sh reuses the issue's local branch when no
// worktree has it checked out, as ensureWorktree does (check out as is).
// Drives the REAL script with `gh` stubbed.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(
  resolve(HERE, ".."),
  "templates",
  "scripts",
  "new-feature.sh",
);

const ISSUE = "77";
const BRANCH = `feature/${ISSUE}-add-widget`;

let sandbox: string;
let origin: string;
let seed: string;
let repo: string;
let binDir: string;

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

function commitFile(cwd: string, file: string, msg: string): void {
  writeFileSync(join(cwd, file), `${msg}\n`);
  git(["add", file], cwd);
  git(["commit", "-q", "-m", msg], cwd);
}

function runScript() {
  return spawnSync("bash", [SCRIPT, ISSUE], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
  });
}

function cloneRepo(): void {
  spawnSync("git", ["clone", "-q", origin, repo]);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
}

/** Local branch with one commit, cut from main, no worktree. Returns its tip. */
function localBranch(): string {
  git(["branch", BRANCH, "main"], repo);
  git(["checkout", "-q", BRANCH], repo);
  commitFile(repo, "widget.txt", "feat: widget");
  git(["checkout", "-q", "main"], repo);
  return git(["rev-parse", BRANCH], repo);
}

const wtPath = () => join(sandbox, "worktrees", BRANCH);

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "new-feature-1491-")));
  origin = join(sandbox, "origin.git");
  seed = join(sandbox, "seed");
  repo = join(sandbox, "repo");
  binDir = join(sandbox, "bin");
  mkdirSync(seed, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git(["init", "-q", "-b", "main"], seed);
  git(["config", "user.email", "t@example.com"], seed);
  git(["config", "user.name", "t"], seed);
  git(["config", "commit.gpgsign", "false"], seed);
  git(["remote", "add", "origin", origin], seed);
  commitFile(seed, ".keep", "init");
  git(["push", "-q", "-u", "origin", "main"], seed);
  cloneRepo();

  const gh = join(binDir, "gh");
  writeFileSync(
    gh,
    `#!/bin/bash
case "$1" in
  auth)   exit 0 ;;
  issue)  echo '{"number":${ISSUE},"title":"add widget","labels":[]}' ;;
  *)      exit 0 ;;
esac
`,
  );
  chmodSync(gh, 0o755);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("new-feature.sh existing local branch (#1491)", () => {
  it("local branch without a worktree: creates the worktree on it and exits 0", () => {
    const tip = localBranch();

    const r = runScript();
    expect(r.status, r.stdout + r.stderr).toBe(0);

    expect(git(["rev-parse", "HEAD"], wtPath())).toBe(tip);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], wtPath())).toBe(BRANCH);
    expect(git(["rev-parse", BRANCH], repo)).toBe(tip);
  });

  describe("existing-branch parity", () => {
    function pushBranchTo(commits: number): string {
      git(["checkout", "-q", "-b", BRANCH], seed);
      for (let i = 0; i < commits; i++) {
        commitFile(seed, `w${i}.txt`, `remote ${i}`);
      }
      git(["push", "-q", "origin", BRANCH], seed);
      git(["checkout", "-q", "main"], seed);
      return git(["rev-parse", BRANCH], seed);
    }

    it("local-only branch -> local tip", () => {
      const tip = localBranch();
      expect(runScript().status).toBe(0);
      expect(git(["rev-parse", "HEAD"], wtPath())).toBe(tip);
    });

    it("local branch equal to origin/<branch> -> local tip", () => {
      pushBranchTo(1);
      git(["fetch", "-q", "origin"], repo);
      git(["branch", BRANCH, `origin/${BRANCH}`], repo);
      const tip = git(["rev-parse", BRANCH], repo);

      expect(runScript().status).toBe(0);
      expect(git(["rev-parse", "HEAD"], wtPath())).toBe(tip);
    });

    it("local branch behind origin/<branch> -> local tip, not origin's", () => {
      pushBranchTo(2);
      git(["fetch", "-q", "origin"], repo);
      git(["branch", BRANCH, `origin/${BRANCH}~1`], repo);
      const tip = git(["rev-parse", BRANCH], repo);
      expect(tip).not.toBe(git(["rev-parse", `origin/${BRANCH}`], repo));

      const r = runScript();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(git(["rev-parse", "HEAD"], wtPath())).toBe(tip);
      expect(git(["rev-parse", BRANCH], repo)).toBe(tip);
    });
  });

  describe("worktree already checked out", () => {
    it("prints the existing path and exits 0", () => {
      localBranch();
      const elsewhere = join(sandbox, "elsewhere");
      git(["worktree", "add", elsewhere, BRANCH], repo);

      const r = runScript();
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(elsewhere);
    });

    it("does not take a longer branch name for the issue's branch", () => {
      localBranch();
      const longer = `${BRANCH}y`;
      git(["branch", longer, "main"], repo);
      git(["worktree", "add", join(sandbox, "other"), longer], repo);

      const r = runScript();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(git(["rev-parse", "--abbrev-ref", "HEAD"], wtPath())).toBe(BRANCH);
    });
  });

  it("no local branch: takes the creation path from origin/main", () => {
    const r = runScript();
    expect(r.status, r.stderr).toBe(0);
    expect(git(["rev-parse", "HEAD"], wtPath())).toBe(
      git(["rev-parse", "origin/main"], repo),
    );
    expect(git(["config", `branch.${BRANCH}.sequantBase`], wtPath())).toBe(
      "main",
    );
  });
});
