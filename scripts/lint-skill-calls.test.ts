/**
 * Tests for the skill-call lint utility (scripts/lint-skill-calls.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ANTHROPIC_TOP_LEVEL_NAMES,
  findViolations,
  lintSkillCalls,
} from "./lint-skill-calls";

describe("findViolations", () => {
  it("flags an unqualified call to a colliding name", () => {
    const content = 'Skill(skill: "loop", args: "x")';
    const found = findViolations(content);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("loop");
    expect(found[0].line).toBe(1);
  });

  it("flags every Anthropic-colliding name in the catalog", () => {
    for (const name of ANTHROPIC_TOP_LEVEL_NAMES) {
      const content = `Skill(skill: "${name}", args: "x")`;
      const found = findViolations(content);
      expect(found, `expected ${name} to be flagged`).toHaveLength(1);
      expect(found[0].name).toBe(name);
    }
  });

  it("ignores qualified sequant: calls", () => {
    const content = 'Skill(skill: "sequant:loop", args: "x")';
    expect(findViolations(content)).toHaveLength(0);
  });

  it("ignores non-colliding bare names", () => {
    const content = [
      'Skill(skill: "spec", args: "1")',
      'Skill(skill: "exec", args: "1")',
      'Skill(skill: "qa", args: "1")',
      'Skill(skill: "test", args: "1")',
    ].join("\n");
    expect(findViolations(content)).toHaveLength(0);
  });

  it("reports correct line numbers and supports multiple violations", () => {
    const content = [
      "# Heading",
      'Skill(skill: "loop", args: "1")',
      "Some prose.",
      'Skill(skill: "security-review", args: "x")',
    ].join("\n");
    const found = findViolations(content);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ name: "loop", line: 2 });
    expect(found[1]).toMatchObject({ name: "security-review", line: 4 });
  });

  it("tolerates whitespace variants in the call form", () => {
    const content = 'Skill(  skill:   "loop"  , args: "x")';
    expect(findViolations(content)).toHaveLength(1);
  });

  it("flags multi-line Skill() invocations", () => {
    const content = [
      "# heading",
      "Skill(",
      '  skill: "loop",',
      '  args: "x"',
      ")",
      "trailing prose",
    ].join("\n");
    const found = findViolations(content);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("loop");
    // Line number is the line where `Skill(` starts (line 2), not where `skill:` lives.
    expect(found[0].line).toBe(2);
    expect(found[0].snippet).toBe("Skill(");
  });

  it("does not flag a multi-line call qualified with sequant:", () => {
    const content = [
      "Skill(",
      '  skill: "sequant:loop",',
      '  args: "x"',
      ")",
    ].join("\n");
    expect(findViolations(content)).toHaveLength(0);
  });
});

describe("lintSkillCalls (filesystem)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lint-skill-calls-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeSkill(relPath: string, body: string): void {
    const full = join(tmp, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }

  it("returns zero violations for a clean tree", () => {
    writeSkill(
      ".claude/skills/example/SKILL.md",
      'Skill(skill: "sequant:loop", args: "1")\nSkill(skill: "spec", args: "1")\n',
    );
    writeSkill(
      "templates/skills/example/SKILL.md",
      'Skill(skill: "sequant:loop", args: "1")\n',
    );
    writeSkill(
      "skills/example/SKILL.md",
      'Skill(skill: "sequant:loop", args: "1")\n',
    );
    const result = lintSkillCalls(tmp);
    expect(result.scanned).toBe(3);
    expect(result.violations).toHaveLength(0);
  });

  it("flags a violation in any of the three mirror dirs", () => {
    writeSkill(
      ".claude/skills/foo/SKILL.md",
      'Line one\nSkill(skill: "loop", args: "1")\n',
    );
    writeSkill("templates/skills/bar/SKILL.md", "no calls here\n");
    writeSkill(
      "skills/baz/SKILL.md",
      'Skill(skill: "security-review", args: "1")\n',
    );
    const result = lintSkillCalls(tmp);
    expect(result.scanned).toBe(3);
    expect(result.violations).toHaveLength(2);

    const byName = Object.fromEntries(
      result.violations.map((v) => [v.name, v]),
    );
    expect(byName["loop"].file).toBe(".claude/skills/foo/SKILL.md");
    expect(byName["loop"].line).toBe(2);
    expect(byName["security-review"].file).toBe("skills/baz/SKILL.md");
  });

  it("scans every .md file under skill mirror dirs, not just SKILL.md", () => {
    writeSkill(
      ".claude/skills/foo/SKILL.md",
      'Skill(skill: "sequant:loop", args: "1")\n',
    );
    writeSkill(
      ".claude/skills/foo/references/example.md",
      'Skill(skill: "loop", args: "1")\n',
    );
    writeSkill(
      ".claude/skills/foo/README.md",
      'Skill(skill: "security-review", args: "1")\n',
    );
    const result = lintSkillCalls(tmp);
    expect(result.scanned).toBe(3);
    expect(result.violations).toHaveLength(2);
    const files = result.violations.map((v) => v.file).sort();
    expect(files).toEqual([
      ".claude/skills/foo/README.md",
      ".claude/skills/foo/references/example.md",
    ]);
  });

  it("ignores non-markdown files", () => {
    writeSkill(
      ".claude/skills/foo/example.ts",
      'Skill(skill: "loop", args: "1")\n',
    );
    writeSkill(
      ".claude/skills/foo/SKILL.md",
      'Skill(skill: "sequant:loop", args: "1")\n',
    );
    const result = lintSkillCalls(tmp);
    expect(result.scanned).toBe(1);
    expect(result.violations).toHaveLength(0);
  });

  it("returns scanned=0 when no scan dirs exist", () => {
    const result = lintSkillCalls(tmp);
    expect(result.scanned).toBe(0);
    expect(result.violations).toHaveLength(0);
  });
});
