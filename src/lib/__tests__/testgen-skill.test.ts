/**
 * Tests for testgen auto-detection workflow
 *
 * AC-1: Integration test verifies /spec recommends testgen for appropriate issues
 * AC-2: Documentation or test confirms /testgen uses haiku sub-agents at runtime
 *
 * These tests verify:
 * 1. The /spec skill contains testgen auto-detection rules (AC-1)
 * 2. The /testgen skill contains haiku sub-agent patterns (AC-2)
 */

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, beforeAll } from "vitest";

describe("testgen skill haiku sub-agent documentation", () => {
  let skillContent: string;
  const skillPath = path.join(process.cwd(), ".claude/skills/testgen/SKILL.md");

  beforeAll(() => {
    // Read the skill file once for all tests
    skillContent = fs.readFileSync(skillPath, "utf-8");
  });

  it("should have Token Optimization with Haiku Sub-Agents section", () => {
    expect(skillContent).toContain(
      "## Token Optimization with Haiku Sub-Agents",
    );
  });

  it('should document model="haiku" pattern for sub-agents', () => {
    // Check for the Task call pattern with haiku model
    expect(skillContent).toContain('model="haiku"');
    expect(skillContent).toContain('subagent_type="general-purpose"');
  });

  it("should document parse verification criteria as haiku task", () => {
    // Step 1 in the skill should use haiku for parsing
    expect(skillContent).toMatch(/Parse.*Verification.*Criteria.*haiku/is);
  });

  it("should document generate test stubs as haiku task", () => {
    // Step 2 should use haiku for stub generation
    expect(skillContent).toMatch(/Generate.*Test.*Stub.*haiku/is);
  });

  it("should have agent usage table documenting haiku vs main agent", () => {
    // The skill should have a table showing when to use haiku vs main agent
    expect(skillContent).toContain("When to Use Sub-Agents vs Main Agent");
    expect(skillContent).toContain("| Task | Agent | Reasoning |");
  });

  it("should document parallel sub-agent execution pattern", () => {
    expect(skillContent).toContain("Parallel Sub-Agent Execution");
  });

  it("should document cost savings from haiku usage", () => {
    // The skill should explain the token cost benefit
    expect(skillContent).toMatch(/90%.*token.*cost.*reduction/i);
  });

  it("should contain Task call examples with haiku model parameter", () => {
    // Count occurrences of haiku model parameter in Task calls
    const haikuTaskCalls = (
      skillContent.match(/Task\([^)]*model="haiku"[^)]*\)/g) || []
    ).length;
    // Should have at least 2 examples (parsing and generating)
    expect(haikuTaskCalls).toBeGreaterThanOrEqual(2);
  });
});

/**
 * AC-1: Verify /spec skill contains testgen auto-detection rules
 *
 * These tests ensure the /spec skill documents when to recommend testgen,
 * specifically for issues with Unit Test or Integration Test verification methods.
 */
describe("spec skill testgen auto-detection rules", () => {
  let specSkillContent: string;
  const specSkillPath = path.join(
    process.cwd(),
    ".claude/skills/spec/SKILL.md",
  );

  beforeAll(() => {
    specSkillContent = fs.readFileSync(specSkillPath, "utf-8");
  });

  it("should have 'When to recommend testgen phase' section", () => {
    expect(specSkillContent).toContain("When to recommend `testgen` phase");
  });

  it("should recommend testgen for Unit Test verification method", () => {
    // The spec skill should specify that Unit Test ACs trigger testgen
    expect(specSkillContent).toMatch(/Unit Test.*verification.*testgen/is);
    // Should have explicit condition in decision table
    expect(specSkillContent).toContain(
      'ACs have "Unit Test" verification method',
    );
  });

  it("should recommend testgen for Integration Test verification method", () => {
    // The spec skill should specify that Integration Test ACs trigger testgen
    expect(specSkillContent).toMatch(/Integration Test.*testgen/is);
    // Should have explicit condition in auto-detection algorithm
    expect(specSkillContent).toContain(
      'Count ACs with "Integration Test" → If >0, recommend testgen',
    );
  });

  it("should have testgen recommendation decision table", () => {
    // Verify the decision table structure exists
    expect(specSkillContent).toContain("| Condition | Recommend testgen?");
    expect(specSkillContent).toContain("| Reasoning |");
  });

  it("should document auto-detection algorithm for testgen", () => {
    // The spec skill should have step-by-step detection logic
    expect(specSkillContent).toContain(
      'Count ACs with "Unit Test" → If >0, recommend testgen',
    );
  });

  it("should document when NOT to recommend testgen", () => {
    // The spec skill should have exclusion rules
    expect(specSkillContent).toMatch(/bug.*fix.*Skip testgen/is);
    expect(specSkillContent).toContain("docs");
    expect(specSkillContent).toContain("Skip testgen");
  });

  it("should have example output showing testgen in workflow", () => {
    // Verify example output demonstrates testgen phase
    expect(specSkillContent).toContain(
      "**Phases:** spec → testgen → exec → qa",
    );
  });

  it("should document reasoning for testgen recommendation", () => {
    // The example should explain why testgen is recommended
    expect(specSkillContent).toMatch(
      /testgen will create stubs before implementation/i,
    );
  });
});
