import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import type { IssueResult } from "./types.js";

/**
 * #813 AC-5 — a run against a tree with no `.claude/skills/` must exit
 * non-zero without writing a state entry or running any phase, and an
 * aider-driver run on the same tree must still execute (AC-3).
 *
 * #933 moved the pre-flight to run AFTER worktree provisioning, checked
 * against each worktree instead of the main checkout — so unlike the
 * original #813 version of this test, `ensureWorktrees` IS now expected to
 * be called even on the failing path (worktree provisioning happens first;
 * the pre-flight is what stops the *phase* from running). See
 * `skills-preflight.test.ts`'s "#933" tests for the worktree-targeting
 * behavior itself.
 */

const spies = vi.hoisted(() => ({
  ensureWorktrees: vi.fn(),
  runIssue: vi.fn(),
}));

vi.mock("./worktree-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worktree-manager.js")>();
  return {
    ...actual,
    ensureWorktrees: async (...args: unknown[]) => {
      spies.ensureWorktrees(...args);
      return new Map();
    },
    ensureWorktreesChain: async (...args: unknown[]) => {
      spies.ensureWorktrees(...args);
      return new Map();
    },
  };
});

vi.mock("./batch-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./batch-executor.js")>();
  return {
    ...actual,
    getIssueInfo: async (issueNumber: number) => ({
      title: `Issue ${issueNumber}`,
      labels: [],
    }),
    runIssueWithLogging: async (ctx: {
      issueNumber: number;
    }): Promise<IssueResult> => {
      spies.runIssue(ctx.issueNumber);
      return {
        issueNumber: ctx.issueNumber,
        success: true,
        phaseResults: [],
        durationSeconds: 0,
        loopTriggered: false,
      };
    },
  };
});

import { RunOrchestrator } from "./run-orchestrator.js";
import { DEFAULT_SETTINGS } from "../settings.js";

describe("run skills pre-flight (#813 AC-5 integration)", () => {
  let base: string;
  let repo: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    base = mkdtempSync(join(tmpdir(), "preflight-run-"));
    repo = join(base, "repo");
    mkdirSync(repo);
    execSync("git init -b main", { cwd: repo, stdio: "pipe" });
    writeFileSync(join(repo, "README.md"), "# test\n");
    execSync(
      // `-c commit.gpgsign=false`: contributors with global commit signing have
      // no pinentry in a test run, so this commit died with "gpg: signing
      // failed". CI has no signing key and never noticed.
      "git add . && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -m init",
      {
        cwd: repo,
        stdio: "pipe",
      },
    );
    process.chdir(repo);
    spies.ensureWorktrees.mockClear();
    spies.runIssue.mockClear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
  });

  function init(options: Record<string, unknown>) {
    return {
      options,
      settings: DEFAULT_SETTINGS,
      manifest: { stack: "node", packageManager: "npm" as const },
    };
  }

  it("exits non-zero without a state entry when .claude/skills/ is missing, without running any phase", async () => {
    const result = await RunOrchestrator.run(
      init({ phases: "spec,exec,qa", noLog: true }),
      ["999"],
    );

    expect(result.exitCode).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].abortReason).toContain("skills pre-flight failed");

    // #933: worktree provisioning now happens BEFORE the pre-flight, so
    // ensureWorktrees is expected to run — the pre-flight stops the phase.
    expect(spies.ensureWorktrees).toHaveBeenCalledTimes(1);
    // No phase executed.
    expect(spies.runIssue).not.toHaveBeenCalled();
    // No state entry was written for the issue.
    const statePath = join(repo, ".sequant", "state.json");
    if (existsSync(statePath)) {
      const state = JSON.parse(
        execSync(`cat ${JSON.stringify(statePath)}`).toString(),
      );
      expect(state.issues?.["999"]).toBeUndefined();
    }
  });

  it("AC-3: an aider-driver run with no .claude/skills/ still executes", async () => {
    const result = await RunOrchestrator.run(
      init({ phases: "spec,exec,qa", noLog: true, agent: "aider" }),
      ["998"],
    );

    // The pre-flight let the run through to worktree provisioning + execution.
    expect(spies.ensureWorktrees).toHaveBeenCalledTimes(1);
    expect(spies.runIssue).toHaveBeenCalledWith(998);
    expect(result.exitCode).toBe(0);
    expect(
      result.results.find((r) => r.issueNumber === 998)?.abortReason,
    ).toBeUndefined();
  });
});
