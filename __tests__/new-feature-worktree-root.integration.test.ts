// Tests for Issue #1199 — new-feature.sh honours a configurable worktree root.
//
// Precedence mirrors resolveWorktreeRoot() in worktree-manager.ts:
// SEQUANT_WORKTREE_ROOT, then `run.worktreeRoot` in .sequant/settings.json
// (JSONC, read with a text pattern), then ../worktrees. These tests drive the
// REAL script against a throwaway repo with `gh` stubbed and no package.json,
// so dependency install is skipped.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SCRIPT = join(REPO_ROOT, "templates", "scripts", "new-feature.sh");

const ISSUE = "1199";
const BRANCH = `feature/${ISSUE}-custom-root`;

let sandbox: string;
let repo: string;
let binDir: string;

function git(args: string[], cwd = repo): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

function runNewFeature(envRoot?: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
  };
  delete env.SEQUANT_WORKTREE_ROOT;
  if (envRoot !== undefined) env.SEQUANT_WORKTREE_ROOT = envRoot;
  return spawnSync("bash", [SCRIPT, ISSUE], {
    cwd: repo,
    encoding: "utf8",
    env,
  });
}

function writeSettings(body: string): void {
  mkdirSync(join(repo, ".sequant"), { recursive: true });
  writeFileSync(join(repo, ".sequant", "settings.json"), body);
}

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "new-feature-1199-")));
  repo = join(sandbox, "repo");
  binDir = join(sandbox, "bin");
  const origin = join(sandbox, "origin.git");
  mkdirSync(repo, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["remote", "add", "origin", origin]);
  writeFileSync(join(repo, ".keep"), "");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  git(["push", "-q", "-u", "origin", "main"]);

  const gh = join(binDir, "gh");
  writeFileSync(
    gh,
    `#!/bin/bash
case "$1" in
  auth)   exit 0 ;;
  issue)  echo '{"number":${ISSUE},"title":"custom root","labels":[]}' ;;
  *)      exit 0 ;;
esac
`,
  );
  chmodSync(gh, 0o755);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("new-feature.sh worktree root (#1199)", () => {
  it("defaults to ../worktrees next to the repo", () => {
    const r = runNewFeature();
    expect(r.status, r.stderr).toBe(0);
    const wt = join(sandbox, "worktrees", BRANCH);
    expect(git(["branch", "--show-current"], wt)).toBe(BRANCH);
  });

  it("places the worktree under SEQUANT_WORKTREE_ROOT, over the setting", () => {
    writeSettings(`{ "run": { "worktreeRoot": "../from-settings" } }\n`);
    const envRoot = join(sandbox, "env-root");
    const r = runNewFeature(envRoot);
    expect(r.status, r.stderr).toBe(0);
    expect(git(["branch", "--show-current"], join(envRoot, BRANCH))).toBe(
      BRANCH,
    );
    expect(existsSync(join(sandbox, "from-settings"))).toBe(false);
    expect(existsSync(join(sandbox, "worktrees"))).toBe(false);
  });

  it("reads run.worktreeRoot from JSONC settings, ignoring a //-commented decoy", () => {
    writeSettings(`{
  // "worktreeRoot": "../decoy",
  "run": {
    // Where issue worktrees go
    "worktreeRoot":
      "../trees"
  }
}
`);
    const r = runNewFeature("   ");
    expect(r.status, r.stderr).toBe(0);
    expect(
      git(["branch", "--show-current"], join(sandbox, "trees", BRANCH)),
    ).toBe(BRANCH);
    expect(existsSync(join(sandbox, "decoy"))).toBe(false);
    expect(existsSync(join(sandbox, "worktrees"))).toBe(false);
  });
});
