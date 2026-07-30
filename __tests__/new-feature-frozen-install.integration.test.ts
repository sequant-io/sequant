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
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  mkdirSync,
  symlinkSync,
  lstatSync,
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

function runNewFeature(extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ISSUE], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...extraEnv },
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
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: worktreeDir(),
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

  it("AC-1: a bun project runs `bun install --frozen-lockfile`", () => {
    seedProject("bun.lockb");
    stubPm("bun", 0);
    stubPm("npm", 0);

    const r = runNewFeature();
    expect(r.status).toBe(0);
    expect(callsFor("bun")).toContain("bun install --frozen-lockfile");
    expect(callsFor("npm")).toBe("");
  });

  it("AC-3: a bun.lock-only project names bun.lock, not bun.lockb", () => {
    // pm_lockfile's bun arm is the one table entry with real branching: a bun
    // project may commit either lockfile, and the failure message must name
    // the one actually present.
    seedProject("bun.lock");
    stubPm("bun", 1); // simulate lockfile out of sync

    const r = runNewFeature();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("bun.lock");
    expect(r.stderr).not.toContain("bun.lockb");
  });

  it("npm keeps its pre-#847 quiet install (`npm ci --silent`)", () => {
    // #847 resolved the command from PM_CONFIG.ciInstall, which is bare
    // `npm ci` — silently dropping the `--silent` this script ran before and
    // making every npm provisioning noisier. The flag belongs at the call
    // site so the drift guard still matches ciInstall verbatim.
    seedProject("package-lock.json");
    stubPm("npm", 0);

    const r = runNewFeature();
    expect(r.status).toBe(0);
    expect(callsFor("npm")).toContain("npm ci --silent");
  });

  it("the next-steps hint uses the detected PM's run command, not `npm run`", () => {
    seedProject("pnpm-lock.yaml");
    stubPm("pnpm", 0);

    const r = runNewFeature();
    expect(r.status).toBe(0);
    // Anchored on the step number: "pnpm run dev" contains "npm run dev", so a
    // bare not.toContain("npm run dev") can never pass.
    expect(r.stdout).toContain("2. pnpm run dev");
    expect(r.stdout).not.toContain("2. npm run dev");
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

  it("AC-3: a manifest-only project (no lockfile) is told the lockfile is MISSING, not out of sync", () => {
    // package.json with no lockfile falls back to npm, and `npm ci` fails
    // because it requires a lockfile. "The committed package-lock.json is out
    // of sync" describes a file that doesn't exist; the message must say the
    // lockfile is missing instead. The recovery command is right either way —
    // `npm install --package-lock-only` generates the file.
    seedProject(null); // package.json only
    stubPm("npm", 1); // npm ci fails: no lockfile to install from
    stubPm("pnpm", 0);

    const r = runNewFeature();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("No package-lock.json found");
    expect(r.stderr).not.toContain("out of sync");
    // Recovery command still points at generating + committing the lockfile.
    expect(r.stderr).toContain("npm install --package-lock-only");
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

  // The SEQUANT_NPM_CACHE branch. Opt-in, and before #847 it was effectively
  // npm-only: on a pnpm/yarn/bun project it hashed a missing package-lock.json,
  // which aborts under `set -e` on macOS (`md5 -q`) and caches an empty hash on
  // Linux (`md5sum | cut` swallows the failure). Fixing it made the branch
  // reachable for those PMs for the first time, so it needs its own coverage.
  describe("SEQUANT_NPM_CACHE branch", () => {
    const CACHE_ENV = { SEQUANT_NPM_CACHE: "true" };

    /**
     * Where the script keeps its cache, relative to the main repo. The hash
     * file is keyed by the repo's basename ("repo" in this fixture): the
     * `.npm-cache` dir is shared by every project under the same parent, and
     * an unkeyed hash file made sibling projects thrash each other's cache.
     */
    function hashFile(): string {
      return join(sandbox, "worktrees", ".npm-cache", ".lockfile-hash-repo");
    }

    it("hashes the RESOLVED lockfile on a pnpm project and installs with pnpm", () => {
      seedProject("pnpm-lock.yaml");
      // node_modules must be absent from the worktree but present in the main
      // repo for the cache paths to be exercised at all.
      mkdirSync(join(repo, "node_modules"), { recursive: true });
      stubPm("pnpm", 0);
      stubPm("npm", 0);

      const r = runNewFeature(CACHE_ENV);
      expect(r.status).toBe(0);
      expect(callsFor("pnpm")).toContain("pnpm install --frozen-lockfile");
      expect(callsFor("npm")).toBe("");

      // The hash must be the pnpm lockfile's, not an empty string standing in
      // for a package-lock.json the project doesn't have.
      const expected = createHash("md5")
        .update(readFileSync(join(repo, "pnpm-lock.yaml")))
        .digest("hex");
      expect(existsSync(hashFile())).toBe(true);
      expect(readFileSync(hashFile(), "utf8").trim()).toBe(expected);
    });

    it("reuses cached node_modules on a hash hit and preserves symlinks (cp -R)", () => {
      seedProject("pnpm-lock.yaml");
      stubPm("pnpm", 0);

      // A pnpm node_modules is a farm of relative symlinks into .pnpm/. BSD
      // `cp -r` dereferences them — expanding the copy and failing outright on
      // a dangling link, which `set -e` turns into a half-provisioned worktree.
      const nm = join(repo, "node_modules");
      mkdirSync(join(nm, ".pnpm", "dep@1.0.0", "node_modules", "dep"), {
        recursive: true,
      });
      writeFileSync(
        join(nm, ".pnpm", "dep@1.0.0", "node_modules", "dep", "index.js"),
        "module.exports = 1;\n",
      );
      symlinkSync(".pnpm/dep@1.0.0/node_modules/dep", join(nm, "dep"));

      // Pre-seed a matching hash so the run takes the cache-HIT path.
      const hash = createHash("md5")
        .update(readFileSync(join(repo, "pnpm-lock.yaml")))
        .digest("hex");
      mkdirSync(join(sandbox, "worktrees", ".npm-cache"), { recursive: true });
      writeFileSync(hashFile(), `${hash}\n`);

      const r = runNewFeature(CACHE_ENV);
      expect(r.status).toBe(0);
      // Cache hit ⇒ no install at all.
      expect(callsFor("pnpm")).toBe("");

      const copied = join(worktreeDir(), "node_modules", "dep");
      expect(lstatSync(copied).isSymbolicLink()).toBe(true);
      // Relative link ⇒ still resolves inside the copy.
      expect(existsSync(join(copied, "index.js"))).toBe(true);
    });

    it("ignores an unkeyed (shared) hash file left by another project", () => {
      // `../worktrees/.npm-cache` is shared by every repo under the same
      // parent directory. Before the per-project keying, a sibling project's
      // run overwrote the single `.lockfile-hash`, making the two projects
      // alternate cache misses forever. Pin the keying: a stale SHARED-name
      // file — even one whose content happens to match this project's hash —
      // must not be read as a cache hit.
      seedProject("pnpm-lock.yaml");
      mkdirSync(join(repo, "node_modules"), { recursive: true });
      stubPm("pnpm", 0);

      const hash = createHash("md5")
        .update(readFileSync(join(repo, "pnpm-lock.yaml")))
        .digest("hex");
      mkdirSync(join(sandbox, "worktrees", ".npm-cache"), { recursive: true });
      writeFileSync(
        join(sandbox, "worktrees", ".npm-cache", ".lockfile-hash"),
        `${hash}\n`,
      );

      const r = runNewFeature(CACHE_ENV);
      expect(r.status).toBe(0);
      // The shared file is not this project's cache: a real install must run,
      // and the keyed hash file must be written alongside the stale one.
      expect(callsFor("pnpm")).toContain("pnpm install --frozen-lockfile");
      expect(readFileSync(hashFile(), "utf8").trim()).toBe(hash);
    });

    it("does not abort on a non-npm project whose lockfile hash is unavailable", () => {
      // The pre-#847 failure mode, pinned: a yarn project with the cache on
      // must fall through to a normal frozen install, not die in the hasher.
      seedProject("yarn.lock");
      stubPm("yarn", 0);

      const r = runNewFeature(CACHE_ENV);
      expect(r.status).toBe(0);
      expect(callsFor("yarn")).toContain("yarn install --immutable");
    });
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

  // Same guard for the run-script table behind the next-steps hint. Scoped to
  // pm_run()'s body for the same reason: `npm run` appears in prose elsewhere.
  it("drift guard: each JS run prefix in PM_CONFIG appears verbatim in the pm_run table", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const match = script.match(/pm_run\(\)\s*\{([\s\S]*?)\n\}/);
    expect(match, "pm_run() function not found in script").not.toBeNull();
    const table = match![1];
    for (const pm of ["npm", "pnpm", "yarn", "bun"] as const) {
      expect(table).toContain(PM_CONFIG[pm].run);
    }
  });
});
