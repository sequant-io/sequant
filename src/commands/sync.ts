/**
 * sequant sync - Fast, non-interactive template sync
 *
 * Syncs skills and other templates from the package to the local project.
 * Designed for plugin users who need to update after upgrading sequant.
 */

import chalk from "chalk";
import {
  getManifest,
  updateManifest,
  getPackageVersion,
} from "../lib/manifest.js";
import { copyTemplates, type CopyTemplatesOptions } from "../lib/templates.js";
import { getConfig } from "../lib/config.js";
import { writeFile, readFile, fileExists } from "../lib/fs.js";
import {
  generateAgentsMd,
  writeAgentsMd,
  AGENTS_MD_PATH,
} from "../lib/agents-md.js";
import { getProjectName } from "../lib/project-name.js";
import { getStackConfig } from "../lib/stacks.js";

const SKILLS_VERSION_PATH = ".claude/skills/.sequant-version";

interface SyncOptions {
  force?: boolean;
  quiet?: boolean;
}

/**
 * Get the version of skills currently installed
 */
export async function getSkillsVersion(): Promise<string | null> {
  if (!(await fileExists(SKILLS_VERSION_PATH))) {
    return null;
  }
  try {
    const content = await readFile(SKILLS_VERSION_PATH);
    return content.trim();
  } catch {
    return null;
  }
}

/**
 * Check if skills are outdated compared to package version
 */
export async function areSkillsOutdated(): Promise<{
  outdated: boolean;
  currentVersion: string | null;
  packageVersion: string;
}> {
  const currentVersion = await getSkillsVersion();
  const packageVersion = getPackageVersion();

  return {
    outdated: currentVersion !== packageVersion,
    currentVersion,
    packageVersion,
  };
}

/**
 * Update the skills version marker
 */
async function updateSkillsVersion(): Promise<void> {
  await writeFile(SKILLS_VERSION_PATH, getPackageVersion());
}

export async function syncCommand(options: SyncOptions = {}): Promise<void> {
  const { force = false, quiet = false } = options;

  if (!quiet) {
    console.log(chalk.blue("\nSyncing templates...\n"));
    console.log(
      chalk.yellow(
        "Note: For seamless auto-updates, install sequant as a Claude Code plugin:\n" +
          "   /plugin install sequant@claude-plugin-directory\n" +
          "   Plugin users get auto-updates without running sync manually.\n",
      ),
    );
  }

  // Check if initialized
  const manifest = await getManifest();
  if (!manifest) {
    console.log(
      chalk.red("❌ Sequant is not initialized. Run `sequant init` first."),
    );
    process.exitCode = 1;
    return;
  }

  const packageVersion = getPackageVersion();
  const skillsVersion = await getSkillsVersion();

  if (!quiet) {
    console.log(chalk.gray(`Skills version: ${skillsVersion || "(unknown)"}`));
    console.log(chalk.gray(`Package version: ${packageVersion}`));
    console.log(chalk.gray(`Stack: ${manifest.stack}\n`));
  }

  // Check if sync is needed
  if (!force && skillsVersion === packageVersion) {
    if (!quiet) {
      console.log(chalk.green("✔ Skills are already up to date!"));
    }
    return;
  }

  // Get config tokens for template processing
  const config = await getConfig();
  const tokens = config?.tokens || {};

  // Copy templates with force to overwrite existing files
  const copyOptions: CopyTemplatesOptions = {
    force: true, // Always overwrite when syncing
  };

  if (!quiet) {
    console.log(chalk.blue("Copying templates..."));
  }

  await copyTemplates(manifest.stack, tokens, copyOptions);

  // Update version markers
  await updateSkillsVersion();
  await updateManifest();

  // Regenerate AGENTS.md if it exists
  if (await fileExists(AGENTS_MD_PATH)) {
    try {
      const stackConfig = getStackConfig(manifest.stack);
      const projectName = await getProjectName();
      const agentsMdContent = await generateAgentsMd({
        projectName,
        stack: manifest.stack,
        buildCommand: stackConfig.variables.BUILD_COMMAND,
        testCommand: stackConfig.variables.TEST_COMMAND,
        lintCommand: stackConfig.variables.LINT_COMMAND,
      });
      await writeAgentsMd(agentsMdContent);
      if (!quiet) {
        console.log(chalk.blue("Regenerated AGENTS.md"));
      }
    } catch {
      if (!quiet) {
        console.log(
          chalk.yellow("!  Could not regenerate AGENTS.md (non-blocking)"),
        );
      }
    }
  }

  if (!quiet) {
    console.log(chalk.green(`\n✔ Synced to v${packageVersion}`));
    console.log(
      chalk.gray("\nSkills, hooks, and memory files have been updated."),
    );
  }
}

/**
 * Check and warn if skills are outdated (for use by other commands)
 */
export async function checkAndWarnSkillsOutdated(): Promise<boolean> {
  const { outdated, currentVersion, packageVersion } =
    await areSkillsOutdated();

  if (outdated) {
    console.log(
      chalk.yellow(
        `\n!  Skills are outdated (${currentVersion || "unknown"} → ${packageVersion})`,
      ),
    );
    console.log(chalk.yellow("   Run: npx sequant sync\n"));
    return true;
  }

  return false;
}
