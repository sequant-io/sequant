import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import type { IssueResult } from "./types.js";

/**
 * #1354 AC-1 — `sequant run` warns, before provisioning worktrees, when
 * tracked skills in the main checkout have uncommitted changes, and names the
 * committed version the phases will actually use.
 */

const spies = vi.hoisted(() => ({ ensureWorktrees: vi.fn() }));

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
    }): Promise<IssueResult> => ({
      issueNumber: ctx.issueNumber,
      success: true,
      phaseResults: [],
      durationSeconds: 0,
      loopTriggered: false,
    }),
  };
});

import { RunOrchestrator } from "./run-orchestrator.js";
import { DEFAULT_SETTINGS } from "../settings.js";

const GIT = "git -c user.email=t@t -c user.name=t -c commit.gpgsign=false";

function writeSkills(repo: string, version: string, body: string): void {
  for (const skill of ["spec", "exec", "qa"]) {
    mkdirSync(join(repo, ".claude/skills", skill), { recursive: true });
    writeFileSync(
      join(repo, ".claude/skills", skill, "SKILL.md"),
      `---\nname: ${skill}\n---\n${body}\n`,
    );
  }
  writeFileSync(join(repo, ".claude/skills/.sequant-version"), version);
}

describe("run warns about uncommitted skills (#1354 AC-1)", () => {
  let repo: string;
  let originalCwd: string;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    repo = mkdtempSync(join(tmpdir(), "run-skills-commit-"));
    execSync("git init -b main", { cwd: repo, stdio: "pipe" });
    writeSkills(repo, "2.15.1", "old");
    execSync(`git add . && ${GIT} commit -m init`, { cwd: repo, stdio: "pipe" });
    process.chdir(repo);
    spies.ensureWorktrees.mockClear();
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  function run() {
    return RunOrchestrator.run(
      {
        options: { phases: "spec,exec,qa", noLog: true },
        settings: DEFAULT_SETTINGS,
        manifest: { stack: "node", packageManager: "npm" as const },
      },
      ["999"],
    );
  }

  function printed(): string {
    return log.mock.calls.map((c) => String(c[0])).join("\n");
  }

  it("names the committed version, before any worktree is provisioned", async () => {
    writeSkills(repo, "2.18.0", "new");
    let printedBeforeProvisioning = "";
    spies.ensureWorktrees.mockImplementationOnce(() => {
      printedBeforeProvisioning = printed();
    });

    await run();

    expect(printed()).toContain("committed skills (2.15.1)");
    expect(printedBeforeProvisioning).toContain("committed skills (2.15.1)");
  });

  it("says nothing when the skills are committed", async () => {
    await run();
    expect(printed()).not.toContain("uncommitted changes");
  });
});
