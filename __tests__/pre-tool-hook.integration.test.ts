// Tests for Issue #564 — pre-tool.sh regexes must skip gh issue/pr body content.
// Extended in Issue #570 to cover the four additional regex sites left out of
// scope by #564: destructive system commands, deployment commands, git reset
// outer guard, and gh workflow run.
//
// Reworked in Issue #763: the `^gh (issue|pr) ` prefix carve-outs were removed
// entirely and replaced with segment-aware, command-word matching. The carve-
// outs could be disarmed by prefixing a real `gh issue`/`gh pr` command
// (`gh issue list && git push --force` walked through the force-push guard),
// and re-broke on any `cd <dir> && gh issue ...` prefix. The #763 describe
// block at the bottom of this file encodes both failure directions — anchored
// bypass (must still block) and body-text / cd-prefix false positives (must
// still allow) — the exact directions the pre-#763 suite lacked.
//
// The hook script is mirrored across three locations (templates/hooks/,
// hooks/, and .claude/hooks/), none of which are symlinks. To prevent
// future drift in any one copy, this suite parametrizes every assertion
// over all three. AC-4 uses an isolated tmp git repo so the "no staged
// changes" assertion is independent of the developer's working tree.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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

// Isolated log home so the hook's timing/block logs never land in the repo
// under test. The hook writes to $CLAUDE_PLUGIN_DATA/logs when set (the real
// plugin scenario); without it the fallback is a repo-local .sequant/logs,
// which would show up in `git status` and break the no-changes guard's
// emptiness check for these bare test repos (#763). Pointing the logs at a
// throwaway dir keeps the tested repos clean.
const LOG_HOME = mkdtempSync(join(tmpdir(), "pre-tool-loghome-"));

