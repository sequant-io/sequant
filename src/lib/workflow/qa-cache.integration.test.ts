/**
 * Real-git regression tests for the QA cache's diff base (#890).
 *
 * The unit suite (qa-cache.test.ts) mocks git entirely; these tests build
 * actual repositories because the #890 defect only manifests against real
 * ref state: a worktree created from `origin/<base>` while the local
 * `<base>` ref is deliberately behind. Pre-fix, the cache keyed and scoped
 * itself on `main...HEAD`, so merged-upstream content leaked into the diff
 * hash and the changed-file lists.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as crypto from "crypto";
import { QACache } from "./qa-cache.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

/** Configure identity so commits work under the hermetic git config. */
function initRepo(path: string): void {
  execFileSync("git", ["init", "-b", "main", path], { stdio: "pipe" });
  git(path, "config", "user.name", "test");
  git(path, "config", "user.email", "test@example.com");
}

function commitFile(repo: string, file: string, content: string): string {
  writeFileSync(join(repo, file), content);
  git(repo, "add", file);
  git(repo, "commit", "-m", `add ${file}`);
  return git(repo, "rev-parse", "HEAD");
}

/** The cache's hash of an empty diff (sha256 of "" truncated to 16 chars). */
const EMPTY_DIFF_HASH = crypto
  .createHash("sha256")
  .update("")
  .digest("hex")
  .slice(0, 16);

describe("qa-cache integration (#890)", () => {
  let root: string;
  let origin: string;
  let seed: string;
  let local: string;
  let worktree: string;
  let cache: QACache;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qa-cache-890-"));
    origin = join(root, "origin.git");
    seed = join(root, "seed");
    local = join(root, "local");
    worktree = join(root, "wt");

    // Bare "remote" plus a seed clone that populates it.
    execFileSync("git", ["init", "--bare", "-b", "main", origin], {
      stdio: "pipe",
    });
    initRepo(seed);
    commitFile(seed, "base.txt", "base\n");
    git(seed, "remote", "add", "origin", origin);
    git(seed, "push", "-u", "origin", "main");

    // The "project" clone — its local main is about to go stale.
    execFileSync("git", ["clone", origin, local], { stdio: "pipe" });
    git(local, "config", "user.name", "test");
    git(local, "config", "user.email", "test@example.com");

    // Advance origin/main past the local clone's main with commits that
    // would trip the cache's invalidation rules if misattributed: a global
    // invalidation file (package.json) and a type-specific one (.ts).
    writeFileSync(join(seed, "package.json"), '{"name":"upstream-bump"}\n');
    writeFileSync(join(seed, "upstream.ts"), "export const merged = true;\n");
    git(seed, "add", "package.json", "upstream.ts");
    git(seed, "commit", "-m", "merged upstream after last pull");
    git(seed, "push", "origin", "main");

    // Worktree creation fetches and branches from origin/<base>, exactly
    // like worktree-manager does. Local main deliberately stays behind.
    git(local, "fetch", "origin");
    git(
      local,
      "worktree",
      "add",
      "-b",
      "feature/890-test",
      worktree,
      "origin/main",
    );

    cache = new QACache({
      cacheDir: join(root, "cache"),
      cwd: worktree,
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("fixture precondition: local main is behind, worktree sits at origin tip", () => {
    const localMain = git(local, "rev-parse", "main");
    const originMain = git(local, "rev-parse", "origin/main");
    expect(localMain).not.toBe(originMain);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(originMain);
  });

  describe("computeDiffHash (AC-1)", () => {
    it("hashes an empty diff for a fresh worktree when local main is behind", () => {
      // Pre-#890: main...HEAD resolved to the stale local main, so the hash
      // covered the merged-upstream commit's content instead of "".
      expect(cache.computeDiffHash()).toBe(EMPTY_DIFF_HASH);
    });

    it("changes once the branch has its own work", () => {
      commitFile(worktree, "feature.txt", "real work\n");
      expect(cache.computeDiffHash()).not.toBe(EMPTY_DIFF_HASH);
    });
  });

  describe("changed-file scoping (AC-1)", () => {
    it("does not globally invalidate on upstream package.json churn", async () => {
      // Pre-#890: the stale base attributed the upstream package.json commit
      // to this (empty) branch and forced a spurious global invalidation.
      expect(await cache.checkGlobalInvalidation()).toBe(false);
    });

    it("does not type-invalidate on upstream .ts churn", async () => {
      expect(await cache.checkTypeSpecificInvalidation("type-safety")).toBe(
        false,
      );
    });

    it("still invalidates on the branch's own changes", async () => {
      commitFile(worktree, "package.json", '{"name":"branch-change"}\n');
      expect(await cache.checkGlobalInvalidation()).toBe(true);
    });
  });

  describe("cwd is honored for incremental diffs", () => {
    it("diffs since a commit inside the configured repo, not process.cwd()", () => {
      const base = git(worktree, "rev-parse", "HEAD");
      commitFile(worktree, "feature.txt", "real work\n");
      // process.cwd() here is the sequant repo, where these SHAs don't
      // exist — only the injected cwd can satisfy this.
      expect(cache.getChangedFilesSince(base)).toEqual(["feature.txt"]);
      expect(cache.computeIncrementalDiffHash(base)).toMatch(/^[a-f0-9]{16}$/);
    });
  });
});
