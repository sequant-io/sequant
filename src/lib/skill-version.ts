/**
 * Skill version utilities — reads version from SKILL.md YAML frontmatter
 */

import { readdir } from "fs/promises";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { readFile, fileExists } from "./fs.js";

export interface SkillVersionInfo {
  name: string;
  installedVersion: string | null;
  templateVersion: string | null;
  updateAvailable: boolean;
}

/**
 * Parse YAML frontmatter from a SKILL.md file and extract the version field.
 * Returns null if no version is found or file doesn't exist.
 */
export function parseSkillVersion(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  try {
    const frontmatter = parseYaml(match[1]);
    return frontmatter?.version ?? frontmatter?.metadata?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Read version from a single skill's SKILL.md file.
 */
async function readSkillVersion(skillDir: string): Promise<string | null> {
  const skillPath = join(skillDir, "SKILL.md");
  if (!(await fileExists(skillPath))) return null;

  const content = await readFile(skillPath);
  return parseSkillVersion(content);
}

/**
 * Get version info for all installed skills, comparing installed (.claude/skills/)
 * with template versions (from the sequant package's templates/skills/).
 */
export async function getSkillVersions(
  templateDir?: string,
): Promise<SkillVersionInfo[]> {
  const installedDir = ".claude/skills";
  const results: SkillVersionInfo[] = [];

  if (!(await fileExists(installedDir))) return results;

  try {
    const entries = await readdir(installedDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

      const installedVersion = await readSkillVersion(
        join(installedDir, entry.name),
      );

      let templateVersion: string | null = null;
      if (templateDir) {
        templateVersion = await readSkillVersion(join(templateDir, entry.name));
      }

      const updateAvailable =
        installedVersion !== null &&
        templateVersion !== null &&
        installedVersion !== templateVersion;

      results.push({
        name: entry.name,
        installedVersion,
        templateVersion,
        updateAvailable,
      });
    }
  } catch {
    // Ignore errors reading skills directory
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}
