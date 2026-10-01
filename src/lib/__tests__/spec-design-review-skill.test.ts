/**
 * Gate test for the `/spec` Design Review recurrence stop and producer list
 * (#1250 AC-1, AC-2, AC-5) and the constitution's one-producer rule (AC-4).
 *
 * Skill assertions are scoped to the "## Design Review" region — from its
 * heading to the next `\n---` — so a mention elsewhere in the skill cannot
 * satisfy them. All three skill copies are checked because the phase agent
 * reads whichever one its project installed. The constitution assertion is
 * scoped to "## 3. Boundaries", up to "## 4.".
 *
 * Each case lists its copy's directory through `collectFiles` (the walker
 * `lint:skill-sync` uses), so the copy under test is one the sync check sees.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { collectFiles } from "../../../scripts/check-skill-sync.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "../../..");
const COPIES = [
  ".claude/skills/spec/SKILL.md",
  "templates/skills/spec/SKILL.md",
  "skills/spec/SKILL.md",
];

function between(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  expect(start, `${startMarker} present`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  return end >= 0 ? rest.slice(0, end) : rest;
}

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

function designReview(rel: string): string {
  return between(read(rel), "## Design Review\n", "\n---");
}

describe.each(COPIES)("%s Design Review", (rel) => {
  const copyDir = join(REPO_ROOT, dirname(rel));

  it("AC-1: Q3 treats >=2 prior fix issues as a stop, citing git log -S and an issue search", () => {
    expect(collectFiles(copyDir)).toContain("SKILL.md");
    const q3 = between(designReview(rel), "\n3. ", "\n4. ");
    expect(q3).toContain("re-patched");
    expect(q3).toContain("git log -S");
    expect(q3).toContain("issue search");
    expect(q3).toContain("≥2 prior fix issues");
    expect(q3).toContain("**stop**, not precedent");
    expect(q3).toContain("deliberately local, reason:");
    expect(q3).toContain("class tracked in #N");
  });

  it("AC-2: Q5 lists every producer and consumer, with the >=2-producer rule", () => {
    expect(collectFiles(copyDir)).toContain("SKILL.md");
    const q5 = between(designReview(rel), "\n5. ", "\n\n");
    expect(q5).toContain("Every producer and consumer");
    expect(q5).toContain("whole-repo grep");
    expect(q5).toContain("≥2 producers");
    expect(q5).toContain("collapse them");
    expect(q5).toContain("parity test on every field");
    expect(q5).toContain("record why");
  });

  it("AC-3: the halt-on-divergence note names the SPEC_DIVERGENCE marker fields", () => {
    expect(collectFiles(copyDir)).toContain("SKILL.md");
    const note = between(designReview(rel), "Halt on divergence", "-->");
    expect(note).toContain('"outcome":"SPEC_DIVERGENCE"');
    expect(note).toContain('"divergenceAcs"');
    expect(note).toContain("stops before exec");
  });

  it("AC-5: tier gating keeps Q3 for Simple and Q5 for Standard/Complex only", () => {
    expect(collectFiles(copyDir)).toContain("SKILL.md");
    const tierRow = between(read(rel), "| **Simple** |", "\n");
    expect(tierRow).toContain("Design Review Q1/Q3 only");
    const tierComment = between(designReview(rel), "<!-- Simple tier:", "-->");
    expect(tierComment).toContain("Q1 and Q3");
    expect(tierComment).toContain("Q5 is Standard/Complex only");
  });
});

describe("memory/constitution.md §3 Boundaries", () => {
  it("AC-4: states one producer per artifact, enforced by /spec Design Review Q5", () => {
    expect(collectFiles(join(REPO_ROOT, "memory"))).toContain(
      "constitution.md",
    );
    const boundaries = between(
      read("memory/constitution.md"),
      "## 3. Boundaries",
      "## 4.",
    );
    expect(boundaries).toContain(
      "| One producer per artifact; a second producer needs a parity test on every field and a recorded reason |",
    );
    expect(boundaries).toContain("`/spec` Design Review Q5");
  });
});
