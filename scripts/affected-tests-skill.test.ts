import { describe, expect, it } from "vitest";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { resolveAffectedTestCommand } from "../src/lib/stacks.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = {
  exec: ".claude/skills/exec/SKILL.md",
  qa: ".claude/skills/qa/SKILL.md",
};
const BEGIN = "<!-- BEGIN: affected-tests (#1349) -->";
const END = "<!-- END: affected-tests (#1349) -->";

/** Only the delimited region, so a doc header or comment elsewhere cannot satisfy a check. */
function region(skill: keyof typeof SKILLS): string {
  const content = readFileSync(join(ROOT, SKILLS[skill]), "utf-8");
  const start = content.indexOf(BEGIN);
  const end = content.indexOf(END);
  if (start === -1 || end === -1) return "";
  return content.slice(start, end);
}

/** The documented `grep -rlF "<changed path>" ...` command, with a path substituted. */
function reverseLookupCommand(skill: keyof typeof SKILLS, path: string) {
  const match = region(skill).match(/grep -rlF "<changed path>"[^`]*/);
  return match ? match[0].replace("<changed path>", path) : "";
}

describe("exec and qa run affected tests, not the full suite", () => {
  for (const skill of ["exec", "qa"] as const) {
    it(`${skill}: names the resolver's vitest and jest commands`, () => {
      const text = region(skill);
      expect(text).toContain(resolveAffectedTestCommand("generic", "vitest"));
      expect(text).toContain(resolveAffectedTestCommand("generic", "jest"));
      expect(text).toContain("Evidence:");
    });
  }

  it("exec: the documented reverse lookup finds the gate test of a changed skill file", () => {
    const cmd = reverseLookupCommand("exec", SKILLS.exec);
    expect(cmd).not.toBe("");
    const hits = execSync(cmd, { cwd: ROOT, encoding: "utf-8" }).split("\n");
    expect(hits).toContain("./scripts/exec-skill-marker.test.ts");
  });

  it("qa: the documented reverse lookup finds the gate test of a changed skill file", () => {
    const cmd = reverseLookupCommand("qa", SKILLS.exec);
    expect(cmd).not.toBe("");
    const hits = execSync(cmd, { cwd: ROOT, encoding: "utf-8" }).split("\n");
    expect(hits).toContain("./scripts/exec-skill-marker.test.ts");
  });
});
