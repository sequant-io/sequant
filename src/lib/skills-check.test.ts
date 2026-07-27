import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkSkillsInstalled, SKILLS_DIR } from "./skills-check.js";

describe("checkSkillsInstalled (#813)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skills-check-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function installSkill(name: string): void {
    const dir = join(root, SKILLS_DIR, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`);
  }

  it("reports the directory missing and every skill missing on a bare tree", async () => {
    const result = await checkSkillsInstalled(["spec", "exec", "qa"], root);
    expect(result.skillsDirExists).toBe(false);
    expect(result.missingSkills).toEqual(["spec", "exec", "qa"]);
  });

  it("passes when every requested skill has a SKILL.md", async () => {
    installSkill("spec");
    installSkill("exec");
    installSkill("qa");
    const result = await checkSkillsInstalled(["spec", "exec", "qa"], root);
    expect(result.skillsDirExists).toBe(true);
    expect(result.missingSkills).toEqual([]);
  });

  it("lists only the missing skills, preserving input order", async () => {
    installSkill("exec");
    const result = await checkSkillsInstalled(
      ["spec", "exec", "qa", "testgen"],
      root,
    );
    expect(result.skillsDirExists).toBe(true);
    expect(result.missingSkills).toEqual(["spec", "qa", "testgen"]);
  });

  it("flags a skill directory without SKILL.md as missing", async () => {
    mkdirSync(join(root, SKILLS_DIR, "spec"), { recursive: true });
    const result = await checkSkillsInstalled(["spec"], root);
    expect(result.skillsDirExists).toBe(true);
    expect(result.missingSkills).toEqual(["spec"]);
  });

  it("checks nothing but the directory when given no skills", async () => {
    const result = await checkSkillsInstalled([], root);
    expect(result.skillsDirExists).toBe(false);
    expect(result.missingSkills).toEqual([]);
  });
});
