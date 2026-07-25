/**
 * End-to-end integration tests for the combined-branch test (#803)
 *
 * Real git: a real bare `origin`, a real clone, real feature branches, a real
 * `git merge` into a real temp branch, and the real `git diff` that decides
 * whether the lockfile moved. Only the package manager is stubbed — a shell
 * script named `npm`, placed first on PATH, that appends its argv to a log and
 * exits with a configurable code.
 *
 * This is the layer the unit tests cannot reach. They mock `spawnSync` and so
 * assert on the sequence the code *intends*; these assert that a genuine
 * two-branch stack whose merge changes `package-lock.json` actually reaches the
 * install step, and that the install genuinely precedes test/build.
 *
 * Reproduces the #109-113 shape from the issue: several branches, each adding a
 * dependency, whose combined state was reported BLOCKED because the check
 * tested against the node_modules of whatever branch the user was on.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runCombinedBranchTest } from "./combined-branch-test.js";
import type { BranchInfo } from "./types.js";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

/**
 * Baseline lockfile with one reserved, padded slot per feature branch.
 *
 * Each branch rewrites only its own slot line. The padding lines between slots
 * keep the edits non-adjacent, so real `git merge` resolves a multi-branch
 * dependency stack cleanly — which is the whole point of the fixture. Writing
 * the same JSON object from every branch would conflict instead, and the check
 * would bail at the merge step before ever reaching the install under test.
 */
function baselineLockfile(): string {
  return [
    "{",
    '  "name": "fixture",',
    '  "lockfileVersion": 3,',
    '  "packages": {',
    '    "SLOT_A": { "version": "0.0.0" },',
    '    "_pad_a": { "version": "0.0.0" },',
    '    "SLOT_B": { "version": "0.0.0" },',
    '    "_pad_b": { "version": "0.0.0" },',
    '    "SLOT_C": { "version": "0.0.0" }',
    "  }",
    "}",
    "",
  ].join("\n");
}

/** Baseline manifest, slotted the same way as the lockfile. */
function baselineManifest(): string {
  return [
    "{",
    '  "name": "fixture",',
    '  "dependencies": {',
    '    "SLOT_A": "0.0.0",',
    '    "_pad_a": "0.0.0",',
    '    "SLOT_B": "0.0.0",',
    '    "_pad_b": "0.0.0",',
    '    "SLOT_C": "0.0.0"',
    "  }",
    "}",
    "",
  ].join("\n");
}

/** Claim one slot in a slotted file for a real dependency name. */
function claimSlot(contents: string, slot: string, dep: string): string {
  return contents.replace(new RegExp(`"${slot}"`, "g"), `"${dep}"`);
}

