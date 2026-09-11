/**
 * Gate test: the /release skill carries the SECURITY.md supported-versions
 * step (#980 QA rot finding). Scoped to the Step 4.67 region — between its
 * heading and the next `### Step` — so a mention elsewhere cannot satisfy it.
 * All three skill copies are checked.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "../../..");
const COPIES = [
  ".claude/skills/release/SKILL.md",
  "templates/skills/release/SKILL.md",
  "skills/release/SKILL.md",
];

function stepRegion(skill: string): string {
  const start = skill.indexOf("### Step 4.67");
  expect(start, "Step 4.67 heading present").toBeGreaterThanOrEqual(0);
  const rest = skill.slice(start + 1);
  const next = rest.search(/\n### Step /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

describe.each(COPIES)("%s", (rel) => {
  it("updates the SECURITY.md supported-versions table to the released minor", () => {
    // Region lookup happens inside the test, so a missing step is a failing
    // test rather than a collection error.
    const region = stepRegion(readFileSync(join(REPO_ROOT, rel), "utf8"));
    expect(region).toMatch(/SECURITY\.md/);
    expect(region).toMatch(/Supported versions/);
    expect(region).toMatch(/new_minor/);
  });
});
