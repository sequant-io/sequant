/**
 * Smoke tests for assess skill phase vocabulary and CLI flag accuracy
 *
 * AC-2: Verify assess SKILL.md examples only reference valid phases and CLI
 *       flags — each example `npx sequant run` line runs as `--dry-run` (#1512)
 * AC-3: Label→phase table only uses valid phases
 * AC-4: All 3 skill directories stay in sync
 *
 * Prevents recurrence of drift categories found in audit (ba4fc3d, c62c904):
 * - Nonexistent CLI flags in examples
 * - Nonexistent phase names in label→phase table
 * - Wrong flag descriptions
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, describe, expect, it, beforeAll } from "vitest";
import { getPhaseNames } from "../workflow/phase-registry.ts";
import { SKILL_ROOTS } from "../../../scripts/check-skill-sync.js";
import {
  skillEnv,
  skillSection,
  withBuiltCli,
} from "../../../__tests__/helpers/skill-fence.js";

const SKILL_DIRS = SKILL_ROOTS.map((root) => `${root}/assess/SKILL.md`);

describe("assess skill phase vocabulary", () => {
  let skillContent: string;
  const validPhases = getPhaseNames();

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
      /\| Labels \|.*Workflow \|[\s\S]*?(?=\n\n)/,
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

  it("should only reference valid CLI flags in Step 4 detection sections", () => {
    // Scan the Step 4 "Chain detection" + "Flag references:" region where
    // run-command flags are documented. Replaces the older "Other flags" section.
    const detectionSection = skillContent.match(
      /\*\*Chain detection[\s\S]*?(?=\n### Step 5:)/,
    );
    expect(detectionSection).not.toBeNull();

    const flagRefs = detectionSection![0].match(/`(--[a-z][a-z-]*)[` ]/g) || [];
    const referencedFlags = flagRefs.map((s) => s.replace(/`/g, "").trim());

    expect(referencedFlags.length).toBeGreaterThan(0);
    for (const flag of referencedFlags) {
      expect(validRunFlags).toContain(flag);
    }
  });

  it("should not restate default phases or non-additive testgen/security-review in example commands", () => {
    const exampleLines = skillContent
      .split("\n")
      .filter((line) => /sequant\s+run\b/.test(line));

    expect(exampleLines.length).toBeGreaterThan(0);

    for (const line of exampleLines) {
      expect(line).not.toMatch(/--phases\s+spec,exec,qa\b/);
      expect(line).not.toMatch(/--phases\s+\S*\btestgen\b/);
      expect(line).not.toMatch(/--phases\s+\S*\bsecurity-review\b/);
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

describe("assess skill example commands run", () => {
  // Every example command line the skill shows a user, comment stripped.
  const examples = [
    ...new Set(
      skillSection("assess")
        .split("\n")
        .map((line) => line.replace(/#.*$/, "").trim())
        .filter((line) => /^npx sequant run \d/.test(line)),
    ),
  ];

  // `run` needs only a manifest to plan; --dry-run executes nothing.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sequant-assess-"));
  fs.writeFileSync(
    path.join(project, ".sequant-manifest.json"),
    JSON.stringify({ version: "0.0.0", stack: "generic", files: {} }),
  );
  afterAll(() => fs.rmSync(project, { recursive: true, force: true }));

  it("finds the example commands", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(examples)(
    "%s --dry-run plans without error",
    (line) => {
      const result = spawnSync(
        "bash",
        ["-c", withBuiltCli(`${line} --dry-run`)],
        {
          cwd: project,
          encoding: "utf-8",
          env: skillEnv(),
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("planned");
    },
    20_000,
  );
});