describe.skipIf(process.platform === "win32")(
  "combined-branch-test (integration, real git)",
  () => {
    let root: string;
    let repo: string;
    let binDir: string;
    let pmLog: string;
    let originalPath: string | undefined;

    /**
     * Install a stub `npm` on PATH.
     *
     * @param failOn argv prefix that should exit non-zero (e.g. "ci")
     * @param failStream where the stub writes its diagnostics
     */
    function stubPackageManager(
      failOn?: string,
      failStream: "stdout" | "stderr" | "none" = "stderr",
    ): void {
      const emit =
        failStream === "none"
          ? ""
          : failStream === "stdout"
            ? 'echo "npm error: simulated failure detail"'
            : 'echo "npm error: simulated failure detail" >&2';

      writeFileSync(
        join(binDir, "npm"),
        [
          "#!/bin/sh",
          `echo "$@" >> "${pmLog}"`,
          // `:` keeps the `then` branch non-empty when the stub is asked to
          // fail silently on both streams.
          failOn
            ? `if [ "$1" = "${failOn}" ]; then ${emit || ":"}; exit 1; fi`
            : "",
          "exit 0",
        ].join("\n"),
        "utf-8",
      );
      chmodSync(join(binDir, "npm"), 0o755);
    }

    /** Commands the stub package manager received, in order. */
    function pmInvocations(): string[] {
      if (!existsSync(pmLog)) return [];
      return readFileSync(pmLog, "utf-8").trim().split("\n").filter(Boolean);
    }

    /**
     * Create a feature branch off main that adds `dep`.
     *
     * @param slot which reserved lockfile/manifest slot this branch claims —
     *        omit to make a branch that touches only source files (the "no
     *        reinstall needed" case)
     */
    function createFeatureBranch(
      branchName: string,
      dep: string,
      slot?: "SLOT_A" | "SLOT_B" | "SLOT_C",
    ): void {
      git(repo, "checkout", "-b", branchName, "main");
      writeFileSync(join(repo, `${dep}.js`), `module.exports = "${dep}";\n`);
      git(repo, "add", `${dep}.js`);
      if (slot) {
        // A dependency addition touches both manifest and lockfile.
        writeFileSync(
          join(repo, "package.json"),
          claimSlot(baselineManifest(), slot, dep),
        );
        writeFileSync(
          join(repo, "package-lock.json"),
          claimSlot(baselineLockfile(), slot, dep),
        );
        git(repo, "add", "package.json", "package-lock.json");
      }
      git(repo, "commit", "-m", `feat: add ${dep}`);
      git(repo, "push", "-u", "origin", branchName);
      git(repo, "checkout", "main");
    }

    function branchInfo(issueNumber: number, branch: string): BranchInfo {
      return {
        issueNumber,
        title: `Issue ${issueNumber}`,
        branch,
        filesModified: [],
        // Set so getBranchRef() resolves the local branch rather than origin/*,
        // matching how merge-check treats branches that have a worktree.
        worktreePath: repo,
      };
    }

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "sequant-cbt-"));
      repo = join(root, "repo");
      binDir = join(root, "bin");
      pmLog = join(root, "pm.log");

      spawnSync("mkdir", ["-p", binDir]);

      // Bare origin + clone, so `git fetch origin` and `origin/main` are real.
      git(root, "init", "--bare", "--initial-branch=main", "origin.git");
      spawnSync("git", ["clone", join(root, "origin.git"), repo], {
        encoding: "utf-8",
      });
      git(repo, "config", "user.email", "test@sequant.test");
      git(repo, "config", "user.name", "Test");
      git(repo, "config", "commit.gpgsign", "false");

      // Baseline main: a package.json and a lockfile with no dependencies.
      writeFileSync(join(repo, "package.json"), baselineManifest());
      writeFileSync(join(repo, "package-lock.json"), baselineLockfile());
      git(repo, "add", "package.json", "package-lock.json");
      git(repo, "commit", "-m", "initial commit");
      git(repo, "push", "-u", "origin", "main");

      originalPath = process.env.PATH;
      process.env.PATH = `${binDir}:${originalPath}`;
      stubPackageManager();
    });

    afterEach(() => {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    });

    it("reinstalls and passes for a real two-branch stack that moved the lockfile", () => {
      // The #109-113 shape: every branch adds a dependency.
      createFeatureBranch("feature/109-audio", "howler", "SLOT_A");
      createFeatureBranch("feature/111-motion", "framer", "SLOT_B");

      const result = runCombinedBranchTest(
        [
          branchInfo(109, "feature/109-audio"),
          branchInfo(111, "feature/111-motion"),
        ],
        repo,
      );

      const invocations = pmInvocations();
      const ciIdx = invocations.indexOf("ci");
      const testIdx = invocations.indexOf("run test");
      const buildIdx = invocations.indexOf("run build");

      // The real git diff detected the real lockfile change and installed.
      expect(ciIdx).toBeGreaterThanOrEqual(0);
      expect(testIdx).toBeGreaterThan(ciIdx);
      expect(buildIdx).toBeGreaterThan(ciIdx);

      // No false BLOCKED.
      expect(result.passed).toBe(true);
      expect(
        result.batchFindings.filter((f) => f.severity === "error"),
      ).toHaveLength(0);
      expect(result.branchResults.map((b) => b.verdict)).toEqual([
        "PASS",
        "PASS",
      ]);
    });

    it("skips the reinstall when the merged branches left the lockfile alone", () => {
      createFeatureBranch("feature/120-docs", "readme");

      const result = runCombinedBranchTest(
        [branchInfo(120, "feature/120-docs")],
        repo,
      );

      expect(pmInvocations()).not.toContain("ci");
      expect(pmInvocations()).toContain("run test");
      expect(result.passed).toBe(true);
    });

    it("restores the original branch and the caller's node_modules", () => {
      createFeatureBranch("feature/109-audio", "howler", "SLOT_A");
      git(repo, "checkout", "main");

      runCombinedBranchTest([branchInfo(109, "feature/109-audio")], repo);

      // Original branch restored, temp branch cleaned up.
      expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(git(repo, "branch", "--list", "merge-check/temp-*")).toBe("");

      // Two frozen installs: one for the combined state, one to restore.
      expect(pmInvocations().filter((c) => c === "ci")).toHaveLength(2);

      // And the restore never used a lockfile-rewriting install.
      expect(pmInvocations()).not.toContain("install --silent");
    });

    it("leaves the caller's working tree clean", () => {
      createFeatureBranch("feature/109-audio", "howler", "SLOT_A");

      runCombinedBranchTest([branchInfo(109, "feature/109-audio")], repo);

      // A mutating `npm install` here would have rewritten package-lock.json
      // and left the user's branch dirty.
      expect(git(repo, "status", "--porcelain")).toBe("");
    });

    it("reports a real merge conflict without reaching install or test", () => {
      // Two branches editing the same line of the same file.
      git(repo, "checkout", "-b", "feature/130-a", "main");
      writeFileSync(join(repo, "conflict.txt"), "from A\n");
      git(repo, "add", "conflict.txt");
      git(repo, "commit", "-m", "feat: A");
      git(repo, "push", "-u", "origin", "feature/130-a");
      git(repo, "checkout", "main");

      git(repo, "checkout", "-b", "feature/131-b", "main");
      writeFileSync(join(repo, "conflict.txt"), "from B\n");
      git(repo, "add", "conflict.txt");
      git(repo, "commit", "-m", "feat: B");
      git(repo, "push", "-u", "origin", "feature/131-b");
      git(repo, "checkout", "main");

      const result = runCombinedBranchTest(
        [branchInfo(130, "feature/130-a"), branchInfo(131, "feature/131-b")],
        repo,
      );

      expect(result.passed).toBe(false);
      expect(
        result.batchFindings.some((f) => f.message.includes("merge conflicts")),
      ).toBe(true);
      expect(pmInvocations()).not.toContain("ci");
      expect(pmInvocations()).not.toContain("run test");
      // Cleanup still happened despite the early return.
      expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    });

    it("surfaces a real install failure distinctly and skips test/build", () => {
      stubPackageManager("ci");
      createFeatureBranch("feature/109-audio", "howler", "SLOT_A");

      const result = runCombinedBranchTest(
        [branchInfo(109, "feature/109-audio")],
        repo,
      );

      expect(result.passed).toBe(false);

      const error = result.batchFindings.find((f) => f.severity === "error");
      expect(error?.message).toContain("Dependency install failed");
      expect(error?.message).toContain("simulated failure detail");

      // The defining behavior of AC-4: no mystery downstream test failure.
      expect(pmInvocations()).not.toContain("run test");
      expect(pmInvocations()).not.toContain("run build");
    });

    it("gives a non-empty reason when a real failure writes only to stdout", () => {
      // The exact #803 symptom: the failure's diagnostics go to stdout, and the
      // old code reported `stderr.slice(0, 500)` — an empty string.
      stubPackageManager("run", "stdout");
      createFeatureBranch("feature/120-docs", "readme");

      const result = runCombinedBranchTest(
        [branchInfo(120, "feature/120-docs")],
        repo,
      );

      const error = result.batchFindings.find(
        (f) => f.severity === "error" && f.message.includes("run test"),
      );
      expect(error?.message).toContain("simulated failure detail");
      expect(error?.message).not.toMatch(/failed on combined state:\s*$/);
    });

    it("gives a non-empty reason when a real failure is silent on both streams", () => {
      stubPackageManager("run", "none");
      createFeatureBranch("feature/120-docs", "readme");

      const result = runCombinedBranchTest(
        [branchInfo(120, "feature/120-docs")],
        repo,
      );

      const error = result.batchFindings.find(
        (f) => f.severity === "error" && f.message.includes("run test"),
      );
      expect(error?.message).toContain("exited with code 1");
      expect(error?.message).not.toMatch(/failed on combined state:\s*$/);
    });
  },
);
