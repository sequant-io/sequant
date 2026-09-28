/**
 * CI gate for `/improve`'s tech-debt scoring (#1135, AC-5).
 *
 * `improve/references/tech-debt-scoring.md` defines the six tech-debt
 * categories and the `(Impact + Risk) × (6 − Effort)` score adapted from the
 * native `engineering:tech-debt` rubric, and `improve/SKILL.md` must rank
 * candidates with it. Prose with no runtime twin, so assertions run against
 * the skill text, scoped per CLAUDE.md: the reference's `## Categories` and
 * `## Score` sections, and `improve/SKILL.md`'s `## Phase 3: Present Findings`
 * section (up to `## Phase 4`). All three skill copies are checked.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { collectFiles } from "../../../scripts/check-skill-sync.js";

const SKILL_ROOTS = [".claude/skills", "skills", "templates/skills"] as const;

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const REFERENCE = "improve/references/tech-debt-scoring.md";
const FORMULA = "(Impact + Risk) × (6 − Effort)";
const CATEGORIES = [
  "Code debt",
  "Architecture debt",
  "Test debt",
  "Dependency debt",
  "Documentation debt",
  "Infrastructure debt",
];

/** Read `rel` from each skill root via the `lint:skill-sync` walker. */
function readFromEachRoot(rel: string): Array<{ root: string; text: string }> {
  return SKILL_ROOTS.map((root) => {
    const base = path.join(REPO_ROOT, root);
    const found = collectFiles(base).find((f) => f === rel);
    if (!found) throw new Error(`${rel} not found under ${root}`);
    return { root, text: fs.readFileSync(path.join(base, found), "utf-8") };
  });
}

/** Slice `text` from `startMarker` up to (not including) `endMarker`. */
function span(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + 1);
  if (start === -1 || end === -1) {
    throw new Error(`span ${startMarker} .. ${endMarker} not found`);
  }
  return text.slice(start, end);
}

describe("improve tech-debt scoring (AC-5)", () => {
  it("reference defines the 6 categories in its Categories table", () => {
    for (const { root, text } of readFromEachRoot(REFERENCE)) {
      const table = span(text, "## Categories", "## Score");
      for (const category of CATEGORIES) {
        expect(table, `${root}: ${category}`).toContain(`| **${category}** |`);
      }
      const rows = table.split("\n").filter((l) => l.startsWith("| **"));
      expect(rows.length, root).toBe(6);
    }
  });

  it("reference defines the (Impact + Risk) × (6 − Effort) score", () => {
    for (const { root, text } of readFromEachRoot(REFERENCE)) {
      const score = span(text, "## Score", "## Worked example");
      expect(score, root).toContain(`Score = ${FORMULA}`);
      for (const axis of ["**Impact**", "**Risk**", "**Effort**"]) {
        expect(score, `${root}: ${axis}`).toContain(axis);
      }
    }
  });

  it("improve/SKILL.md Phase 3 ranks candidates with the reference", () => {
    for (const { root, text } of readFromEachRoot("improve/SKILL.md")) {
      const phase3 = span(text, "## Phase 3: Present Findings", "## Phase 4");
      expect(phase3, root).toContain(
        "[tech-debt-scoring.md](references/tech-debt-scoring.md)",
      );
      expect(phase3, root).toContain(FORMULA);
      expect(phase3, root).toContain("Sort rows by Score, highest first");
      expect(phase3, root).toContain("| I/R/E | Score |");
    }
  });
});
