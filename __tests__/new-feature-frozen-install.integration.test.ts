// Tests for Issue #847 — new-feature.sh must resolve its frozen install from
// the project's detected package manager, not hardcode `npm ci`.
//
// The bug: `frozen_install()` ran `npm ci --silent` and its failure message
// named `package-lock.json` unconditionally. On a pnpm/yarn/bun project the
// shell provisioning path then ran `npm ci` against a non-npm lockfile and
// aborted with "package-lock.json out of sync" — a file the project doesn't
// use. The TypeScript path (#816) was already PM-aware via PM_CONFIG.ciInstall;
// this script was missed by that fix.
//
// These drive the REAL script against a real throwaway git repo. The package
// managers are stubbed on PATH so the "install" is captured (and its exit code
// controlled) without a network install — the command-capture harness the spec
// calls for. `gh` is stubbed so no GitHub call happens.
//
// A final drift-guard imports PM_CONFIG and asserts each JS ciInstall string is
// present in the script, so the two lockfile→command tables can't silently
// diverge (the same dual-producer drift class as #833).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PM_CONFIG } from "../src/lib/stacks";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SCRIPT = join(REPO_ROOT, "templates", "scripts", "new-feature.sh");

const ISSUE = "847";

let sandbox: string;
let repo: string;
let binDir: string;
let origin: string;

function git(args: string[], cwd = repo): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
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
  issue)  echo '{"number":${ISSUE},"title":"frozen install pm aware","labels":[]}' ;;
  *)      exit 0 ;;
esac
`,
  );
  chmodSync(p, 0o755);
}

/**
 * Stub a package-manager binary on PATH. It appends its full invocation to
 * `<pm>-calls.log` so a test can assert exactly what the script ran, then exits
 * with `exitCode` (1 simulates a lockfile-out-of-sync failure for AC-3).
 * It never touches node_modules or the lockfile, so the worktree stays clean.
 */
function stubPm(pm: string, exitCode = 0): void {
  const p = join(binDir, pm);
  writeFileSync(
    p,
    `#!/bin/bash
echo "${pm} $@" >> "${join(binDir, `${pm}-calls.log`)}"
exit ${exitCode}
`,
  );
  chmodSync(p, 0o755);
}

function callsFor(pm: string): string {
  const f = join(binDir, `${pm}-calls.log`);
  return existsSync(f) ? readFileSync(f, "utf8") : "";
}

/** Seed the repo with package.json and the given lockfile, committed to main. */
function seedProject(lockfile: string | null): void {
  writeFileSync(join(repo, "package.json"), '{"name":"fixture"}\n');
  if (lockfile) writeFileSync(join(repo, lockfile), "# lock\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "seed project"]);
  git(["push", "-q", "origin", "main"]);
}

function runNewFeature() {
  return spawnSync("bash", [SCRIPT, ISSUE], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
  });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "new-feature-847-"));
  repo = join(sandbox, "repo");
  binDir = join(sandbox, "bin");
  origin = join(sandbox, "origin.git");
  mkdirSync(repo, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  // Contributors with a global commit.gpgsign=true have no pinentry in a test
  // run; without this every commit dies "gpg: signing failed". Same line the
  // other script fixtures use.
  git(["config", "commit.gpgsign", "false"]);
  git(["remote", "add", "origin", origin]);
  writeFileSync(join(repo, ".keep"), "");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  git(["push", "-q", "-u", "origin", "main"]);

  stubGh();
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("new-feature.sh frozen install is package-manager aware (#847)", () => {
  it("AC-1/AC-2: a pnpm project runs `pnpm install --frozen-lockfile`, never `npm ci`", () => {
    seedProject("pnpm-lock.yaml");
    stubPm("pnpm", 0);
    stubPm("npm", 0);

    const r = runNewFeature();
    expect(r.status).toBe(0);

    expect(callsFor("pnpm")).toContain("pnpm install --frozen-lockfile");
    // The regression: `npm ci` fired regardless of package manager.
    expect(callsFor("npm")).toBe("");
  });

  it("AC-2: the provisioned worktree is left clean (no rewritten lockfile)", () => {
    seedProject("pnpm-lock.yaml");
    stubPm("pnpm", 0);

    const r = runNewFeature();
    expect(r.status).toBe(0);

    // The frozen install must not dirty the tree. A stray unstaged lockfile is
    // the #826/#760 cascade this whole mechanism exists to prevent.
    const wt = join(sandbox, "worktrees");
    const branchDir = spawnSync(
      "bash",
      ["-c", `ls -d ${wt}/feature/${ISSUE}-* | head -1`],
      { encoding: "utf8" },
    ).stdout.trim();
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: branchDir,
      encoding: "utf8",
    }).stdout.trim();
    expect(status).toBe("");
  });

  it("AC-1: an npm project (package-lock.json) still runs `npm ci`", () => {
    seedProject("package-lock.json");
    stubPm("npm", 0);

    const r = runNewFeature();
    expect(r.status).toBe(0);
    expect(callsFor("npm")).toContain("npm ci");
  });

  it("AC-1: a yarn project runs `yarn install --immutable`", () => {
    seedProject("yarn.lock");
    stubPm("yarn", 0);
    stubPm("npm", 0);

    const r = runNewFeature();
    expect(r.status).toBe(0);
    expect(callsFor("yarn")).toContain("yarn install --immutable");
    expect(callsFor("npm")).toBe("");
  });

  it("AC-3: a failed pnpm install names pnpm-lock.yaml, not package-lock.json", () => {
    seedProject("pnpm-lock.yaml");
    stubPm("pnpm", 1); // simulate lockfile out of sync

    const r = runNewFeature();
    expect(r.status).not.toBe(0);

    // Failure message must name the project's real lockfile and a pnpm recovery.
    expect(r.stderr).toContain("pnpm-lock.yaml");
    expect(r.stderr).toContain("pnpm install --lockfile-only");
    // And must NOT misdirect the user at an npm file they don't have.
    expect(r.stderr).not.toContain("package-lock.json");
    expect(r.stderr).not.toContain("npm install --package-lock-only");
  });

  it("gate: a project with no package.json skips install entirely (no npm ci)", () => {
    seedProject(null); // no package.json committed
    rmSync(join(repo, "package.json"));
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "remove manifest"]);
    git(["push", "-q", "origin", "main"]);
    stubPm("npm", 0);

    const r = runNewFeature();
    expect(r.status).toBe(0);
    // Without the package.json gate this fell through to `npm ci` on a repo
    // that isn't an npm project.
    expect(callsFor("npm")).toBe("");
  });

  // Drift guard: the shell case table must stay in lockstep with PM_CONFIG.
  // Editing a ciInstall string in the pm_ci_install() table fails exactly here.
  //
  // Scoped to the pm_ci_install() function body ONLY — the ciInstall strings
  // also appear in the file's explanatory comment, so a whole-file substring
  // match would be satisfied by that prose and pass even when the actual
  // command table is wrong (verified by mutation: pnpm→"npm ci" in the table
  // must fail this test, and against the whole file it did not). See the
  // "delimited region" rule in CLAUDE.md § Testing.
  it("drift guard: each JS ciInstall in PM_CONFIG appears verbatim in the pm_ci_install table", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const match = script.match(/pm_ci_install\(\)\s*\{([\s\S]*?)\n\}/);
    expect(
      match,
      "pm_ci_install() function not found in script",
    ).not.toBeNull();
    const table = match![1];
    for (const pm of ["npm", "pnpm", "yarn", "bun"] as const) {
      expect(table).toContain(PM_CONFIG[pm].ciInstall);
    }
  });
});
