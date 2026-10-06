/**
 * #1345: Claude Code >= 2.1.286 tells Claude to run any project skill named
 * `verify` before committing. The shipped skill returns at once when it gets
 * no issue number. Projects that already hold the old copy must receive the
 * guard through the sync path (`copyTemplates` with `overwriteCustomizable`
 * unset, as `sequant update` / `sync` call it).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { copyTemplates } from "./templates.js";

const OLD_SKILL =
  "---\nname: verify\n---\n\n# Execution Verification\n\nYou are the agent.\n";
const GUARD_HEADING = "## No issue number: return immediately";

/** The guard section: from its heading to the next top-level heading. */
function guardRegion(skill: string): string {
  const start = skill.indexOf(GUARD_HEADING);
  if (start === -1) return "";
  const rest = skill.slice(start + GUARD_HEADING.length);
  const end = rest.search(/^# /m);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("verify skill pre-commit guard (#1345)", () => {
  let cwdDir: string;
  let prevCwd: string;

  beforeEach(async () => {
    prevCwd = process.cwd();
    cwdDir = await mkdtemp(join(tmpdir(), "sequant-verify-guard-"));
    process.chdir(cwdDir);
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await rm(cwdDir, { recursive: true, force: true });
  });

  it("sync replaces a project's old .claude/skills/verify with the guarded skill (AC-3)", async () => {
    const dest = join(".claude", "skills", "verify", "SKILL.md");
    await mkdir(join(".claude", "skills", "verify"), { recursive: true });
    await writeFile(dest, OLD_SKILL);
    expect(guardRegion(await readFile(dest, "utf-8"))).toBe("");

    await copyTemplates("generic");

    const region = guardRegion(await readFile(dest, "utf-8"));
    expect(region).toContain("no issue number");
    expect(region).toContain("no-op");
    expect(region).toContain("post no comment");
    // The guard sits before the skill body, so §1 Parse Arguments never runs
    const skill = await readFile(dest, "utf-8");
    expect(skill.indexOf(GUARD_HEADING)).toBeLessThan(
      skill.indexOf("# Execution Verification"),
    );
  });
});
