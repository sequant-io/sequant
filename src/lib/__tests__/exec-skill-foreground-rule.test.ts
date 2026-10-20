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
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SKILL_ROOTS } from "../../../scripts/check-skill-sync.js";
import {
  fill,
  skillEnv,
  skillSection,
} from "../../../__tests__/helpers/skill-fence.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "../../..");
const COPIES = SKILL_ROOTS.map((root) => `${root}/exec/SKILL.md`);

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

  it("names the macOS install and the portable fallback for timeout (#1054)", () => {
    expect(region).toMatch(/coreutils/);
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

describe("the portable timeout §3 names (#1054) enforces its limit", () => {
  // The inline `perl -e 'alarm shift; ...'` span, run with its 600 s limit
  // filled as 1 s (#1512). pipefail so the pipeline reports perl's status,
  // not tail's.
  function runPortableTimeout(command: string) {
    const region = skillSection("exec", {
      section: "### 3. Checks-first Mindset",
    });
    const span = /`(perl -e 'alarm shift[^`]*)`/.exec(region)?.[1];
    if (!span) throw new Error("§3 names no perl alarm command");
    const script = fill(span, { "' 600 ": "' 1 ", "<command>": command });
    const started = Date.now();
    const result = spawnSync("bash", ["-o", "pipefail", "-c", script], {
      encoding: "utf-8",
      env: skillEnv(),
    });
    return { ...result, ms: Date.now() - started };
  }

  it("kills a command that outlives the limit", () => {
    const result = runPortableTimeout("sleep 5");
    expect(result.status).not.toBe(0);
    expect(result.ms).toBeLessThan(4000);
  });

  it("passes a command that finishes in time through unchanged", () => {
    const result = runPortableTimeout("echo done");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("done");
  });
});
