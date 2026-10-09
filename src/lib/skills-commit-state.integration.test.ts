/**
 * #1354 — committed vs on-disk skills, against a real git repository.
 *
 * Phase worktrees are checked out from git, so a `sequant sync` that was never
 * committed never reaches `sequant run`. Downstream, the version check said
 * 2.18.0 (on disk) while every phase ran the committed 2.15.1 skills.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import {
  formatSkillsCommitWarning,
  getSkillsCommitState,
} from "./skills-commit-state.js";
import { warnUncommittedSkills } from "../commands/sync.js";

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

describe("skills commit state (#1354)", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "skills-commit-state-"));
    execSync("git init -b main", { cwd: repo, stdio: "pipe" });
    writeSkills(repo, "2.15.1", "old");
    execSync(`git add . && ${GIT} commit -m init`, { cwd: repo, stdio: "pipe" });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("reports nothing when every tracked skill is committed", () => {
    const state = getSkillsCommitState(repo);
    expect(state).toEqual({ committedVersion: "2.15.1", modified: [] });
    expect(formatSkillsCommitWarning(state)).toBeNull();
  });

  it("AC-1: names the committed version when an uncommitted sync changed the skills", () => {
    writeSkills(repo, "2.18.0", "new");
    const state = getSkillsCommitState(repo);
    expect(state.committedVersion).toBe("2.15.1");
    expect(state.modified).toEqual(
      expect.arrayContaining([
        ".claude/skills/.sequant-version",
        ".claude/skills/exec/SKILL.md",
      ]),
    );
    const warning = formatSkillsCommitWarning(state);
    expect(warning).toContain("committed skills (2.15.1)");
    expect(warning).not.toContain("2.18.0");
  });

  it("ignores untracked skills, which are #1257's doctor check", () => {
    mkdirSync(join(repo, ".claude/skills/extra"), { recursive: true });
    writeFileSync(join(repo, ".claude/skills/extra/SKILL.md"), "x\n");
    expect(getSkillsCommitState(repo).modified).toEqual([]);
  });

  it("stays silent outside a git repository", () => {
    const plain = mkdtempSync(join(tmpdir(), "skills-commit-state-nogit-"));
    try {
      const state = getSkillsCommitState(plain);
      expect(state).toEqual({ committedVersion: null, modified: [] });
      expect(formatSkillsCommitWarning(state)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("AC-3: sync's closing message tells the user to commit the skills it wrote", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      warnUncommittedSkills(repo);
      expect(log).not.toHaveBeenCalled();

      writeSkills(repo, "2.18.0", "new");
      warnUncommittedSkills(repo);
      const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(printed).toContain("Commit .claude/skills/");
      expect(printed).toContain("committed skills (2.15.1)");
    } finally {
      log.mockRestore();
    }
  });
});
