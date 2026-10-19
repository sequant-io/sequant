import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import type { IssueResult } from "./types.js";

/**
 * #1386 AC-1/AC-2 — the base resolved once (`--base` → `settings.run.defaultBase`
 * → detected default) is the value worktree creation receives AND the value the
 * per-issue context carries to `rebaseBeforePR` / `createPR`.
 * (batch-executor.test.ts asserts the second hop reaches those two consumers.)
 */

const fixture = vi.hoisted(() => ({ worktree: "" }));
const spies = vi.hoisted(() => ({
  ensureWorktrees: vi.fn(),
  issueCtxBase: vi.fn(),
}));

vi.mock("./worktree-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worktree-manager.js")>();
  return {
    ...actual,
    ensureWorktrees: async (...args: unknown[]) => {
      spies.ensureWorktrees(...args);
      const issues = args[0] as Array<{ number: number }>;
      return new Map(
        issues.map((i) => [
          i.number,
          {
            issue: i.number,
            path: fixture.worktree,
            branch: `feature/${i.number}-test`,
            existed: true,
            rebased: false,
          },
        ]),
      );
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
      baseBranch?: string;
    }): Promise<IssueResult> => {
      spies.issueCtxBase(ctx.baseBranch);
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

describe("run resolves the base once (#1386)", () => {
  let repo: string;
  let originalCwd: string;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    repo = mkdtempSync(join(tmpdir(), "run-base-parity-"));
    execSync("git init -b main", { cwd: repo, stdio: "pipe" });
    execSync(
      "git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit --allow-empty -m init",
      { cwd: repo, stdio: "pipe" },
    );
    // The skills pre-flight reads the provisioned worktree: use the repo
    // itself, with the three phase skills committed.
    for (const skill of ["spec", "exec", "qa"]) {
      mkdirSync(join(repo, ".claude/skills", skill), { recursive: true });
      writeFileSync(
        join(repo, ".claude/skills", skill, "SKILL.md"),
        `---\nname: ${skill}\n---\n`,
      );
    }
    execSync(
      "git add . && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -m skills",
      { cwd: repo, stdio: "pipe" },
    );
    fixture.worktree = repo;
    process.chdir(repo);
    spies.ensureWorktrees.mockClear();
    spies.issueCtxBase.mockClear();
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  function run(opts: { base?: string; defaultBase?: string }) {
    return RunOrchestrator.run(
      {
        options: { phases: "exec", noLog: true, base: opts.base },
        settings: {
          ...DEFAULT_SETTINGS,
          run: { ...DEFAULT_SETTINGS.run, defaultBase: opts.defaultBase },
        },
        manifest: { stack: "node", packageManager: "npm" as const },
      },
      ["999"],
    );
  }

  it("AC-1: --base reaches worktree creation and the issue context as one value", async () => {
    await run({ base: "feat/x" });

    // `baseBranch` is ensureWorktrees' 4th positional argument.
    expect(spies.ensureWorktrees.mock.calls[0][3]).toBe("feat/x");
    expect(spies.issueCtxBase).toHaveBeenCalledWith("feat/x");
  });

  it("AC-2: settings.run.defaultBase has the same effect with no CLI option", async () => {
    await run({ defaultBase: "feat/y" });

    expect(spies.ensureWorktrees.mock.calls[0][3]).toBe("feat/y");
    expect(spies.issueCtxBase).toHaveBeenCalledWith("feat/y");
  });

  it("AC-3: neither set resolves the detected default for both consumers", async () => {
    await run({});

    const created = spies.ensureWorktrees.mock.calls[0][3];
    expect(created).toBe("main");
    expect(spies.issueCtxBase).toHaveBeenCalledWith(created);
  });
});