// Strip env vars that the hook treats as worktree/parallel context — those
// would change behavior for unrelated reasons.
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.SEQUANT_WORKTREE;
  delete env.SEQUANT_ISSUE;
  delete env.CLAUDE_HOOKS_DISABLED;
  env.CLAUDE_PLUGIN_DATA = LOG_HOME;
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

    // === Issue #570: four additional regex sites ===
    // Same gh-skip idiom applied to: destructive system commands, deployment
    // commands, git reset outer guard, and gh workflow run.

    // AC-1 (#570): destructive system commands regex skips gh issue/pr payloads
    it("#570 AC-1: allows gh issue create whose body references rm -rf /", () => {
      const cmd = `gh issue create --title "x" --body "WARNING: never run rm -rf / on production"`;
      const { code } = runHook(hookPath, cmd, cleanRepo);
      expect(code).toBe(0);
    });

    it("#570 AC-1b: allows gh pr comment whose body references sudo", () => {
      const cmd = `gh pr comment 1 --body "Don't sudo on shared boxes"`;
      const { code } = runHook(hookPath, cmd, cleanRepo);
      expect(code).toBe(0);
    });

    // AC-2 (#570): deployment regex skips gh issue/pr payloads
    it("#570 AC-2: allows gh issue create whose body references vercel deploy", () => {
      const cmd = `gh issue create --title "x" --body "release notes: deployed via vercel deploy"`;
      const { code } = runHook(hookPath, cmd, cleanRepo);
      expect(code).toBe(0);
    });

    it("#570 AC-2b: allows gh pr create whose body references kubectl apply", () => {
      const cmd = `gh pr create --title "x" --body "uses kubectl apply -f manifest.yaml"`;
      const { code } = runHook(hookPath, cmd, cleanRepo);
      expect(code).toBe(0);
    });

    // AC-3 (#570): git reset outer guard skips gh issue/pr payloads.
    // Use a dirty repo (uncommitted changes) so the inner BLOCK_REASONS
    // accumulator WOULD block — the only thing letting the call through is
    // the outer ^gh (issue|pr)  exclusion. cleanRepo would silently pass
    // even when the outer guard is unwrapped (spec phase Open Question #2).
    it("#570 AC-3: allows gh issue comment whose body references git reset --hard", () => {
      const repo = mkdtempSync(join(tmpdir(), "pre-tool-test-dirty-"));
      try {
        spawnSync("git", ["init", "-q"], { cwd: repo });
        spawnSync("git", ["config", "user.email", "test@test"], { cwd: repo });
        spawnSync("git", ["config", "user.name", "test"], { cwd: repo });
        writeFileSync(join(repo, "f.txt"), "hello\n");
        const cmd = `gh issue comment 1 --body "if conflicted, run git reset --hard origin/main"`;
        const { code } = runHook(hookPath, cmd, repo);
        expect(code).toBe(0);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    // AC-4 (#570): gh workflow regex skips gh issue/pr payloads
    it("#570 AC-4: allows gh issue create whose body references gh workflow run", () => {
      const cmd = `gh issue create --title "x" --body "trigger via gh workflow run release.yml"`;
      const { code } = runHook(hookPath, cmd, cleanRepo);
      expect(code).toBe(0);
    });

    it("#570 AC-4b: allows gh pr comment whose body references gh workflow run", () => {
      const cmd = `gh pr comment 1 --body "kicked off via gh workflow run ci.yml"`;
      const { code } = runHook(hookPath, cmd, cleanRepo);
      expect(code).toBe(0);
    });

    // AC-5 (#570): regression — real destructive commands STILL block

    // #763 AC-1/AC-2: the `rm -rf /|~|$HOME` alternation was deleted; `:108`
    // is now a command-word `sudo` guard with its own message. `sudo rm ...`
    // therefore blocks via the sudo guard, not the old "Destructive" one.
    it("#570 AC-5 destructive: blocks real `sudo rm -rf /tmp/x` (now via sudo guard)", () => {
      const { code, stderr } = runHook(
        hookPath,
        "sudo rm -rf /tmp/x",
        cleanRepo,
      );
      expect(code).toBe(2);
      expect(stderr).toMatch(/HOOK_BLOCKED: sudo command/);
    });

    it("#570 AC-5 deployment: blocks real `vercel deploy --prod`", () => {
      const { code, stderr } = runHook(
        hookPath,
        "vercel deploy --prod",
        cleanRepo,
      );
      expect(code).toBe(2);
      expect(stderr).toMatch(/HOOK_BLOCKED: Deployment command/);
    });

    // git reset --hard only blocks when the inner BLOCK_REASONS accumulator
    // finds something to lose. cleanRepo has no uncommitted changes, so we
    // need a dirty fixture to verify the block path is intact.
    it("#570 AC-5 git reset: blocks real `git reset --hard origin/main` with uncommitted changes", () => {
      const repo = mkdtempSync(join(tmpdir(), "pre-tool-test-dirty-"));
      try {
        spawnSync("git", ["init", "-q"], { cwd: repo });
        spawnSync("git", ["config", "user.email", "test@test"], { cwd: repo });
        spawnSync("git", ["config", "user.name", "test"], { cwd: repo });
        writeFileSync(join(repo, "f.txt"), "hello\n");
        const { code, stderr } = runHook(
          hookPath,
          "git reset --hard origin/main",
          repo,
        );
        expect(code).toBe(2);
        expect(stderr).toMatch(
          /HOOK_BLOCKED: git reset --hard would lose local work/,
        );
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it("#570 AC-5 gh workflow: blocks real `gh workflow run release.yml`", () => {
      const { code, stderr } = runHook(
        hookPath,
        "gh workflow run release.yml",
        cleanRepo,
      );
      expect(code).toBe(2);
      expect(stderr).toMatch(/HOOK_BLOCKED: Workflow trigger/);
    });

    // START-anchor regression: a non-anchored mention of "gh issue" must not
    // bypass any of the four wrapped checks. Mirrors the existing #564
    // regression test for force-push.
    it("#570 regression destructive: `echo gh issue && sudo rm -rf /tmp/x` is still blocked", () => {
      const { code, stderr } = runHook(
        hookPath,
        "echo gh issue && sudo rm -rf /tmp/x",
        cleanRepo,
      );
      expect(code).toBe(2);
      // #763: the destructive alternation is gone; `sudo` still blocks, now
      // with its own dedicated message.
      expect(stderr).toMatch(/HOOK_BLOCKED: sudo command/);
    });

    it("#570 regression deployment: `echo gh issue && vercel deploy` is still blocked", () => {
      const { code, stderr } = runHook(
        hookPath,
        "echo gh issue && vercel deploy --prod",
        cleanRepo,
      );
      expect(code).toBe(2);
      expect(stderr).toMatch(/HOOK_BLOCKED: Deployment command/);
    });

    it("#570 regression gh workflow: `echo gh issue && gh workflow run` is still blocked", () => {
      const { code, stderr } = runHook(
        hookPath,
        "echo gh issue && gh workflow run release.yml",
        cleanRepo,
      );
      expect(code).toBe(2);
      expect(stderr).toMatch(/HOOK_BLOCKED: Workflow trigger/);
    });

    // === #570 verbatim issue-body fixtures ===
    // Per feedback_motivating_example_regression: examples quoted verbatim in
    // the issue body are mandatory test fixtures, not "close enough" paraphrases.
    // The strings below are the EXACT scenarios from the #570 issue body
    // (table rows in "Affected regex sites" + the explicit Repro pattern).

    it("#570 verbatim destructive: cleanup-doc explainer payload (issue body row 1)", () => {
      const cmd = 'gh issue create --body "WARNING: never run `rm -rf /`..."';
      const { code } = runHook(hookPath, cmd, cleanRepo);
      expect(code).toBe(0);
    });

    it("#570 verbatim deployment: release-notes payload (issue body row 2)", () => {
      const cmd =
        'gh issue create --body "release notes: deployed via `vercel deploy`..."';
      const { code } = runHook(hookPath, cmd, cleanRepo);
      expect(code).toBe(0);
    });

    it("#570 verbatim git reset: tutorial payload (issue body row 3)", () => {
      // git reset outer guard only triggers in a dirty repo; use the same
      // dirty-fixture pattern as AC-3 to ensure the test exercises the wrap.
      const repo = mkdtempSync(join(tmpdir(), "pre-tool-test-verbatim-"));
      try {
        spawnSync("git", ["init", "-q"], { cwd: repo });
        spawnSync("git", ["config", "user.email", "test@test"], { cwd: repo });
        spawnSync("git", ["config", "user.name", "test"], { cwd: repo });
        writeFileSync(join(repo, "f.txt"), "hello\n");
        const cmd =
          'gh issue comment --body "if conflicted, run `git reset --hard origin/main`..."';
        const { code } = runHook(hookPath, cmd, repo);
        expect(code).toBe(0);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it("#570 verbatim gh workflow: workflow-doc payload (issue body row 4)", () => {
      const cmd =
        'gh issue create --body "trigger via `gh workflow run release.yml`..."';
      const { code } = runHook(hookPath, cmd, cleanRepo);
      expect(code).toBe(0);
    });

    it('#570 verbatim repro pattern (issue body "Repro pattern" section)', () => {
      const cmd =
        'gh issue create --title "x" --body "Don\'t run `rm -rf /` because..."';
      const { code } = runHook(hookPath, cmd, cleanRepo);
      expect(code).toBe(0);
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

// === Issue #763: segment-aware guards; no `^gh (issue|pr) ` carve-outs ===
//
// The carve-outs are gone. Guards now match against the *command words* of
// each shell segment (quotes stripped), so:
//   - a real command chained after an allowed one still blocks (anchored
//     bypass — the regression #564/#570 opened), and
//   - a token that appears only inside a quoted argument, or a command behind
//     a `cd <dir> &&` prefix, is allowed (the false positives the carve-outs
//     papered over, including the `cd`-prefix case that re-broke on filing).
describe.each(HOOK_COPIES)(
  "pre-tool.sh segment-aware guards (#763) [%s]",
  (_label, hookPath) => {
    let cleanRepo: string;

    beforeAll(() => {
      cleanRepo = mkdtempSync(join(tmpdir(), "pre-tool-763-"));
      spawnSync("git", ["init", "-q"], { cwd: cleanRepo });
      spawnSync("git", ["config", "user.email", "test@test"], {
        cwd: cleanRepo,
      });
      spawnSync("git", ["config", "user.name", "test"], { cwd: cleanRepo });
    });

    afterAll(() => {
      rmSync(cleanRepo, { recursive: true, force: true });
    });

    // Dirty-repo helper: git reset --hard only blocks when there is work to
    // lose, so the anchored-bypass reset case needs an uncommitted file.
    function withDirtyRepo(fn: (repo: string) => void): void {
      const repo = mkdtempSync(join(tmpdir(), "pre-tool-763-dirty-"));
      try {
        spawnSync("git", ["init", "-q"], { cwd: repo });
        spawnSync("git", ["config", "user.email", "test@test"], { cwd: repo });
        spawnSync("git", ["config", "user.name", "test"], { cwd: repo });
        writeFileSync(join(repo, "f.txt"), "hello\n");
        fn(repo);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }

    // === AC-3: anchored bypass — a real gh issue/pr command chained with a
    // destructive payload must STILL block. Each row is the exact bypass from
    // the issue's evidence table. These are the cases the pre-#763 suite
    // missed (it used `echo gh issue && …`, which never matched `^gh (issue|pr) `).
    it("AC-3 anchored bypass: `gh issue list && git push --force` blocks", () => {
      const { code, stderr } = runHook(
        hookPath,
        "gh issue list && git push --force",
        cleanRepo,
      );
      expect(code).toBe(2);
      expect(stderr).toMatch(/HOOK_BLOCKED: Force push/);
    });

    it("AC-3 anchored bypass: `gh pr view 1 && vercel deploy --prod` blocks", () => {
      const { code, stderr } = runHook(
        hookPath,
        "gh pr view 1 && vercel deploy --prod",
        cleanRepo,
      );
      expect(code).toBe(2);
      expect(stderr).toMatch(/HOOK_BLOCKED: Deployment command/);
    });

    it("AC-3 anchored bypass: `gh issue list && gh workflow run release.yml` blocks", () => {
      const { code, stderr } = runHook(
        hookPath,
        "gh issue list && gh workflow run release.yml",
        cleanRepo,
      );
      expect(code).toBe(2);
      expect(stderr).toMatch(/HOOK_BLOCKED: Workflow trigger/);
    });

    it("AC-3 anchored bypass: `gh issue list && sudo rm -rf /var/lib` blocks", () => {
      const { code, stderr } = runHook(
        hookPath,
        "gh issue list && sudo rm -rf /var/lib",
        cleanRepo,
      );
      expect(code).toBe(2);
      expect(stderr).toMatch(/HOOK_BLOCKED: sudo command/);
    });

    it("AC-3 anchored bypass: `gh issue list && git reset --hard origin/main` blocks (dirty repo)", () => {
      withDirtyRepo((repo) => {
        const { code, stderr } = runHook(
          hookPath,
          "gh issue list && git reset --hard origin/main",
          repo,
        );
        expect(code).toBe(2);
        expect(stderr).toMatch(
          /HOOK_BLOCKED: git reset --hard would lose local work/,
        );
      });
    });

    // AC-3: `:295` worktree validation is warn-only. Prefixing a gh command
    // must not turn it into an exit-2 block — assert no regression.
    it("AC-3 warn-only: `gh issue list && git commit -m 'feat: x'` does not exit 2 on the worktree warning", () => {
      // Stage a change so the no-changes guard does not fire; use a valid
      // conventional message so the commit-format guard does not fire. What
      // remains is the warn-only worktree check, which must never exit 2.
      const repo = mkdtempSync(join(tmpdir(), "pre-tool-763-warn-"));
      try {
        spawnSync("git", ["init", "-q"], { cwd: repo });
        spawnSync("git", ["config", "user.email", "test@test"], { cwd: repo });
        spawnSync("git", ["config", "user.name", "test"], { cwd: repo });
        writeFileSync(join(repo, "f.txt"), "hello\n");
        spawnSync("git", ["add", "f.txt"], { cwd: repo });
        const { code } = runHook(
          hookPath,
          "gh issue list && git commit -m 'feat: x'",
          repo,
        );
        expect(code).toBe(0);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    // === AC-4: false positives stay fixed WITHOUT the carve-out. Body text
    // and the `cd <dir> &&` prefix must be allowed.
    it('AC-4: `gh issue create --body "...git push --force..."` is allowed', () => {
      const cmd = `gh issue create --title "x" --body "run git push --force only when rebasing"`;
      const { code } = runHook(hookPath, cmd, cleanRepo);
      expect(code).toBe(0);
    });

    it('AC-4: `cd <dir> && gh issue create --title "...git push --force..."` is allowed (the cd-prefix case that re-broke on filing)', () => {
      const cmd = `cd ${cleanRepo} && gh issue create --title "fix: git push --force disarms guard" --body "details"`;
      const { code } = runHook(hookPath, cmd, cleanRepo);
      expect(code).toBe(0);
    });

    it('AC-4: `cd <dir> && gh pr comment 1 --body "...sudo rm -rf /..."` is allowed', () => {
      const cmd = `cd ${cleanRepo} && gh pr comment 1 --body "never run sudo rm -rf / on prod"`;
      const { code } = runHook(hookPath, cmd, cleanRepo);
      expect(code).toBe(0);
    });

    // === AC-1: the `rm` alternation is gone; ordinary absolute-path deletes
    // that the old `/`-substring match blocked are now allowed. Catastrophic
    // deletes are left to Claude Code's native analyzer.
    it("AC-1: `rm -rf /tmp/scratch/build` is allowed (no longer substring-blocked)", () => {
      const { code, stderr } = runHook(
        hookPath,
        "rm -rf /tmp/scratch/build",
        cleanRepo,
      );
      expect(code).toBe(0);
      expect(stderr).not.toMatch(/HOOK_BLOCKED/);
    });

    it("AC-1: an absolute worktree-path delete is allowed", () => {
      const { code } = runHook(
        hookPath,
        "rm -rf /Users/dev/Projects/worktrees/feature/38-cell-protocol",
        cleanRepo,
      );
      expect(code).toBe(0);
    });

    // === AC-2: `sudo` guard matches only at a command-word position. A naive
    // anchor was empirically shown to still block the `echo` case, so these
    // are tested, not eyeballed.
    it("AC-2: `echo 'never use sudo here'` is allowed (sudo inside a quoted arg)", () => {
      const { code, stderr } = runHook(
        hookPath,
        `echo 'never use sudo here'`,
        cleanRepo,
      );
      expect(code).toBe(0);
      expect(stderr).not.toMatch(/HOOK_BLOCKED: sudo/);
    });

    it("AC-2: `grep -r sudoku src/` is allowed (sudo is a substring of a word)", () => {
      const { code, stderr } = runHook(
        hookPath,
        "grep -r sudoku src/",
        cleanRepo,
      );
      expect(code).toBe(0);
      expect(stderr).not.toMatch(/HOOK_BLOCKED: sudo/);
    });

    it('AC-2: `git commit -m "docs: sudo policy"` does not fire the sudo guard', () => {
      // May block for no-changes, but MUST NOT block as a sudo command.
      const { stderr } = runHook(
        hookPath,
        `git commit -m "docs: sudo policy"`,
        cleanRepo,
      );
      expect(stderr).not.toMatch(/HOOK_BLOCKED: sudo/);
    });

    it("AC-2: real `sudo rm -rf /var/lib` blocks with the sudo message", () => {
      const { code, stderr } = runHook(
        hookPath,
        "sudo rm -rf /var/lib",
        cleanRepo,
      );
      expect(code).toBe(2);
      expect(stderr).toMatch(/HOOK_BLOCKED: sudo command/);
    });

    // === AC-5: blocked commands are logged with the offending text + the rule
    // that fired, redacted, to a single sink.
    it("AC-5: a block logs the command text and rule id, with secrets redacted", () => {
      const pluginData = mkdtempSync(join(tmpdir(), "pre-tool-763-plugin-"));
      try {
        // Build the token at runtime so no secret-shaped literal is committed
        // (it would trip both this very hook's secret check and GitHub push
        // protection). Still matches check_secrets' `ghp_[a-zA-Z0-9]{36}`.
        const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
        const cmd = `sudo rm -rf /var/lib # token ${token}`;
        const payload = JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: cmd },
        });
        const result = spawnSync("bash", [hookPath], {
          input: payload,
          cwd: cleanRepo,
          env: { ...cleanEnv(), CLAUDE_PLUGIN_DATA: pluginData },
          encoding: "utf8",
        });
        expect(result.status).toBe(2);

        const log = readFileSync(
          join(pluginData, "logs", "claude-hook.log"),
          "utf8",
        );
        // Rule id present, command text present, token redacted.
        expect(log).toMatch(/BLOCKED \[sudo\]/);
        expect(log).toContain("sudo rm -rf /var/lib");
        expect(log).not.toContain(token);
        expect(log).toContain("[REDACTED]");
      } finally {
        rmSync(pluginData, { recursive: true, force: true });
      }
    });
  },
);
