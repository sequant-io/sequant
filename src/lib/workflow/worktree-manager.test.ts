/**
 * #1069: rebaseBeforePR must not rewrite commits that exist on the remote.
 * Real git throughout (bare remote + clone + feature worktree), no mocks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  rebaseBeforePR,
  installWorktreeDeps,
  buildAutomatedPRBody,
  resolvePrLinkMode,
} from "./worktree-manager.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const commitFile = (cwd: string, name: string, msg: string): void => {
  writeFileSync(join(cwd, name), `${msg}\n`);
  git(cwd, "add", name);
  git(cwd, "commit", "-q", "-m", msg);
};

describe("#1069 rebaseBeforePR merges pushed branches", () => {
  let root: string;
  let clone: string;
  let wt: string;
  let logs: string[];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "seq-1069-")));
    const remote = join(root, "remote.git");
    clone = join(root, "clone");
    wt = join(root, "wt");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    git(root, "clone", "-q", remote, clone);
    // CI runners have no deducible git identity (macOS fills one from GECOS,
    // the Linux runner does not); every commit below needs it, so set it first.
    git(clone, "config", "user.name", "sequant-test");
    git(clone, "config", "user.email", "sequant-test@example.com");
    git(clone, "checkout", "-q", "-b", "main");
    commitFile(clone, "base.txt", "base");
    git(clone, "push", "-q", "origin", "main");
    // Same shape as ensureWorktree: branch off origin/main (sets upstream).
    git(clone, "worktree", "add", "-q", "-b", "feat", wt, "origin/main");
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  /** Advance origin/main from the main clone. */
  const advanceMain = (name = "main-advance.txt"): void => {
    commitFile(clone, name, `advance ${name}`);
    git(clone, "push", "-q", "origin", "main");
  };

  const stripAnsi = (s: string): string =>
    // eslint-disable-next-line no-control-regex
    s.replace(/\u001b\[[0-9;]*m/g, "");

  it("pushed branch merges and keeps SHAs", () => {
    commitFile(wt, "a.txt", "feat one");
    commitFile(wt, "b.txt", "feat two");
    git(wt, "push", "-q", "-u", "origin", "feat");
    const pushed = git(wt, "rev-list", "origin/feat").split("\n");
    advanceMain();

    const result = rebaseBeforePR(wt, 1069, undefined, false);

    expect(result.success).toBe(true);
    expect(result.strategy).toBe("merge");
    // Every pushed SHA is still in HEAD's history, unchanged.
    for (const sha of pushed) {
      expect(() =>
        git(wt, "merge-base", "--is-ancestor", sha, "HEAD"),
      ).not.toThrow();
    }
    expect(git(wt, "rev-parse", "HEAD^1")).toBe(pushed[0]);
    expect(
      git(wt, "rev-list", "--merges", "--count", "origin/feat..HEAD"),
    ).toBe("1");
    // Fast-forwardable: main's commit + the merge are ahead, nothing behind.
    expect(git(wt, "status", "-sb").split("\n")[0]).not.toContain("behind");
  });

  it("no upstream rebases", () => {
    // Never pushed and created without tracking.
    git(wt, "branch", "--unset-upstream");
    commitFile(wt, "a.txt", "feat one");
    advanceMain();

    const result = rebaseBeforePR(wt, 1069, undefined, false);

    expect(result.success).toBe(true);
    expect(result.strategy).toBe("rebase");
    expect(
      git(wt, "rev-list", "--merges", "--count", "origin/main..HEAD"),
    ).toBe("0");
    expect(git(wt, "rev-parse", "HEAD~1")).toBe(
      git(wt, "rev-parse", "origin/main"),
    );
  });

  it("fresh worktree branch tracking origin/main still rebases", () => {
    // Upstream is origin/main (set by `worktree add -b … origin/main`).
    expect(git(wt, "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/main");
    commitFile(wt, "a.txt", "feat one");
    advanceMain();

    const result = rebaseBeforePR(wt, 1069, undefined, false);

    expect(result.strategy).toBe("rebase");
    expect(
      git(wt, "rev-list", "--merges", "--count", "origin/main..HEAD"),
    ).toBe("0");
  });

  it("reports merge vs rebase", () => {
    commitFile(wt, "a.txt", "feat one");
    git(wt, "push", "-q", "-u", "origin", "feat");
    advanceMain();
    rebaseBeforePR(wt, 1069, undefined, false);
    expect(logs.map(stripAnsi).join("\n")).toContain("merged origin/main");
    expect(logs.map(stripAnsi).join("\n")).not.toContain(
      "rebased onto origin/main",
    );

    logs.length = 0;
    git(wt, "reset", "-q", "--hard", "origin/feat");
    git(wt, "branch", "--unset-upstream");
    advanceMain("second-advance.txt");
    rebaseBeforePR(wt, 1069, undefined, false);
    expect(logs.map(stripAnsi).join("\n")).toContain(
      "rebased onto origin/main",
    );
  });

  it("merge conflict aborts and leaves branch intact", () => {
    commitFile(wt, "base.txt", "feat edits base");
    git(wt, "push", "-q", "-u", "origin", "feat");
    const before = git(wt, "rev-parse", "HEAD");
    commitFile(clone, "base.txt", "main edits base");
    git(clone, "push", "-q", "origin", "main");

    const result = rebaseBeforePR(wt, 1069, undefined, false);

    expect(result.success).toBe(false);
    expect(result.strategy).toBe("merge");
    expect(result.error).toContain("conflict");
    expect(git(wt, "rev-parse", "HEAD")).toBe(before);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });
});

