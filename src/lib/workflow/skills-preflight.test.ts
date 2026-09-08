import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import {
  driverResolvesSkills,
  resolveRequiredSkills,
  runSkillsPreflight,
} from "./skills-preflight.js";
import { SKILLS_DIR } from "../skills-check.js";
import type { Phase } from "./types.js";
import type { IssueResult } from "./types.js";
import { RunOrchestrator } from "./run-orchestrator.js";
import { DEFAULT_SETTINGS } from "../settings.js";

// #933: RunOrchestrator now runs the pre-flight against each provisioned
// worktree, not the main checkout. These mocks let the tests below drive the
// real `RunOrchestrator.run()` with a real `git worktree add` (so the
// worktree genuinely only has tracked files) while keeping the run hermetic
// and fast — no `gh` calls, no phase execution, no `npm install` from the
// worktree's dependency-install step.
const worktreeFixture = vi.hoisted(() => ({ base: "", repo: "" }));
const spies933 = vi.hoisted(() => ({
  runIssue: vi.fn(),
  preflightCwds: [] as string[],
}));

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
      spies933.runIssue(ctx.issueNumber);
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

vi.mock("./worktree-manager.js", async (importOriginal) => {
  const { execSync: sync } = await import("child_process");
  const { join: pathJoin } = await import("path");
  const { existsSync: exists } = await import("fs");
  const actual = await importOriginal<typeof import("./worktree-manager.js")>();
  return {
    ...actual,
    ensureWorktrees: async (
      issues: Array<{ number: number; title: string }>,
    ) => {
      const map = new Map();
      for (const issue of issues) {
        const branch = `feature/${issue.number}-test`;
        const worktreePath = pathJoin(
          worktreeFixture.base,
          `wt-${issue.number}`,
        );
        // A worktree the test pre-created is reported as reused (`existed`),
        // mirroring the real ensureWorktrees; otherwise add it for real.
        const existed = exists(worktreePath);
        if (!existed) {
          sync(
            `git worktree add ${JSON.stringify(worktreePath)} -b ${branch}`,
            {
              cwd: worktreeFixture.repo,
              stdio: "pipe",
            },
          );
        }
        map.set(issue.number, {
          issue: issue.number,
          path: worktreePath,
          branch,
          existed,
          rebased: false,
        });
      }
      return map;
    },
  };
});

vi.mock("./skills-preflight.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./skills-preflight.js")>();
  return {
    ...actual,
    runSkillsPreflight: async (
      input: Parameters<typeof actual.runSkillsPreflight>[0],
    ) => {
      // Record EVERY invocation (a cwd-less call is the pre-provisioning
      // shape #933 removed), so a zero-length assertion means zero calls.
      spies933.preflightCwds.push(input.cwd ?? "<no-cwd>");
      return actual.runSkillsPreflight(input);
    },
  };
});

function infoMap(
  entries: Array<[number, string[]]>,
): Map<number, { title: string; labels: string[] }> {
  return new Map(
    entries.map(([n, labels]) => [n, { title: `Issue ${n}`, labels }]),
  );
}

const EXPLICIT_BASE = {
  phases: ["spec", "exec", "qa"] as Phase[],
  autoDetectPhases: false,
  qualityLoop: false,
  issueNumbers: [1],
  issueInfoMap: infoMap([[1, []]]),
};

