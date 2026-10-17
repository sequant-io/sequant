// Tests for Issue #1486 — new-feature.sh starts a new worktree from
// origin/<branch> when the remote already has the issue's branch.
//
// The script's start-ref helper is a bash port of resolveBranchStartRef() in
// worktree-manager.ts. AC-1/AC-3 drive the REAL script with `gh` stubbed; the
// parity cases compare `--print-start-ref` with the TS function on the same repo.

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
import { resolveBranchStartRef } from "../src/lib/workflow/worktree-manager.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SCRIPT = join(REPO_ROOT, "templates", "scripts", "new-feature.sh");

const ISSUE = "77";
const BRANCH = `feature/${ISSUE}-add-widget`;
const BASE = "origin/main";
const GERMAN = "de_DE.UTF-8";

let sandbox: string;
let origin: string;
let seed: string;
let repo: string;
let binDir: string;

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
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

function printStartRef(env: NodeJS.ProcessEnv = process.env): string {
  const r = spawnSync("bash", [SCRIPT, "--print-start-ref", BRANCH, BASE], {
    cwd: repo,
    encoding: "utf8",
    env,
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

function runScript() {
  return spawnSync("bash", [SCRIPT, ISSUE], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
  });
}

// Fixtures build the remote state in `seed`, then clone it into `repo`.
function cloneRepo(): void {
  spawnSync("git", ["clone", "-q", origin, repo]);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
}

function pushFeature(): void {
  git(["checkout", "-q", "-b", BRANCH], seed);
  commitFile(seed, "widget.txt", "add widget");
  git(["push", "-q", "origin", BRANCH], seed);
  git(["checkout", "-q", "main"], seed);
}

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "new-feature-1486-")));
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

describe("new-feature.sh start ref (#1486)", () => {
  it("AC-1: starts from origin/<branch> and tracks it when the remote has an unmerged branch", () => {
    pushFeature();
    cloneRepo();

    const r = runScript();
    expect(r.status, r.stderr).toBe(0);

    const wt = join(sandbox, "worktrees", BRANCH);
    expect(git(["rev-parse", "HEAD"], wt)).toBe(
      git(["rev-parse", `origin/${BRANCH}`], repo),
    );
    expect(git(["config", `branch.${BRANCH}.remote`], wt)).toBe("origin");
    expect(git(["config", `branch.${BRANCH}.merge`], wt)).toBe(
      `refs/heads/${BRANCH}`,
    );
    expect(git(["config", `branch.${BRANCH}.sequantBase`], wt)).toBe("main");
  });

  it("AC-3: starts from origin/<base> and records sequantBase when the remote has no branch", () => {
    cloneRepo();

    const r = runScript();
    expect(r.status, r.stderr).toBe(0);

    const wt = join(sandbox, "worktrees", BRANCH);
    expect(git(["rev-parse", "HEAD"], wt)).toBe(
      git(["rev-parse", "origin/main"], repo),
    );
    expect(git(["config", `branch.${BRANCH}.sequantBase`], wt)).toBe("main");
  });

  describe("parity with resolveBranchStartRef", () => {
    function expectParity(
      expected: string,
      env: NodeJS.ProcessEnv = process.env,
    ): void {
      const script = printStartRef(env);
      const ts = resolveBranchStartRef(repo, BRANCH, BASE);
      expect(script).toBe(ts);
      expect(script).toBe(expected);
    }

    it("unmerged remote branch -> origin/<branch>", () => {
      pushFeature();
      cloneRepo();
      expectParity(`origin/${BRANCH}`);
    });

    it("squash-merged remote branch -> base", () => {
      pushFeature();
      // Same change lands on main as a different commit (a squash merge).
      commitFile(seed, "widget.txt", "add widget");
      git(["push", "-q", "origin", "main"], seed);
      cloneRepo();
      expectParity(BASE);
    });

    it("merge-commit-merged remote branch -> base", () => {
      pushFeature();
      git(["merge", "-q", "--no-ff", "-m", "merge", BRANCH], seed);
      git(["push", "-q", "origin", "main"], seed);
      cloneRepo();
      expectParity(BASE);
    });

    it("deleted remote branch with a stale tracking ref -> base", () => {
      pushFeature();
      cloneRepo();
      git(["push", "-q", "origin", `:${BRANCH}`], seed);
      // The stale tracking ref is still there; only the fetch tells it is gone.
      expect(git(["rev-parse", "--verify", `origin/${BRANCH}`], repo)).toMatch(
        /^[0-9a-f]{40}$/,
      );
      expectParity(BASE);
    });

    // A missing locale makes git fall back to English, which would pass the
    // case without the script's LC_ALL=C. Skip loudly unless git is German.
    const germanProbe = spawnSync(
      "git",
      ["fetch", "/nonexistent-1486-repo", "nope"],
      { encoding: "utf8", env: { ...process.env, LC_ALL: GERMAN } },
    );
    const gitIsGerman = !(germanProbe.stderr ?? "").includes("fatal:");
    if (!gitIsGerman) {
      console.warn(
        `SKIPPED parity under ${GERMAN}: git prints English here, so the case would pass vacuously`,
      );
    }

    it.skipIf(!gitIsGerman)(
      "deleted remote branch under LC_ALL=de_DE.UTF-8 -> base",
      () => {
        pushFeature();
        cloneRepo();
        git(["push", "-q", "origin", `:${BRANCH}`], seed);
        const german = { ...process.env, LC_ALL: GERMAN };
        // Precondition: in this locale git's message is not the English one.
        const probe = spawnSync("git", ["fetch", "origin", BRANCH], {
          cwd: repo,
          encoding: "utf8",
          env: german,
        });
        expect(probe.stderr).not.toContain("couldn't find remote ref");
        expectParity(BASE, german);
      },
    );
  });
});
