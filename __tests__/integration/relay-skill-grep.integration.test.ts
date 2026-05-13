// Integration test for AC-16 — no SKILL.md file mentions relay/SEQUANT_RELAY.
// The hook handles relay framing transparently; skills do not need to know.

import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const SKILL_ROOTS = [".claude/skills", "templates/skills", "skills"] as const;

function listSkillMdFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  // Use git ls-files to honor .gitignore and skip vendored dirs.
  try {
    const out = execSync(`git ls-files "${root}"`, { encoding: "utf-8" });
    return out
      .split("\n")
      .filter((p) => p.endsWith("SKILL.md"))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function violations(files: string[]): { file: string; line: string }[] {
  const found: { file: string; line: string }[] = [];
  // Match the env var or the literal word "relay" used to describe this feature.
  // We allow incidental matches like "delay" by anchoring on whole-word.
  const wordRelay = /\brelay\b/i;
  const envVar = /SEQUANT_RELAY/;
  for (const file of files) {
    const text = fs.readFileSync(file, "utf-8");
    for (const line of text.split("\n")) {
      if (envVar.test(line) || wordRelay.test(line)) {
        found.push({ file, line: line.trim() });
        break;
      }
    }
  }
  return found;
}

describe("Relay — SKILL.md isolation guard (AC-16)", () => {
  for (const root of SKILL_ROOTS) {
    describe(`under ${root}/`, () => {
      it(`no SKILL.md mentions relay/SEQUANT_RELAY in ${root}/`, () => {
        const files = listSkillMdFiles(root);
        // It is acceptable for a project to have zero SKILL.md files in one of
        // the directories; the assertion is purely "no violations exist".
        const bad = violations(files);
        if (bad.length > 0) {
          console.error("Violations:", bad);
        }
        expect(bad).toEqual([]);
      });
    });
  }

  it("at least one of the three skill roots is non-empty (sanity check)", () => {
    const total = SKILL_ROOTS.reduce(
      (n, r) => n + listSkillMdFiles(r).length,
      0,
    );
    expect(total).toBeGreaterThan(0);
  });
});