describe("resolveRequiredSkills (#813 AC-2)", () => {
  it("uses the explicit phase list, not a hardcoded triple", () => {
    const skills = resolveRequiredSkills({
      ...EXPLICIT_BASE,
      phases: ["exec", "qa"] as Phase[],
    });
    expect(skills).toEqual(["exec", "qa"]);
    expect(skills).not.toContain("spec");
  });

  it("includes testgen when --testgen is set", () => {
    const skills = resolveRequiredSkills({
      ...EXPLICIT_BASE,
      testgen: true,
    });
    expect(skills).toContain("testgen");
  });

  it("includes security-review when --security-review is set", () => {
    const skills = resolveRequiredSkills({
      ...EXPLICIT_BASE,
      securityReview: true,
    });
    expect(skills).toContain("security-review");
  });

  it("includes the test skill for issues with UI labels", () => {
    const skills = resolveRequiredSkills({
      ...EXPLICIT_BASE,
      issueInfoMap: infoMap([[1, ["ui"]]]),
    });
    expect(skills).toContain("test");
  });

  it("includes loop when the quality loop is enabled", () => {
    const skills = resolveRequiredSkills({
      ...EXPLICIT_BASE,
      qualityLoop: true,
    });
    expect(skills).toContain("loop");
  });

  it("includes loop when labels auto-enable the quality loop in auto-detect mode", () => {
    const skills = resolveRequiredSkills({
      ...EXPLICIT_BASE,
      autoDetectPhases: true,
      qualityLoop: false,
      issueInfoMap: infoMap([[1, ["complex"]]]),
    });
    expect(skills).toContain("loop");
  });

  it("requires testgen for --testgen even when spec is not in the pipeline (resume path)", () => {
    const skills = resolveRequiredSkills({
      ...EXPLICIT_BASE,
      phases: ["exec", "qa"] as Phase[],
      testgen: true,
    });
    expect(skills).toContain("testgen");
  });

  it("requires security-review for --security-review even when spec is not in the pipeline", () => {
    const skills = resolveRequiredSkills({
      ...EXPLICIT_BASE,
      phases: ["exec", "qa"] as Phase[],
      securityReview: true,
    });
    expect(skills).toContain("security-review");
  });

  it("resolves label-detected pipelines per issue in auto-detect mode", () => {
    const skills = resolveRequiredSkills({
      ...EXPLICIT_BASE,
      autoDetectPhases: true,
      issueNumbers: [1, 2],
      issueInfoMap: infoMap([
        [1, ["bug"]],
        [2, ["security"]],
      ]),
    });
    expect(skills).toEqual(
      expect.arrayContaining(["spec", "exec", "qa", "security-review"]),
    );
  });

  it("unions phases across issues without duplicates", () => {
    const skills = resolveRequiredSkills({
      ...EXPLICIT_BASE,
      issueNumbers: [1, 2],
      issueInfoMap: infoMap([
        [1, ["ui"]],
        [2, []],
      ]),
    });
    expect(skills.filter((s) => s === "qa")).toHaveLength(1);
    expect(skills).toContain("test");
  });
});

