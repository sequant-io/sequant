import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import type { BatchExecutionContext, ExecutionConfig } from "./types.js";

/**
 * #1469 AC-1 — under worktree isolation, an issue whose worktree could not be
 * created fails before any phase, with the git stderr as its abortReason. It
 * never runs in the main checkout (the executor's `process.cwd()` fallback).
 * Both context producers (`executeOneIssue`, `executeBatch`) are covered.
 */

const OK = 1469;
const FAILED = 1470;
const STDERR =
  "error: could not lock config file .git/config: File exists\nerror: unable to write upstream branch configuration";

const fixture = vi.hoisted(() => ({ worktree: "" }));
const spies = vi.hoisted(() => ({
  // Every phase dispatch goes through executePhaseWithRetry, which is what
  // calls executePhase; recording it records every phase and its cwd.
  phase: vi.fn(),
}));

vi.mock("./worktree-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worktree-manager.js")>();
  return {
    ...actual,
    ensureWorktrees: async (...args: unknown[]) => {
      const issues = args[0] as Array<{ number: number }>;
      const provisioning = args[5] as
        { failures?: Map<number, string> } | undefined;
      const map = new Map();
      for (const i of issues) {
        if (i.number === FAILED) {
          provisioning?.failures?.set(
            i.number,
            `git worktree add failed: ${STDERR}`,
          );
          continue;
        }
        map.set(i.number, {
          issue: i.number,
          path: fixture.worktree,
          branch: `feature/${i.number}-test`,
          existed: true,
          rebased: false,
        });
      }
      return map;
    },
  };
});

vi.mock("./phase-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./phase-executor.js")>();
  return {
    ...actual,
    executePhaseWithRetry: async (
      issueNumber: number,
      phase: string,
      _config: unknown,
      _resume: unknown,
      worktreePath?: string,
    ) => {
      spies.phase(issueNumber, phase, worktreePath);
      return { phase, success: true, durationSeconds: 0 };
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
  };
});

import { RunOrchestrator } from "./run-orchestrator.js";
import { executeBatch } from "./batch-executor.js";
import { DEFAULT_SETTINGS } from "../settings.js";

describe("worktree provisioning", () => {
  let repo: string;
  let originalCwd: string;
  let output: string[];
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    repo = mkdtempSync(join(tmpdir(), "worktree-failure-"));
    // The provisioned "worktree" is a separate checkout, so a phase that ran
    // in the main checkout (process.cwd()) is distinguishable from one that
    // ran in the worktree. Both carry the committed phase skills the
    // pre-flight checks.
    fixture.worktree = mkdtempSync(join(tmpdir(), "worktree-failure-wt-"));
    for (const dir of [repo, fixture.worktree]) {
      execSync("git init -b main", { cwd: dir, stdio: "pipe" });
      for (const skill of ["spec", "exec", "qa"]) {
        mkdirSync(join(dir, ".claude/skills", skill), { recursive: true });
        writeFileSync(
          join(dir, ".claude/skills", skill, "SKILL.md"),
          `---\nname: ${skill}\n---\n`,
        );
      }
      execSync(
        "git add . && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -m skills",
        { cwd: dir, stdio: "pipe" },
      );
    }
    process.chdir(repo);
    spies.phase.mockClear();
    output = [];
    log = vi.spyOn(console, "log").mockImplementation((...args) => {
      output.push(args.join(" "));
    });
  });

  afterEach(() => {
    log.mockRestore();
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
    rmSync(fixture.worktree, { recursive: true, force: true });
  });

  it("a missing worktree fails the issue before any phase", async () => {
    const result = await RunOrchestrator.run(
      {
        options: {
          phases: "exec",
          noLog: true,
          autoDetectPhases: false,
          noPr: true,
        },
        settings: DEFAULT_SETTINGS,
        manifest: { stack: "node", packageManager: "npm" as const },
      },
      [String(OK), String(FAILED)],
    );

    const failed = result.results.find((r) => r.issueNumber === FAILED);
    expect(failed?.success).toBe(false);
    expect(failed?.phaseResults).toEqual([]);
    expect(failed?.abortReason).toContain(
      "could not lock config file .git/config",
    );
    expect(output.join("\n")).toContain(
      `#${FAILED}: worktree provisioning failed`,
    );

    // No phase ran for the failed issue — so none ran in the main checkout.
    const calls = spies.phase.mock.calls as Array<[number, string, string?]>;
    expect(calls.filter(([n]) => n === FAILED)).toEqual([]);
    expect(calls.some(([, , cwd]) => cwd === undefined || cwd === repo)).toBe(
      false,
    );

    // The other issue ran its phase in its worktree.
    expect(calls).toContainEqual([OK, "exec", fixture.worktree]);
    expect(result.exitCode).toBe(1);
  });

  it("executeBatch fed the same context yields the same failed result", async () => {
    const config: ExecutionConfig = {
      phases: ["exec"],
      phaseTimeout: 1800,
      qualityLoop: false,
      maxIterations: 1,
      skipVerification: false,
      sequential: true,
      concurrency: 1,
      parallel: false,
      verbose: false,
      noSmartTests: false,
      dryRun: false,
      mcp: false,
      retry: false,
    };
    const markIssueFailed = vi.fn();
    const logWriter = {
      startIssue: vi.fn(),
      markIssueFailed,
      completeIssue: vi.fn(),
      setPRInfo: vi.fn(),
    } as unknown as BatchExecutionContext["logWriter"];
    const results = await executeBatch([FAILED], {
      config,
      options: { autoDetectPhases: false, noPr: true },
      issueInfoMap: new Map([[FAILED, { title: "Issue", labels: [] }]]),
      worktreeMap: new Map(),
      worktreeRequired: true,
      worktreeFailures: new Map([
        [FAILED, `git worktree add failed: ${STDERR}`],
      ]),
      logWriter,
      stateManager: null,
    });

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].phaseResults).toEqual([]);
    expect(results[0].abortReason).toContain(
      "could not lock config file .git/config",
    );
    // The run log carries the stderr too.
    expect(markIssueFailed).toHaveBeenCalledWith(
      FAILED,
      expect.objectContaining({
        abortReason: expect.stringContaining("could not lock config file"),
      }),
    );
    expect(spies.phase).not.toHaveBeenCalled();
  });

  it("isolation off keeps running in the main checkout", async () => {
    const result = await RunOrchestrator.run(
      {
        options: {
          phases: "exec",
          noLog: true,
          autoDetectPhases: false,
          noPr: true,
          worktreeIsolation: false,
        },
        settings: DEFAULT_SETTINGS,
        manifest: { stack: "node", packageManager: "npm" as const },
      },
      [String(FAILED)],
    );
    expect(result.results[0].abortReason ?? "").not.toContain(
      "worktree provisioning failed",
    );
    expect(spies.phase).toHaveBeenCalledWith(FAILED, "exec", undefined);
  });
});
