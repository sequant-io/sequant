/**
 * #1345: Claude Code >= 2.1.286 tells Claude to run any project skill named
 * `verify` before committing. The shipped skill returns at once when it gets
 * no issue number, when a Sequant phase other than verify invokes it, or when
 * Claude calls it on its own before a commit. Projects that already hold the
 * old copy must receive the guard through the sync path (`copyTemplates` with
 * `overwriteCustomizable` unset, as `sequant update` / `sync` call it).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { copyTemplates } from "./templates.js";

const OLD_SKILL =
  "---\nname: verify\n---\n\n# Execution Verification\n\nYou are the agent.\n";
const GUARD_HEADING = "## Pre-commit invocations: return immediately";
const SKILL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../templates/skills/verify/SKILL.md",
);

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
    expect(region).toContain("SEQUANT_PHASE");
    expect(region).toContain("no-op");
    expect(region).toContain("post no comment");
    // The guard sits before the skill body, so §1 Parse Arguments never runs
    const skill = await readFile(dest, "utf-8");
    expect(skill.indexOf(GUARD_HEADING)).toBeLessThan(
      skill.indexOf("# Execution Verification"),
    );
  });

  it("the phase check is pre-approved and tells an exec agent from the verify phase (#1345)", async () => {
    const skill = await readFile(SKILL_PATH, "utf-8");
    const region = guardRegion(skill);
    const block = region.match(/```bash\n([\s\S]*?)\n\s*```/);
    expect(block).not.toBeNull();
    const command = block![1].trim();

    // allowed-tools pre-approves exactly this command, so the check never
    // prompts in an interactive session
    const frontmatter = skill.slice(0, skill.indexOf("\n---", 4));
    expect(frontmatter).toContain(`- Bash(${command})`);

    const run = (phase?: string) => {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
      if (phase !== undefined) env.SEQUANT_PHASE = phase;
      return spawnSync("sh", ["-c", command], {
        env,
        encoding: "utf-8",
      }).stdout.trim();
    };
    expect(run("exec")).toBe("exec");
    expect(run("verify")).toBe("verify");
    expect(run()).toBe("");
  });
});