describe("runSkillsPreflight (#813 AC-1/AC-3)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skills-preflight-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function installSkill(name: string): void {
    const dir = join(root, SKILLS_DIR, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`);
  }

  it("fails for the claude-code driver on a tree with no .claude/skills/", async () => {
    const result = await runSkillsPreflight({ ...EXPLICIT_BASE, cwd: root });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingSkills).toEqual(["spec", "exec", "qa"]);
      expect(result.cause).toContain(SKILLS_DIR);
      expect(result.remedy).toContain("sequant sync");
      expect(result.driverName).toBe("claude-code");
    }
  });

  it("names only the missing skills when the directory exists", async () => {
    installSkill("spec");
    installSkill("qa");
    const result = await runSkillsPreflight({ ...EXPLICIT_BASE, cwd: root });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingSkills).toEqual(["exec"]);
      expect(result.cause).toBe("missing skills: exec");
    }
  });

  it("passes when every required skill is installed", async () => {
    installSkill("spec");
    installSkill("exec");
    installSkill("qa");
    const result = await runSkillsPreflight({ ...EXPLICIT_BASE, cwd: root });
    expect(result).toEqual({ ok: true });
  });

  it("AC-3: is skipped for the aider driver even with no .claude/skills/", async () => {
    const result = await runSkillsPreflight({
      ...EXPLICIT_BASE,
      agent: "aider",
      cwd: root,
    });
    expect(result).toEqual({ ok: true });
  });

  it("defaults the driver to claude-code (guard active)", async () => {
    const result = await runSkillsPreflight({
      ...EXPLICIT_BASE,
      agent: undefined,
      cwd: root,
    });
    expect(result.ok).toBe(false);
  });

  it("skips (does not throw) on an unknown driver name — executor owns that error", async () => {
    const result = await runSkillsPreflight({
      ...EXPLICIT_BASE,
      agent: "no-such-driver",
      cwd: root,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("RunOrchestrator skills pre-flight targets worktrees, not the main checkout (#933)", () => {
  let base: string;
  let originalCwd: string;

  function initRun(options: Record<string, unknown>) {
    return {
      options,
      settings: DEFAULT_SETTINGS,
      manifest: { stack: "node", packageManager: "npm" as const },
    };
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    base = mkdtempSync(join(tmpdir(), "skills-preflight-933-"));
    worktreeFixture.base = base;
    worktreeFixture.repo = join(base, "repo");
    mkdirSync(worktreeFixture.repo);
    execSync("git init -b main", { cwd: worktreeFixture.repo, stdio: "pipe" });
    writeFileSync(join(worktreeFixture.repo, "README.md"), "# test\n");
    execSync(
      // `-c commit.gpgsign=false`: see skills-preflight.integration.test.ts —
      // contributors with global commit signing have no pinentry in a test run.
      "git add . && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -m init",
      { cwd: worktreeFixture.repo, stdio: "pipe" },
    );
    process.chdir(worktreeFixture.repo);
    spies933.runIssue.mockClear();
    spies933.preflightCwds.length = 0;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
  });

  function installSkillUntracked(name: string): void {
    const dir = join(worktreeFixture.repo, SKILLS_DIR, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`);
    // Deliberately left untracked — this is the exact bug scenario: present
    // in the main checkout, absent from a freshly-added worktree.
  }

  function commitSkill(name: string): void {
    const dir = join(worktreeFixture.repo, SKILLS_DIR, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`);
    execSync(
      `git add . && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -m "add ${name} skill"`,
      { cwd: worktreeFixture.repo, stdio: "pipe" },
    );
  }

  it("933 AC-1: untracked .claude/skills fails fast, naming the worktree path and the fix, before any phase spawns", async () => {
    installSkillUntracked("spec");
    installSkillUntracked("exec");
    installSkillUntracked("qa");

    const result = await RunOrchestrator.run(
      initRun({ phases: "spec,exec,qa", noLog: true }),
      ["933"],
    );

    expect(spies933.runIssue).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    const worktreePath = join(base, "wt-933");
    const failure = result.results.find((r) => r.issueNumber === 933);
    expect(failure?.abortReason).toContain(worktreePath);
    expect(failure?.abortReason).toContain("commit .claude/skills");
    // A+ (QA on PR #1001): the abort happens after provisioning, so the
    // worktree this run created must not be orphaned — otherwise the printed
    // remedy cannot recover (a re-run reuses the stale worktree unrebased).
    expect(existsSync(worktreePath)).toBe(false);
    const registered = execSync("git worktree list --porcelain", {
      cwd: worktreeFixture.repo,
      encoding: "utf-8",
    });
    expect(registered).not.toContain(worktreePath);
    expect(failure?.abortReason).toContain("was removed");
  });

  it("933 AC-2: committed skills pass, and the pre-flight was invoked with cwd = the worktree path", async () => {
    commitSkill("spec");
    commitSkill("exec");
    commitSkill("qa");

    const result = await RunOrchestrator.run(
      initRun({ phases: "spec,exec,qa", noLog: true }),
      ["933"],
    );

    expect(result.exitCode).toBe(0);
    expect(spies933.runIssue).toHaveBeenCalledWith(933);
    const worktreePath = join(base, "wt-933");
    expect(spies933.preflightCwds).toContain(worktreePath);
    expect(spies933.preflightCwds).not.toContain(
      realpathSync(worktreeFixture.repo),
    );
  });

  it("933: a pre-existing (reused) worktree is kept on pre-flight failure and the remedy names git worktree remove, never --force", async () => {
    installSkillUntracked("spec");
    installSkillUntracked("exec");
    installSkillUntracked("qa");
    const worktreePath = join(base, "wt-933");
    // Pre-create the worktree so the (mocked) ensureWorktrees reports it as
    // reused — the user's, not this run's.
    execSync(
      `git worktree add ${JSON.stringify(worktreePath)} -b feature/933-test`,
      { cwd: worktreeFixture.repo, stdio: "pipe" },
    );
    const result = await RunOrchestrator.run(
      initRun({ phases: "spec,exec,qa", noLog: true }),
      ["933"],
    );
    expect(result.exitCode).toBe(1);
    expect(spies933.runIssue).not.toHaveBeenCalled();
    expect(existsSync(worktreePath)).toBe(true);
    const reason =
      result.results.find((r) => r.issueNumber === 933)?.abortReason ?? "";
    expect(reason).toContain("pre-existing worktree was kept");
    expect(reason).toContain(`git worktree remove ${worktreePath}`);
    // `sequant run --force` bypasses the state guard; it never re-provisions,
    // so it must not be offered. (`git worktree remove --force` is a
    // different thing and is fine on the failed-removal branch.)
    expect(reason).not.toMatch(/re-run with --force/);
  });

  it("933: with worktree isolation disabled the remedy talks about the checkout, not a worktree", async () => {
    // No skills anywhere, no worktree provisioned: the pre-flight checks the
    // main checkout (pre-#933 behaviour) and must not call it a worktree or
    // tell the user to remove one.
    const result = await RunOrchestrator.run(
      initRun({
        phases: "spec,exec,qa",
        noLog: true,
        worktreeIsolation: false,
      }),
      ["933"],
    );
    expect(result.exitCode).toBe(1);
    expect(spies933.runIssue).not.toHaveBeenCalled();
    expect(existsSync(join(base, "wt-933"))).toBe(false);
    const reason =
      result.results.find((r) => r.issueNumber === 933)?.abortReason ?? "";
    // process.cwd() is canonical (/private/var on macOS); the fixture path may not be.
    expect(reason).toContain(
      `the checkout at ${realpathSync(worktreeFixture.repo)}`,
    );
    expect(reason).not.toContain("git worktree remove");
    expect(reason).not.toMatch(/re-run with --force/);
  });
  it("933: a multi-issue abort removes every worktree this run created and names them all", async () => {
    installSkillUntracked("spec");
    installSkillUntracked("exec");
    installSkillUntracked("qa");
    const result = await RunOrchestrator.run(
      initRun({ phases: "spec,exec,qa", noLog: true }),
      ["933", "934"],
    );
    expect(result.exitCode).toBe(1);
    expect(spies933.runIssue).not.toHaveBeenCalled();
    for (const n of ["933", "934"]) {
      expect(existsSync(join(base, `wt-${n}`)), `wt-${n}`).toBe(false);
    }
    const registered = execSync("git worktree list --porcelain", {
      cwd: worktreeFixture.repo,
      encoding: "utf-8",
    });
    expect(registered).not.toContain(join(base, "wt-933"));
    expect(registered).not.toContain(join(base, "wt-934"));
    // Every result carries the abort reason; the failing cwd is named first
    // and the other created worktree is listed as removed too.
    const reason = result.results[0]?.abortReason ?? "";
    expect(reason).toContain("was removed");
    expect(reason).toContain("Also removed (created for this run):");
    expect(reason).toContain(join(base, "wt-934"));
  });
  it("933 AC-3: --dry-run makes zero pre-flight calls", async () => {
    // No skills anywhere — if the pre-flight ran at all it would fail.
    const result = await RunOrchestrator.run(
      initRun({ phases: "spec,exec,qa", noLog: true, dryRun: true }),
      ["933"],
    );

    expect(spies933.preflightCwds).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  it("933 AC-3: the aider driver makes zero pre-flight calls", async () => {
    // No skills anywhere — if the pre-flight ran (even to return ok) it
    // would show up in the spy; aider must never reach it at all.
    const result = await RunOrchestrator.run(
      initRun({ phases: "spec,exec,qa", noLog: true, agent: "aider" }),
      ["933"],
    );

    expect(spies933.preflightCwds).toHaveLength(0);
    expect(spies933.runIssue).toHaveBeenCalledWith(933);
    expect(result.exitCode).toBe(0);
  });
});

describe("driverResolvesSkills (#933 fallback)", () => {
  it("is false for aider, true for claude-code, and fails safe (true) for a driver the registry does not know", () => {
    expect(driverResolvesSkills("aider", undefined)).toBe(false);
    expect(driverResolvesSkills("claude-code", undefined)).toBe(true);
    expect(driverResolvesSkills(undefined, undefined)).toBe(true);
    // Unknown driver: getDriver throws; the guard must run rather than skip.
    expect(driverResolvesSkills("no-such-driver", undefined)).toBe(true);
  });
});
