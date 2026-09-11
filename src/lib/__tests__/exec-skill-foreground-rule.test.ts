/**
 * Gate test for the `/exec` foreground-only rule (#1032 AC-3).
 *
 * Scoped to the §3 "Checks-first Mindset" region — between its heading and
 * the next `###` — so a mention elsewhere in the skill (a comment, the parallel
 * groups section that legitimately backgrounds implementer agents) cannot
 * satisfy it. All three skill copies are checked because the phase agent
 * reads whichever one its project installed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "../../..");
const COPIES = [
  ".claude/skills/exec/SKILL.md",
  "templates/skills/exec/SKILL.md",
  "skills/exec/SKILL.md",
];

function checksFirstRegion(skill: string): string {
  const start = skill.indexOf("### 3. Checks-first Mindset");
  expect(start, "§3 heading present").toBeGreaterThanOrEqual(0);
  const rest = skill.slice(start + 1);
  const next = rest.search(/\n### /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

describe.each(COPIES)("%s", (rel) => {
  const region = checksFirstRegion(readFileSync(join(REPO_ROOT, rel), "utf8"));

  it("states the foreground-only rule for test runs", () => {
    expect(region).toMatch(/foreground/i);
    expect(region).toMatch(/\btimeout\b/);
  });

  it("states that the full suite runs exactly once per phase", () => {
    // #1024's first exec ran `npm test` twice in the foreground and died at
    // the 30-minute wall; the background guard cannot catch that.
    expect(region).toMatch(/exactly once per phase/);
  });

  it("names the hook that enforces it and the stranded-work failure it prevents", () => {
    expect(region).toMatch(/run_in_background/);
    expect(region).toMatch(/uncommitted and made no commits/);
  });
});
