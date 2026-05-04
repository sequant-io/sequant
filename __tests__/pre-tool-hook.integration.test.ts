// Tests for Issue #564 — pre-tool.sh regexes must skip gh issue/pr body content.
//
// The hook script is mirrored across three locations (templates/hooks/,
// hooks/, and .claude/hooks/), none of which are symlinks. To prevent
// future drift in any one copy, this suite parametrizes every assertion
// over all three. AC-4 uses an isolated tmp git repo so the "no staged
// changes" assertion is independent of the developer's working tree.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const HOOK_COPIES: Array<[label: string, path: string]> = [
  [
    "templates/hooks/pre-tool.sh",
    join(REPO_ROOT, "templates", "hooks", "pre-tool.sh"),
  ],
  ["hooks/pre-tool.sh", join(REPO_ROOT, "hooks", "pre-tool.sh")],
  [
    ".claude/hooks/pre-tool.sh",
    join(REPO_ROOT, ".claude", "hooks", "pre-tool.sh"),
  ],
];

// Strip env vars that the hook treats as worktree/parallel context — those
// would change behavior for unrelated reasons.
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.SEQUANT_WORKTREE;
  delete env.SEQUANT_ISSUE;
  delete env.CLAUDE_HOOKS_DISABLED;
  return env;
}

function runHook(
  hookPath: string,
  toolInput: string,
  cwd: string,
): { code: number; stderr: string } {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: toolInput },
  });
  const result = spawnSync("bash", [hookPath], {
    input: payload,
    cwd,
    env: cleanEnv(),
    encoding: "utf8",
  });
  return {
    code: result.status ?? -1,
    stderr: result.stderr ?? "",
  };
}

describe.each(HOOK_COPIES)(
  "pre-tool.sh regex exclusions for gh issue/pr (#564) [%s]",
  (_label, hookPath) => {
    let cleanRepo: string;

    beforeAll(() => {
      // AC-4 needs an isolated git repo with no staged or unstaged changes.
      cleanRepo = mkdtempSync(join(tmpdir(), "pre-tool-test-"));
      spawnSync("git", ["init", "-q"], { cwd: cleanRepo });
      spawnSync("git", ["config", "user.email", "test@test"], {
        cwd: cleanRepo,
      });
      spawnSync("git", ["config", "user.name", "test"], { cwd: cleanRepo });
    });

    afterAll(() => {
      rmSync(cleanRepo, { recursive: true, force: true });
    });

    // AC-1: force-push regex skips gh issue/pr payloads
    it("AC-1: allows gh issue create whose body references force-push", () => {
      const cmd = `gh issue create --title "x" --body "Use git push --force only when..."`;
      const { code } = runHook(hookPath, cmd, cleanRepo);
      expect(code).toBe(0);
    });

    it("AC-1b: allows gh pr comment whose body references force-with-lease", () => {
      const cmd = `gh pr comment 1 --body "see git push --force-with-lease docs"`;
      const { code } = runHook(hookPath, cmd, cleanRepo);
      expect(code).toBe(0);
    });

    // AC-2: no-changes guard skips gh issue/pr payloads
    it("AC-2: allows gh issue comment whose body references git commit", () => {
      const cmd = `gh issue comment 564 --body "Run git commit -m 'msg' to finish"`;
      const { code } = runHook(hookPath, cmd, cleanRepo);
      expect(code).toBe(0);
    });

    it("AC-2b: allows gh pr create whose body references git commit", () => {
      const cmd = `gh pr create --title "x" --body "Squash with git commit --amend"`;
      const { code } = runHook(hookPath, cmd, cleanRepo);
      expect(code).toBe(0);
    });

    // AC-3: force-push regex still blocks the actual command
    it("AC-3: blocks real `git push --force`", () => {
      const { code, stderr } = runHook(hookPath, "git push --force", cleanRepo);
      expect(code).toBe(2);
      expect(stderr).toMatch(/HOOK_BLOCKED: Force push/);
    });

    it("AC-3b: blocks real `git push -f origin main`", () => {
      const { code, stderr } = runHook(
        hookPath,
        "git push -f origin main",
        cleanRepo,
      );
      expect(code).toBe(2);
      expect(stderr).toMatch(/HOOK_BLOCKED: Force push/);
    });

    // AC-4: no-changes guard still blocks real `git commit` with empty staging
    it("AC-4: blocks real `git commit -m 'msg'` with no staged changes", () => {
      const { code, stderr } = runHook(
        hookPath,
        "git commit -m 'msg'",
        cleanRepo,
      );
      expect(code).toBe(2);
      expect(stderr).toMatch(/HOOK_BLOCKED: No changes to commit/);
    });

    it("AC-4b: still blocks real `git commit` even when other gh tokens appear later", () => {
      // Order matters: the gh-skip is anchored to the START of TOOL_INPUT.
      // A command starting with `git commit` should not get a free pass just
      // because it mentions `gh issue` somewhere downstream.
      const cmd = `git commit -m 'mention gh issue 1 in body'`;
      const { code, stderr } = runHook(hookPath, cmd, cleanRepo);
      expect(code).toBe(2);
      expect(stderr).toMatch(/HOOK_BLOCKED: No changes to commit/);
    });

    // Regression guard: the gh-skip must require the START anchor; a non-anchored
    // mention of "gh issue" should not bypass the force-push check.
    it("regression: `echo gh issue && git push --force` is still blocked", () => {
      const cmd = `echo gh issue && git push --force`;
      const { code, stderr } = runHook(hookPath, cmd, cleanRepo);
      expect(code).toBe(2);
      expect(stderr).toMatch(/HOOK_BLOCKED: Force push/);
    });

    // Sanity: when there ARE staged changes, the no-changes guard does not fire
    // for a real `git commit`. (The conventional-commits validator may still
    // block based on message format — that's a separate guard. We only assert
    // the no-changes guard is path-correct.)
    it("sanity: no-changes guard does not fire when changes are staged", () => {
      const repo = mkdtempSync(join(tmpdir(), "pre-tool-test-staged-"));
      try {
        spawnSync("git", ["init", "-q"], { cwd: repo });
        spawnSync("git", ["config", "user.email", "test@test"], { cwd: repo });
        spawnSync("git", ["config", "user.name", "test"], { cwd: repo });
        writeFileSync(join(repo, "f.txt"), "hello\n");
        spawnSync("git", ["add", "f.txt"], { cwd: repo });
        const { stderr } = runHook(hookPath, "git commit -m 'feat: x'", repo);
        // The no-changes guard MUST NOT fire (changes are staged).
        expect(stderr).not.toMatch(/HOOK_BLOCKED: No changes to commit/);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  },
);
