/**
 * Tests for /testgen skill verification
 *
 * AC-2: Documentation or test confirms /testgen uses haiku sub-agents at runtime
 *
 * These tests verify that the testgen skill documentation contains proper
 * haiku sub-agent usage patterns, ensuring the implementation follows
 * the token optimization strategy.
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
