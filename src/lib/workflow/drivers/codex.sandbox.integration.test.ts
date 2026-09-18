/**
 * #1076 — codex's `workspace-write` sandbox excludes `.git/`, so a phase can
 * edit files but cannot `git add` or `git commit` them:
 *
 *   fatal: Unable to create '…/index.lock': Operation not permitted
 *
 * Measured on the first #1060 gate run, where exec produced correct edits
 * across four files and failed with "made no commits". The exclusion is not
 * worktree-specific — a plain clone whose `.git` sits inside the workspace
 * fails identically — so the driver names the git dir as a writable root.
 *
 * Real git repos (and a real `git worktree`) rather than mocks: the whole
 * point is which absolute path git actually keeps the index under, which a
 * stubbed `execFileSync` would only restate.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { buildCodexArgs, resolveGitCommonDir } from "./codex.js";

/**
 * The `writable_roots` override the driver passed, or undefined.
 *
 * Matched on the full `sandbox_workspace_write.writable_roots=` prefix, not
 * the `sandbox_workspace_write.` namespace: #1079 added a second `-c` under
 * that same namespace, and a prefix match would silently start reporting the
 * network flag here.
 */
function writableRootsArg(args: string[]): string | undefined {
  return args.find((a) =>
    a.startsWith("sandbox_workspace_write.writable_roots="),
  );
}

/** The `network_access` override the driver passed, or undefined (#1079). */
function networkAccessArg(args: string[]): string | undefined {
  return args.find((a) =>
    a.startsWith("sandbox_workspace_write.network_access="),
  );
}

describe("1076: .git is a writable root under workspace-write", () => {
  let repo: string;
  let worktree: string;

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "sequant-1076-repo-")));
    const git = (...a: string[]) =>
      execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "test@test");
    git("config", "user.name", "test");
    git("config", "commit.gpgsign", "false");
    git("commit", "-q", "--allow-empty", "-m", "root");

    worktree = join(repo, "..", `sequant-1076-wt-${process.pid}`);
    git("worktree", "add", "-q", "--detach", worktree);
  });

  afterAll(() => {
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktree], {
        cwd: repo,
        stdio: "ignore",
      });
    } catch {
      // The rmSync below is the real cleanup; a failed unregister is noise.
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("1076 names the repo's own .git for an ordinary checkout", () => {
    const args = buildCodexArgs("$exec 1", { cwd: repo, phase: "exec" });

    expect(writableRootsArg(args)).toBe(
      `sandbox_workspace_write.writable_roots=${JSON.stringify([join(repo, ".git")])}`,
    );
    // The flag is a `-c` override, so the two must stay adjacent and in order.
    expect(args[args.indexOf(writableRootsArg(args)!) - 1]).toBe("-c");
  });

  it("1076 names the MAIN repo's .git from inside a worktree, where the index lives", () => {
    const args = buildCodexArgs("$exec 1", { cwd: worktree, phase: "exec" });

    // Not the worktree's own `.git` (a pointer file), and not
    // `.git/worktrees/<name>` — the common dir, which contains both.
    expect(writableRootsArg(args)).toBe(
      `sandbox_workspace_write.writable_roots=${JSON.stringify([join(repo, ".git")])}`,
    );
    expect(resolveGitCommonDir(worktree)).toBe(join(repo, ".git"));
  });

  it("1076 resolves to an absolute path, since a sandbox policy has no cwd", () => {
    const dir = resolveGitCommonDir(repo);

    expect(dir).toBe(join(repo, ".git"));
    expect(dir?.startsWith("/")).toBe(true);
  });

  it.each([
    ["read-only", "read-only"],
    ["danger-full-access", "danger-full-access"],
  ] as const)(
    "1076 adds no writable root under %s — nothing to write, or already unrestricted",
    (_label, sandboxMode) => {
      const args = buildCodexArgs(
        "$exec 1",
        { cwd: repo, phase: "exec" },
        { sandboxMode },
      );

      expect(writableRootsArg(args)).toBeUndefined();
      expect(args).toContain(sandboxMode);
    },
  );

  it("1076 stays silent outside a git repo rather than failing the phase", () => {
    const bare = realpathSync(
      mkdtempSync(join(tmpdir(), "sequant-1076-nogit-")),
    );
    try {
      expect(resolveGitCommonDir(bare)).toBeNull();
      expect(
        writableRootsArg(
          buildCodexArgs("$exec 1", { cwd: bare, phase: "exec" }),
        ),
      ).toBeUndefined();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  // #1079 — `workspace-write` also disables network access, leaving a phase
  // unable to read its own issue, comment, or push. The #1060 gate run left no
  // `/spec` comment and logged "Could not parse spec recommendation" for this
  // reason; its exec agent reconstructed the task by grepping for the issue
  // number, never having read the issue.
  it("1079 enables network access under workspace-write by default", () => {
    const args = buildCodexArgs("$exec 1", { cwd: repo, phase: "exec" });

    expect(networkAccessArg(args)).toBe(
      "sandbox_workspace_write.network_access=true",
    );
    expect(args[args.indexOf(networkAccessArg(args)!) - 1]).toBe("-c");
  });

  it("1079 honours networkAccess: false for anyone who wants phases sealed off", () => {
    const args = buildCodexArgs(
      "$exec 1",
      { cwd: repo, phase: "exec" },
      { networkAccess: false },
    );

    expect(networkAccessArg(args)).toBeUndefined();
    // The writable root is independent — a sealed phase must still commit.
    expect(writableRootsArg(args)).toBeDefined();
  });

  it.each([
    ["read-only", "read-only"],
    ["danger-full-access", "danger-full-access"],
  ] as const)(
    "1079 adds no network override under %s — codex governs those itself",
    (_label, sandboxMode) => {
      const args = buildCodexArgs(
        "$exec 1",
        { cwd: repo, phase: "exec" },
        { sandboxMode },
      );

      expect(networkAccessArg(args)).toBeUndefined();
    },
  );

  it("1076 keeps the prompt last, after the injected override", () => {
    const args = buildCodexArgs("$exec 1", { cwd: repo, phase: "exec" });

    expect(args[args.length - 1]).toBe("$exec 1");
  });
});