/**
 * #1196 AC-1: worktree provisioning skips install (and logs why) when no
 * manifest exists for the resolved package manager. Root cause: a non-Node
 * repo has no `node_modules` either, so `ensureWorktree`'s
 * `!existsSync(node_modules)` guard was always true, and `resolvePackageManager`
 * falls back to `"npm"` (JS-only lockfile detection) — so provisioning always
 * attempted a failing `npm ci` against a tree with no package.json.
 *
 * These tests never reach `spawnSync` on the skip path, so `child_process` is
 * deliberately left unmocked — a real accidental install attempt would fail
 * loudly rather than pass silently.
 */
describe("installWorktreeDeps skips install with no manifest (#1196 AC-1)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sequant-1196-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips and logs why for a non-Node repo (no package.json, no lockfile)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = installWorktreeDeps(dir, undefined, false);

    expect(result).toBe(true);
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Skipping dependency install");
    expect(output).toContain("no manifest found");

    logSpy.mockRestore();
  });

  it("skips a pip stack with a pyproject.toml but no requirements file — never bare `pip install -q`", () => {
    writeFileSync(join(dir, "pyproject.toml"), "[project]\nname = 'x'\n");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = installWorktreeDeps(dir, "pip", false);

    expect(result).toBe(true);
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Skipping dependency install");
    expect(output).not.toContain("pip install -q\n"); // never the bare no-op

    logSpy.mockRestore();
  });
});

// #1197: the issue's Evidence names this file for AC-1/2/4. The fuller cases
// live in worktree-manager.build-pr-body.test.ts.
describe("#1197 PR issue link: closes vs refs", () => {
  it("AC-1: prIssueLink decides the keyword, default closes", () => {
    const closes = resolvePrLinkMode([], undefined, undefined);
    const refs = resolvePrLinkMode([], "refs", undefined);
    expect(buildAutomatedPRBody(1197, { linkMode: closes })).toContain(
      "Fixes #1197",
    );
    const body = buildAutomatedPRBody(1197, { linkMode: refs });
    expect(body).toContain("Refs #1197");
    expect(body).not.toContain("Fixes #1197");
  });

  it("AC-2: the no-autoclose label forces Refs #N under prIssueLink closes", () => {
    const mode = resolvePrLinkMode(["no-autoclose"], "closes", undefined);
    const body = buildAutomatedPRBody(1197, { linkMode: mode });
    expect(body).toContain("Refs #1197");
    expect(body).not.toContain("Fixes #1197");
  });

  it("AC-4: refs mode rewrites closing verbs in tables and the owner/repo#N form", () => {
    const body = buildAutomatedPRBody(1197, {
      linkMode: "refs",
      stackManifest:
        "| AC | Note |\n|----|----|\n| Closes #1197 | row |\nFixes sequant-io/sequant#1197",
    });
    expect(body).not.toMatch(
      /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[\w.-]+\/[\w.-]+)?#1197/i,
    );
    expect(body).toContain("| Refs #1197 | row |");
    expect(body).toContain("Refs sequant-io/sequant#1197");
  });
});
