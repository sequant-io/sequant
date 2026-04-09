/**
 * Smoke tests for assess skill phase vocabulary and CLI flag accuracy
 *
 * AC-2: Verify assess SKILL.md examples only reference valid phases and CLI flags
 * AC-3: Label→phase table only uses valid phases
 * AC-4: All 3 skill directories stay in sync
 *
 * Prevents recurrence of drift categories found in audit (ba4fc3d, c62c904):
 * - Nonexistent CLI flags in examples
 * - Nonexistent phase names in label→phase table
 * - Wrong flag descriptions
 */

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, beforeAll } from "vitest";
import { PhaseSchema } from "../workflow/types.ts";

const SKILL_DIRS = [
  ".claude/skills/assess/SKILL.md",
  "skills/assess/SKILL.md",
  "templates/skills/assess/SKILL.md",
];

describe("assess skill phase vocabulary", () => {
  let skillContent: string;
  const validPhases = PhaseSchema.options;

  beforeAll(() => {
    const skillPath = path.join(
      process.cwd(),
      ".claude/skills/assess/SKILL.md",
    );
    skillContent = fs.readFileSync(skillPath, "utf-8");
  });

  it("should have a Valid phases reference line listing all PhaseSchema phases", () => {
    const match = skillContent.match(
      /\*\*Valid phases \(from `PhaseSchema`.*?\):\*\*\s*(.+)/,
    );
    expect(match).not.toBeNull();

    const listedPhases = match![1]
      .match(/`([^`]+)`/g)!
      .map((s) => s.replace(/`/g, ""));

    // Every PhaseSchema phase must be listed
    for (const phase of validPhases) {
      expect(listedPhases).toContain(phase);
    }
    // No extra phases beyond PhaseSchema
    for (const phase of listedPhases) {
      expect(validPhases).toContain(phase);
    }
  });

  it("should only use valid phases in the label→phase workflow table", () => {
    // Extract phase names from the workflow column of the label→phase table
    const tableSection = skillContent.match(
      /\| Labels \| Category \| Workflow \|[\s\S]*?(?=\n\n)/,
    );
    expect(tableSection).not.toBeNull();

    const workflowRefs = tableSection![0].match(/`([^`]+)`/g) || [];
    const phasesInTable = workflowRefs
      .map((s) => s.replace(/`/g, ""))
      .filter((s) => !s.startsWith("-")) // exclude flags like -q
      .flatMap((s) => s.split(" → ")); // split "exec → qa" into ["exec", "qa"]

    expect(phasesInTable.length).toBeGreaterThan(0);
    for (const phase of phasesInTable) {
      expect(validPhases).toContain(phase);
    }
  });
});

describe("assess skill CLI flag accuracy", () => {
  let skillContent: string;
  let validRunFlags: string[];

  beforeAll(() => {
    const skillPath = path.join(
      process.cwd(),
      ".claude/skills/assess/SKILL.md",
    );
    skillContent = fs.readFileSync(skillPath, "utf-8");

    // Extract --flag names from the run command in bin/cli.ts
    const cliSource = fs.readFileSync(
      path.join(process.cwd(), "bin/cli.ts"),
      "utf-8",
    );

    // Find the run command section (from .command("run") to next .command( or end)
    const runSection = cliSource.match(
      /\.command\("run"\)[\s\S]*?(?=\n\s*program\n|\nprogram\.parse)/,
    );
    expect(runSection).not.toBeNull();

    // Extract long flags from .option() calls
    const optionMatches = runSection![0].matchAll(/\.option\(\s*"([^"]+)"/g);
    validRunFlags = [];
    for (const m of optionMatches) {
      // Parse flag string like "-d, --dry-run" or "--phases <list>"
      const flags = m[1].match(/--([a-z][a-z-]*)/g) || [];
      validRunFlags.push(...flags);
    }
  });

  it("should only reference valid CLI flags in Other flags section", () => {
    const otherFlagsSection = skillContent.match(
      /\*\*Other flags:\*\*[\s\S]*?(?=\n###|\n\n\*\*)/,
    );
    expect(otherFlagsSection).not.toBeNull();

    const flagRefs =
      otherFlagsSection![0].match(/`(--[a-z][a-z-]*)[` ]/g) || [];
    const referencedFlags = flagRefs.map((s) => s.replace(/`/g, "").trim());

    for (const flag of referencedFlags) {
      expect(validRunFlags).toContain(flag);
    }
  });

  it("should only reference valid CLI flags in example commands", () => {
    // Find lines that look like example commands: sequant run, npx sequant run
    const exampleLines = skillContent
      .split("\n")
      .filter((line) => /sequant\s+run\b/.test(line));

    for (const line of exampleLines) {
      const flags = line.match(/--[a-z][a-z-]*/g) || [];
      for (const flag of flags) {
        expect(validRunFlags).toContain(flag);
      }
    }
  });
});

describe("assess skill 3-directory sync", () => {
  it("should have identical content across all 3 skill directories", () => {
    const contents = SKILL_DIRS.map((relPath) =>
      fs.readFileSync(path.join(process.cwd(), relPath), "utf-8"),
    );

    expect(contents[0]).toBe(contents[1]);
    expect(contents[0]).toBe(contents[2]);
  });
});
