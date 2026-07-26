import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveRequiredSkills,
  runSkillsPreflight,
} from "./skills-preflight.js";
import { SKILLS_DIR } from "../skills-check.js";
import type { Phase } from "./types.js";

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
});
