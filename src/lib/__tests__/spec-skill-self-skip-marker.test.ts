/**
 * Gate test for the `/spec` self-skip marker rule (#1213 AC-1).
 *
 * Scoped to the "## Phase Detection" region — between its heading and the
 * next `##` — so a mention elsewhere in the skill cannot satisfy it. All
 * three skill copies are checked because the phase agent reads whichever one
 * its project installed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SKILL_ROOTS } from "../../../scripts/check-skill-sync.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "../../..");
const COPIES = SKILL_ROOTS.map((root) => `${root}/spec/SKILL.md`);

function phaseDetectionRegion(skill: string): string {
  const start = skill.indexOf("## Phase Detection");
  expect(start, "Phase Detection heading present").toBeGreaterThanOrEqual(0);
  const rest = skill.slice(start + 1);
  const next = rest.search(/\n## /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

describe.each(COPIES)("%s", (rel) => {
  const region = phaseDetectionRegion(
    readFileSync(join(REPO_ROOT, rel), "utf8"),
  );

  it("names the SEQUANT_SPEC marker on the self-skip branch", () => {
    expect(region).toMatch(/SEQUANT_SPEC/);
  });

  it("instructs restating the prior marker verbatim rather than a bare skip", () => {
    expect(region).toMatch(/restate\w* it/i);
    expect(region).toMatch(/verbatim/i);
  });

  it("states the fallback to normal execution when no prior marker exists", () => {
    expect(region).toMatch(/fall through to normal\s+execution/i);
  });
});
