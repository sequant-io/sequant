/**
 * Skills installation check — single source of truth for the
 * `.claude/skills/<skill>/SKILL.md` layout.
 *
 * Shared by `doctor` (Checks 2+3) and the `run` pre-flight (#813) so the two
 * cannot drift. The claude-code driver loads skills from project scope only
 * (`settingSources: ["project"]`, see #19 AC-3 / #711), which makes
 * `.claude/skills/` a hard runtime dependency: a phase prompt like
 * "Run the /spec workflow" can never resolve without it.
 */

import { join } from "path";
import { fileExists } from "./fs.js";

/** Directory (relative to a project root) that skills are resolved from. */
export const SKILLS_DIR = ".claude/skills";

export interface SkillsCheckResult {
  /** True when the `.claude/skills/` directory exists. */
  skillsDirExists: boolean;
  /** Requested skills whose `SKILL.md` is missing, in input order. */
  missingSkills: string[];
}

/**
 * Check that each requested skill is installed at
 * `<cwd>/.claude/skills/<skill>/SKILL.md`.
 *
 * @param skills - Skill directory names to require (e.g. `["spec", "exec"]`).
 * @param cwd - Project root to check under (default: `process.cwd()`).
 */
export async function checkSkillsInstalled(
  skills: string[],
  cwd: string = process.cwd(),
): Promise<SkillsCheckResult> {
  const skillsDirExists = await fileExists(join(cwd, SKILLS_DIR));
  const missingSkills: string[] = [];
  for (const skill of skills) {
    if (!(await fileExists(join(cwd, SKILLS_DIR, skill, "SKILL.md")))) {
      missingSkills.push(skill);
    }
  }
  return { skillsDirExists, missingSkills };
}
