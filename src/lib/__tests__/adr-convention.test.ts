/**
 * CI gate for the ADR convention (#1135, AC-7).
 *
 * `docs/adr/README.md` and `docs/adr/0001-adopt-adrs.md` must exist in the
 * native ADR shape (Status / Context / Decision / Options / Trade-offs /
 * Consequences), and `spec/SKILL.md` must instruct an ADR when the plan
 * chooses between designs. Assertions are scoped per CLAUDE.md: the heading
 * order is checked in the ADR file and in the README's format skeleton only,
 * and the spec instruction must sit in the `## Design Review` template block
 * (up to the next `---` separator). All three spec copies are checked.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
  collectFiles,
  SKILL_ROOTS,
} from "../../../scripts/check-skill-sync.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const ADR_SHAPE = [
  "**Status:**",
  "## Context",
  "## Decision",
  "## Options",
  "## Trade-offs",
  "## Consequences",
];

/** Read a file under `docs/adr/`, located via the `lint:skill-sync` walker. */
function readAdrFile(name: string): string {
  const base = path.join(REPO_ROOT, "docs/adr");
  const found = collectFiles(base).find((f) => f === name);
  if (!found) throw new Error(`docs/adr/${name} not found`);
  return fs.readFileSync(path.join(base, found), "utf-8");
}

/** Read `spec/SKILL.md` from each skill root. */
function specCopies(): Array<{ root: string; text: string }> {
  return SKILL_ROOTS.map((root) => {
    const base = path.join(REPO_ROOT, root);
    const found = collectFiles(base).find((f) => f === "spec/SKILL.md");
    if (!found) throw new Error(`spec/SKILL.md not found under ${root}`);
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

/** Positions of each ADR_SHAPE marker (as line starts) in `text`, in order. */
function shapePositions(text: string): number[] {
  return ADR_SHAPE.map((marker) => {
    const at = text.indexOf(`\n${marker}`);
    return at === -1 ? -1 : at + 1;
  });
}

describe("ADR convention (AC-7)", () => {
  it("0001-adopt-adrs.md has the Status/Context/Decision/Options/Trade-offs/Consequences shape", () => {
    const adr = readAdrFile("0001-adopt-adrs.md");
    expect(adr.startsWith("# ADR-0001: ")).toBe(true);
    const positions = shapePositions(adr);
    positions.forEach((p, i) => expect(p, ADR_SHAPE[i]).toBeGreaterThan(0));
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it("README.md documents the same shape in its format skeleton", () => {
    const readme = readAdrFile("README.md");
    const skeleton = span(readme, "## Format", "## Rules");
    const positions = shapePositions(skeleton);
    positions.forEach((p, i) => expect(p, ADR_SHAPE[i]).toBeGreaterThan(0));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(readme).toContain("[0001](0001-adopt-adrs.md)");
  });

  it("spec/SKILL.md Design Review instructs an ADR when the plan chooses between designs", () => {
    for (const { root, text } of specCopies()) {
      const review = span(text, "## Design Review", "\n---\n");
      expect(review, root).toContain(
        "when the recommended plan chooses between designs",
      );
      expect(review, root).toContain("exec PR to include an ADR in docs/adr/");
    }
  });
});
