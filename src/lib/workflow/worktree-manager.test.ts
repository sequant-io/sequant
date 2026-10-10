/**
 * #1069: rebaseBeforePR must not rewrite commits that exist on the remote.
 * Real git throughout (bare remote + clone + feature worktree), no mocks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  rebaseBeforePR,
  installWorktreeDeps,
  buildAutomatedPRBody,
  buildPRTitle,
  createPR,
  isAutomatedPRBody,
  resolvePrBase,
  resolvePrLinkMode,
  resolveWorktreeRoot,
  shouldPreserveWorktree,
  hasCommitsAheadOfBase,
  cleanupWorktreeOnShutdown,
  registerWorktreeRemovalCleanup,
} from "./worktree-manager.js";
import type { WorktreeInfo } from "./worktree-manager.js";
import { ShutdownManager } from "../shutdown.js";
import { validateSettings } from "../settings.js";
import { GitHubProvider } from "./platforms/github.js";

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
    expect(output).toContain("no package.json at the worktree root");

    logSpy.mockRestore();
  });

  it("no root package.json: skips with a root-naming message (package in a subdirectory)", () => {
    mkdirSync(join(dir, "agent"));
    writeFileSync(join(dir, "agent", "package.json"), "{}");
    writeFileSync(join(dir, "agent", "package-lock.json"), "{}");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = installWorktreeDeps(dir, undefined, false);

    expect(result).toBe(true);
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("no package.json at the worktree root");
    expect(output).not.toContain("Dependency install failed");

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

describe("#1247 AC-2: createPR updates a PR that already exists", () => {
  let root: string;
  let remote: string;
  let wt: string;
  let logs: string[];
  let viewSpy: ReturnType<typeof vi.spyOn>;
  let updateSpy: ReturnType<typeof vi.spyOn>;
  let createSpy: ReturnType<typeof vi.spyOn>;

  const AUTOMATED_BODY =
    "## Summary\n\nAutomated PR for issue #1247.\n\nFixes #1247\n\n---\n🤖 Generated by `sequant run`";
  const existing = (body?: string) => ({
    number: 5,
    url: "https://github.com/o/r/pull/5",
    ...(body === undefined ? {} : { body }),
  });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "seq-1247-")));
    remote = join(root, "remote.git");
    const clone = join(root, "clone");
    wt = join(root, "wt");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    git(root, "clone", "-q", remote, clone);
    git(clone, "config", "user.name", "sequant-test");
    git(clone, "config", "user.email", "sequant-test@example.com");
    git(clone, "checkout", "-q", "-b", "main");
    commitFile(clone, "base.txt", "base");
    git(clone, "push", "-q", "origin", "main");
    git(
      clone,
      "worktree",
      "add",
      "-q",
      "-b",
      "feature/1247",
      wt,
      "origin/main",
    );
    commitFile(wt, "fix.txt", "fix one");
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    viewSpy = vi.spyOn(GitHubProvider.prototype, "viewPRByBranchSync");
    updateSpy = vi
      .spyOn(GitHubProvider.prototype, "updatePRSync")
      .mockReturnValue({ success: true });
    createSpy = vi.spyOn(GitHubProvider.prototype, "createPRCliSync");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const run = (
    stackOptions?: { prBase?: string; stackManifest?: string },
    baseBranch?: string,
  ) =>
    createPR(
      wt,
      1247,
      "fix(run): two PR producers",
      "feature/1247",
      false,
      ["bug"],
      stackOptions,
      "AC_MET_BUT_NOT_A_PLUS",
      undefined,
      undefined,
      undefined,
      { execSummary: "Exec summary from state.", baseBranch },
    );

  const remoteHead = (): string =>
    git(root, "--git-dir", remote, "rev-parse", "refs/heads/feature/1247");

  it("Step 1 path: pushes the branch, then PATCHes title and body built by buildPRTitle/buildAutomatedPRBody", () => {
    viewSpy.mockReturnValue(existing(AUTOMATED_BODY));

    const result = run();

    expect(result).toMatchObject({ success: true, prNumber: 5 });
    expect(remoteHead()).toBe(git(wt, "rev-parse", "HEAD"));
    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const [prNumber, fields] = updateSpy.mock.calls[0] as [
      number,
      { title?: string; body?: string; base?: string },
    ];
    expect(prNumber).toBe(5);
    expect(fields.title).toBe("fix(#1247): two PR producers");
    expect(fields.body).toContain("Exec summary from state.");
    expect(fields.body).toContain("AC_MET_BUT_NOT_A_PLUS");
    expect(fields.body).toContain("Fixes #1247");
    expect(fields.body).not.toContain("Automated PR for issue #1247.");
    expect(fields.base).toBeUndefined();
  });

  // #1386: a plain --base (no --stacked) reaches `gh`'s --base / the PATCH.
  it("#1386 AC-1: create path passes --base <branch> when only --base is set", () => {
    viewSpy.mockReturnValue(null);
    createSpy.mockReturnValue({
      stdout: "https://github.com/o/r/pull/9",
      stderr: "",
      exitCode: 0,
    });

    run(undefined, "feat/x");

    expect(createSpy).toHaveBeenCalledTimes(1);
    // `base` is createPRCliSync's 5th positional argument.
    expect(createSpy.mock.calls[0][4]).toBe("feat/x");
  });

  it("#1386 AC-1: update path retargets the PR to --base <branch>", () => {
    viewSpy.mockReturnValue(existing(AUTOMATED_BODY));

    run(undefined, "origin/feat/x");

    const fields = updateSpy.mock.calls[0][1] as { base?: string };
    expect(fields.base).toBe("feat/x");
  });

  it("#1386 AC-4: --stacked predecessor wins over --base", () => {
    viewSpy.mockReturnValue(existing(AUTOMATED_BODY));

    run({ prBase: "feature/1200-first" }, "feat/x");

    const fields = updateSpy.mock.calls[0][1] as { base?: string };
    expect(fields.base).toBe("feature/1200-first");
  });

  it("an empty existing body is overwritten too", () => {
    viewSpy.mockReturnValue(existing(""));
    run();
    const fields = updateSpy.mock.calls[0][1] as { body?: string };
    expect(fields.body).toContain("Exec summary from state.");
  });

  it("a hand-edited body is left alone, logged, and base still set under --stacked", () => {
    viewSpy.mockReturnValue(existing("A reviewer rewrote this description."));

    const result = run({ prBase: "feature/1200-first" });

    expect(result.success).toBe(true);
    const fields = updateSpy.mock.calls[0][1] as {
      title?: string;
      body?: string;
      base?: string;
    };
    expect(fields.title).toBeUndefined();
    expect(fields.body).toBeUndefined();
    expect(fields.base).toBe("feature/1200-first");
    expect(logs.join("\n")).toContain(
      "PR #5 body was edited by hand; not overwritten",
    );
  });

  it("race path: gh pr create says 'already exists', the re-viewed PR is updated", () => {
    viewSpy
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(existing(AUTOMATED_BODY));
    createSpy.mockReturnValue({
      stdout: "",
      stderr: "a pull request for branch already exists",
      exitCode: 1,
    });

    const result = run({ prBase: "feature/1200-first" });

    expect(result).toMatchObject({ success: true, prNumber: 5 });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const fields = updateSpy.mock.calls[0][1] as {
      body?: string;
      base?: string;
    };
    expect(fields.body).toContain("Exec summary from state.");
    expect(fields.base).toBe("feature/1200-first");
  });

  it("a failed PATCH warns but the run keeps its PR", () => {
    viewSpy.mockReturnValue(existing(AUTOMATED_BODY));
    updateSpy.mockReturnValue({ success: false, error: "HTTP 422" });

    const result = run();

    expect(result).toMatchObject({ success: true, prNumber: 5 });
    expect(logs.join("\n")).toContain("PR #5 update failed: HTTP 422");
  });

  it("a failed push on the update path fails, the same as the create path", () => {
    viewSpy.mockReturnValue(existing(AUTOMATED_BODY));
    rmSync(remote, { recursive: true, force: true });

    const result = run();

    expect(result.success).toBe(false);
    expect(result.error).toContain("git push failed");
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("isAutomatedPRBody: trailer or empty only; unknown body is not overwritten", () => {
    expect(isAutomatedPRBody(AUTOMATED_BODY)).toBe(true);
    expect(isAutomatedPRBody("  ")).toBe(true);
    expect(isAutomatedPRBody("🤖 Generated with [Claude Code]")).toBe(false);
    expect(isAutomatedPRBody(undefined)).toBe(false);
  });
});

describe("#1199 worktree root resolution", () => {
  const repo = "/home/u/code/app";

  it("defaults to <parent of repo>/worktrees", () => {
    expect(resolveWorktreeRoot(repo, undefined, {})).toBe(
      "/home/u/code/worktrees",
    );
  });

  it("uses the worktreeRoot setting when no env var is set", () => {
    expect(resolveWorktreeRoot(repo, "/srv/trees", {})).toBe("/srv/trees");
  });

  it("resolves a relative setting against the repo root, not the cwd", () => {
    expect(resolveWorktreeRoot(repo, "../trees", {})).toBe(
      "/home/u/code/trees",
    );
    expect(resolveWorktreeRoot(repo, ".wt", {})).toBe("/home/u/code/app/.wt");
  });

  it("SEQUANT_WORKTREE_ROOT beats the setting", () => {
    expect(
      resolveWorktreeRoot(repo, "/srv/trees", {
        SEQUANT_WORKTREE_ROOT: "/tmp/wt",
      }),
    ).toBe("/tmp/wt");
  });

  it("treats an empty or whitespace env var as unset", () => {
    expect(
      resolveWorktreeRoot(repo, "/srv/trees", { SEQUANT_WORKTREE_ROOT: "  " }),
    ).toBe("/srv/trees");
    expect(resolveWorktreeRoot(repo, "", { SEQUANT_WORKTREE_ROOT: "" })).toBe(
      "/home/u/code/worktrees",
    );
  });

  it("run.worktreeRoot is a known, schema-valid setting", () => {
    const { settings, warnings } = validateSettings({
      run: { worktreeRoot: "../trees" },
    });
    expect(settings.run.worktreeRoot).toBe("../trees");
    expect(warnings).toEqual([]);
  });
});

// #1199 AC-1: ensureWorktree creates the worktree under the resolved root.
// getGitRoot() reads the process cwd, so this runs ensureWorktree in a child
// process rooted in a scratch repo instead of spying on process.cwd (#870).
describe("#1199 ensureWorktree honours the configured root", () => {
  let root: string;
  let clone: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "seq-1199-")));
    const remote = join(root, "remote.git");
    clone = join(root, "clone");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    git(root, "clone", "-q", remote, clone);
    git(clone, "config", "user.email", "t@t");
    git(clone, "config", "user.name", "t");
    git(clone, "config", "commit.gpgsign", "false");
    git(clone, "checkout", "-q", "-b", "main");
    commitFile(clone, "a.txt", "init");
    git(clone, "push", "-q", "-u", "origin", "main");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const runEnsure = (
    worktreeRoot: string | undefined,
    envRoot?: string,
  ): { path: string } => {
    const script = join(root, "ensure.mts");
    const modPath = join(__dirname, "worktree-manager.ts");
    writeFileSync(
      script,
      `import { ensureWorktree } from ${JSON.stringify(modPath)};
const info = await ensureWorktree(1199, "custom root", false, undefined, "main", false, ${JSON.stringify(worktreeRoot)});
process.stdout.write("\\nRESULT=" + JSON.stringify(info));\n`,
    );
    const env = { ...process.env };
    delete env.SEQUANT_WORKTREE_ROOT;
    if (envRoot !== undefined) env.SEQUANT_WORKTREE_ROOT = envRoot;
    const out = execFileSync("npx", ["tsx", script], {
      cwd: clone,
      env,
      encoding: "utf8",
    });
    const line = out.split("\n").find((l) => l.startsWith("RESULT="));
    return JSON.parse(line!.slice("RESULT=".length));
  };

  it("creates the worktree under a relative run.worktreeRoot", () => {
    const info = runEnsure(".trees");
    expect(info.path).toBe(
      join(clone, ".trees", "feature", "1199-custom-root"),
    );
    expect(git(info.path, "branch", "--show-current")).toBe(
      "feature/1199-custom-root",
    );
  }, 60_000);

  it("SEQUANT_WORKTREE_ROOT overrides the setting", () => {
    const envRoot = join(root, "env-trees");
    const info = runEnsure(".trees", envRoot);
    expect(info.path).toBe(join(envRoot, "feature", "1199-custom-root"));
  }, 60_000);
});

describe("#1222 AC-2: preserve a mid-flight worktree on signal shutdown", () => {
  let root: string;
  let clone: string;
  let wt: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "seq-1222-")));
    const remote = join(root, "remote.git");
    clone = join(root, "clone");
    wt = join(root, "wt");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    git(root, "clone", "-q", remote, clone);
    git(clone, "config", "user.name", "sequant-test");
    git(clone, "config", "user.email", "sequant-test@example.com");
    git(clone, "checkout", "-q", "-b", "main");
    commitFile(clone, "base.txt", "base");
    git(clone, "push", "-q", "origin", "main");
    // Same shape as ensureWorktree: branch off origin/main, tracked base.
    git(
      clone,
      "worktree",
      "add",
      "-q",
      "-b",
      "feature/1222",
      wt,
      "origin/main",
    );
    git(wt, "config", "user.name", "sequant-test");
    git(wt, "config", "user.email", "sequant-test@example.com");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("hasCommitsAheadOfBase is false for a clean branch with no new commits", () => {
    expect(hasCommitsAheadOfBase(wt, "origin/main")).toBe(false);
  });

  it("hasCommitsAheadOfBase is true once the branch has committed work (#1198)", () => {
    commitFile(wt, "wip.txt", "wip");
    expect(hasCommitsAheadOfBase(wt, "origin/main")).toBe(true);
  });

  it("shouldPreserveWorktree preserves a clean worktree with commits ahead of base", () => {
    commitFile(wt, "wip.txt", "wip");
    const abort = { signal: "SIGTERM", reason: "terminated" };
    expect(shouldPreserveWorktree(abort, wt, { baseRef: "origin/main" })).toBe(
      true,
    );
  });

  it("shouldPreserveWorktree preserves a clean, base-level worktree whose phase is in progress", () => {
    const abort = { signal: "SIGTERM", reason: "terminated" };
    expect(
      shouldPreserveWorktree(abort, wt, {
        baseRef: "origin/main",
        phaseInProgress: true,
      }),
    ).toBe(true);
  });

  it("shouldPreserveWorktree removes a clean, base-level worktree with no phase running", () => {
    const abort = { signal: "SIGTERM", reason: "terminated" };
    expect(
      shouldPreserveWorktree(abort, wt, {
        baseRef: "origin/main",
        phaseInProgress: false,
      }),
    ).toBe(false);
  });

  it("cleanupWorktreeOnShutdown preserves a worktree via the phaseInProgress callback (#1222 AC-2)", async () => {
    const logs: string[] = [];
    const info: WorktreeInfo = {
      issue: 1222,
      path: wt,
      branch: "feature/1222",
      existed: false,
      rebased: false,
    };
    await cleanupWorktreeOnShutdown(
      1222,
      info,
      { signal: "SIGTERM", reason: "terminated" },
      (msg) => logs.push(msg),
      () => true,
    );
    expect(logs[0]).toContain("preserved");
    // Still on disk: the phase-in-progress path did not remove it.
    const remaining = git(clone, "worktree", "list", "--porcelain");
    expect(remaining).toContain(wt);
  });

  it("registerWorktreeRemovalCleanup wires the phaseInProgress callback through to shutdown", async () => {
    const logs: string[] = [];
    const info: WorktreeInfo = {
      issue: 1222,
      path: wt,
      branch: "feature/1222",
      existed: false,
      rebased: false,
    };
    const shutdown = new ShutdownManager({
      output: () => {},
      errorOutput: () => {},
      exit: () => {},
    });
    registerWorktreeRemovalCleanup(
      shutdown,
      1222,
      info,
      (msg) => logs.push(msg),
      () => true,
    );
    await shutdown.gracefulShutdown("SIGTERM");
    expect(logs[0]).toContain("preserved");
    const remaining = git(clone, "worktree", "list", "--porcelain");
    expect(remaining).toContain(wt);
  });
});

describe("#1223 buildPRTitle: conventional-commit prefix reuse", () => {
  it("reuses the title's own type and replaces the scope with #N", () => {
    expect(buildPRTitle("feat(adopt): x", 1209)).toBe("feat(#1209): x");
  });

  it("maps a `bug(scope):` title to fix without doubling it (this repo's #1232–#1234 shape)", () => {
    expect(
      buildPRTitle(
        "bug(state): a successful spec-only run marks the issue ready_for_merge",
        1233,
        ["bug"],
      ),
    ).toBe(
      "fix(#1233): a successful spec-only run marks the issue ready_for_merge",
    );
  });

  it("prefers the title's type over the label-derived prefix", () => {
    expect(buildPRTitle("fix(run): y", 932, ["enhancement"])).toBe(
      "fix(#932): y",
    );
  });

  it("does not double the prefix", () => {
    const title = buildPRTitle("feat(adopt): x", 1209);
    expect(title).not.toContain("feat(#1209): feat(adopt)");
  });

  it("falls back to label-derived fix for a bug-labeled title with no prefix", () => {
    expect(buildPRTitle("crash on startup", 932, ["bug"])).toBe(
      "fix(#932): crash on startup",
    );
  });

  it("falls back to label-derived feat with no bug label and no prefix", () => {
    expect(buildPRTitle("add dark mode", 42, ["enhancement"])).toBe(
      "feat(#42): add dark mode",
    );
  });

  it("does not mistake a mid-title colon for a conventional prefix", () => {
    expect(buildPRTitle("Docs: foo", 42)).toBe("feat(#42): Docs: foo");
  });

  // The `!` is kept: it's valid conventional-commit form (this repo's
  // commit validator accepts `(!)?`), and dropping it would hide a breaking
  // change in the squash commit's title.
  it("keeps a scope-less breaking-change marker", () => {
    expect(buildPRTitle("feat!: drop legacy flag", 55)).toBe(
      "feat(#55)!: drop legacy flag",
    );
  });

  it("keeps a breaking-change marker with a scope", () => {
    expect(buildPRTitle("fix(run)!: y", 932)).toBe("fix(#932)!: y");
  });
});

// #1234: sequant run worktrees record the exact ref they were cut from, and
// the pre-PR rebase falls back to a local-only base instead of failing on
// origin/<base>. Child process for the same reason as #1199 above.
describe("#1234 ensureWorktree records sequantBaseRef", () => {
  let root: string;
  let clone: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "seq-1234-")));
    const remote = join(root, "remote.git");
    clone = join(root, "clone");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    git(root, "clone", "-q", remote, clone);
    git(clone, "config", "user.email", "t@t");
    git(clone, "config", "user.name", "t");
    git(clone, "config", "commit.gpgsign", "false");
    git(clone, "checkout", "-q", "-b", "main");
    commitFile(clone, "a.txt", "init");
    git(clone, "push", "-q", "-u", "origin", "main");
    // A pushed feature branch and an unpushed local one, each ahead of main.
    git(clone, "checkout", "-q", "-b", "remote-base");
    commitFile(clone, "r.txt", "remote base");
    git(clone, "push", "-q", "-u", "origin", "remote-base");
    git(clone, "checkout", "-q", "-b", "local-base", "main");
    commitFile(clone, "l.txt", "local base");
    git(clone, "checkout", "-q", "main");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const runScript = (body: string): string => {
    const script = join(root, `run-${Math.random().toString(36).slice(2)}.mts`);
    const modPath = join(__dirname, "worktree-manager.ts");
    writeFileSync(
      script,
      `import { ensureWorktree, rebaseBeforePR } from ${JSON.stringify(modPath)};\n${body}\n`,
    );
    const env = { ...process.env };
    delete env.SEQUANT_WORKTREE_ROOT;
    return execFileSync("npx", ["tsx", script], {
      cwd: clone,
      env,
      encoding: "utf8",
    });
  };

  const ensure = (issue: number, base: string | undefined): string => {
    const out = runScript(
      `const info = await ensureWorktree(${issue}, "base ref", false, undefined, ${JSON.stringify(base)}, false, ".trees");
process.stdout.write("\\nRESULT=" + JSON.stringify(info));`,
    );
    const line = out.split("\n").find((l) => l.startsWith("RESULT="));
    return JSON.parse(line!.slice("RESULT=".length)).path as string;
  };

  const recorded = (worktree: string): string =>
    git(
      worktree,
      "config",
      "--get",
      `branch.${git(worktree, "branch", "--show-current")}.sequantBaseRef`,
    );

  it("1234 records origin/main when no --base is given", () => {
    expect(recorded(ensure(1, undefined))).toBe("origin/main");
  }, 60_000);

  it("1234 records origin/<x> for a remote-style --base", () => {
    expect(recorded(ensure(2, "origin/remote-base"))).toBe(
      "origin/remote-base",
    );
  }, 60_000);

  it("1234 records a local --base branch as-is", () => {
    expect(recorded(ensure(3, "local-base"))).toBe("local-base");
  }, 60_000);

  it("1234 pre-PR rebase onto a local-only base prints no fetch failure", () => {
    const wt = ensure(4, "local-base");
    const out = runScript(
      `rebaseBeforePR(${JSON.stringify(wt)}, 4, undefined, true, "local-base");`,
    );
    expect(out).not.toContain("Could not fetch");
    expect(out).toContain("onto local-base");
  }, 60_000);

  it("1234 pre-PR rebase still fetches a pushed --base and picks up a teammate's commit", () => {
    const wt = ensure(6, "remote-base");
    // A teammate pushes to the shared base after the worktree was cut.
    const mate = join(root, "mate");
    git(root, "clone", "-q", join(root, "remote.git"), mate);
    git(mate, "config", "user.email", "m@m");
    git(mate, "config", "user.name", "m");
    git(mate, "config", "commit.gpgsign", "false");
    git(mate, "checkout", "-q", "remote-base");
    commitFile(mate, "mate.txt", "teammate commit");
    git(mate, "push", "-q", "origin", "remote-base");

    const out = runScript(
      `rebaseBeforePR(${JSON.stringify(wt)}, 6, undefined, true, "remote-base");`,
    );
    expect(out).toContain("onto origin/remote-base");
    expect(git(wt, "log", "--format=%s")).toContain("teammate commit");
  }, 60_000);

  it("1234 pre-PR rebase onto a local-only base works for a chain final link too", () => {
    const wt = ensure(7, "local-base");
    // A chain successor records its predecessor, not the run's base.
    git(clone, "branch", "predecessor", "local-base");
    git(
      wt,
      "config",
      `branch.${git(wt, "branch", "--show-current")}.sequantBaseRef`,
      "predecessor",
    );
    const out = runScript(
      `rebaseBeforePR(${JSON.stringify(wt)}, 7, undefined, true, "local-base");`,
    );
    expect(out).not.toContain("Could not fetch");
    expect(out).toContain("onto local-base");
  }, 60_000);

  it("1234 pre-PR rebase still targets origin/<base> when the recorded ref is a different branch (chain final link)", () => {
    const wt = ensure(5, "local-base");
    const out = runScript(
      `rebaseBeforePR(${JSON.stringify(wt)}, 5, undefined, true, "main");`,
    );
    expect(out).toContain("onto origin/main");
  }, 60_000);
});

describe("#1386: resolvePrBase", () => {
  const detected = () => "main";

  it("no base: undefined, so gh uses the repo default", () => {
    expect(resolvePrBase(undefined, undefined, detected)).toBeUndefined();
  });

  it("a base equal to the detected default: undefined (unchanged)", () => {
    expect(resolvePrBase(undefined, "main", detected)).toBeUndefined();
    expect(resolvePrBase(undefined, "origin/main", detected)).toBeUndefined();
  });

  it("a non-default base: the bare branch name", () => {
    expect(resolvePrBase(undefined, "feat/x", detected)).toBe("feat/x");
    expect(resolvePrBase(undefined, "origin/feat/x", detected)).toBe("feat/x");
  });

  it("--stacked predecessor wins and detection is not consulted", () => {
    const detect = vi.fn(() => "main");
    expect(resolvePrBase("feature/1-a", "feat/x", detect)).toBe("feature/1-a");
    expect(detect).not.toHaveBeenCalled();
  });
});

// #1380: a stale-and-clean worktree is recreated from origin/<branch> when the
// remote has it, and never in a way that drops the branch's commits.
describe("#1380 ensureWorktree recreate keeps the branch's commits", () => {
  let root: string;
  let clone: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "seq-1380-")));
    const remote = join(root, "remote.git");
    clone = join(root, "clone");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    git(root, "clone", "-q", remote, clone);
    git(clone, "config", "user.email", "t@t");
    git(clone, "config", "user.name", "t");
    git(clone, "config", "commit.gpgsign", "false");
    git(clone, "checkout", "-q", "-b", "main");
    commitFile(clone, "a.txt", "init");
    git(clone, "push", "-q", "-u", "origin", "main");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const ensure = (
    issue: number,
  ): { out: string; info: { path: string; existed: boolean } } => {
    const script = join(root, `run-${Math.random().toString(36).slice(2)}.mts`);
    const modPath = join(__dirname, "worktree-manager.ts");
    writeFileSync(
      script,
      `import { ensureWorktree } from ${JSON.stringify(modPath)};
const info = await ensureWorktree(${issue}, "recreate me", false, undefined, undefined, false, ".trees");
process.stdout.write("\\nRESULT=" + JSON.stringify(info));\n`,
    );
    const env = { ...process.env };
    delete env.SEQUANT_WORKTREE_ROOT;
    const out = execFileSync("npx", ["tsx", script], {
      cwd: clone,
      env,
      encoding: "utf8",
    });
    const line = out.split("\n").find((l) => l.startsWith("RESULT="));
    return { out, info: JSON.parse(line!.slice("RESULT=".length)) };
  };

  // A teammate lands six commits on main; the clone fetches them.
  const advanceMain = (): void => {
    const mate = join(root, "mate");
    git(root, "clone", "-q", join(root, "remote.git"), mate);
    git(mate, "config", "user.email", "m@m");
    git(mate, "config", "user.name", "m");
    git(mate, "config", "commit.gpgsign", "false");
    for (let i = 0; i < 6; i++) commitFile(mate, `m${i}.txt`, `main ${i}`);
    git(mate, "push", "-q", "origin", "main");
    git(clone, "fetch", "-q", "origin");
  };

  // The PR shape: a worktree whose branch has a commit pushed with -u.
  const pushedBranch = (issue: number): { wt: string; branch: string } => {
    const wt = ensure(issue).info.path;
    const branch = git(wt, "branch", "--show-current");
    commitFile(wt, "pr.txt", "pr commit");
    git(wt, "push", "-q", "-u", "origin", branch);
    return { wt, branch };
  };

  it("1380 AC-1 recreates a pushed branch from origin/<branch>, keeping its commits", () => {
    const { branch } = pushedBranch(10);
    advanceMain();

    const { out, info } = ensure(10);
    expect(out).toContain("recreating fresh");
    expect(info.existed).toBe(false);
    expect(
      git(info.path, "rev-list", "--count", `HEAD..origin/${branch}`),
    ).toBe("0");
    expect(git(info.path, "log", "--format=%s")).toContain("pr commit");
  }, 90_000);

  it("1380 AC-2 recreates a local-only branch with no commits of its own from the base", () => {
    const branch = git(ensure(11).info.path, "branch", "--show-current");
    expect(git(clone, "ls-remote", "--heads", "origin", branch)).toBe("");
    advanceMain();

    const { out, info } = ensure(11);
    expect(out).toContain("recreating fresh");
    expect(info.existed).toBe(false);
    expect(git(info.path, "rev-parse", "HEAD")).toBe(
      git(clone, "rev-parse", "origin/main"),
    );
  }, 90_000);

  it("1380 AC-3 keeps the worktree when the start ref lacks the branch's commits", () => {
    const { wt, branch } = pushedBranch(12);
    advanceMain();
    const head = git(wt, "rev-parse", "HEAD");
    // Offline blip: sequant cannot see origin/<branch> any more.
    git(clone, "update-ref", "-d", `refs/remotes/origin/${branch}`);
    git(clone, "remote", "set-url", "origin", join(root, "missing.git"));

    const { out, info } = ensure(12);
    expect(out).toContain("does not contain its commits");
    expect(out).toContain("Keeping existing worktree");
    expect(out).not.toContain("recreating fresh");
    expect(info.existed).toBe(true);
    expect(git(wt, "rev-parse", "HEAD")).toBe(head);
  }, 90_000);

  it("1380 AC-4 records the run's base, not origin/<branch>, after a recreate", () => {
    const { branch } = pushedBranch(13);
    advanceMain();

    const { info } = ensure(13);
    expect(info.existed).toBe(false);
    expect(
      git(info.path, "config", "--get", `branch.${branch}.sequantBaseRef`),
    ).toBe("origin/main");
  }, 90_000);
});
