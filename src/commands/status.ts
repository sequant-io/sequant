/**
 * sequant status - Show version and configuration
 */

import chalk from "chalk";
import { getManifest, getPackageVersion } from "../lib/manifest.js";
import { fileExists } from "../lib/fs.js";
import { readdir } from "fs/promises";

export async function statusCommand(): Promise<void> {
  console.log(chalk.bold("\n📊 Sequant Status\n"));

  // Package version
  console.log(chalk.gray(`Package version: ${getPackageVersion()}`));

  // Check initialization
  const manifest = await getManifest();
  if (!manifest) {
    console.log(chalk.yellow("Status: Not initialized"));
    console.log(chalk.gray("\nRun `sequant init` to get started."));
    return;
  }

  console.log(chalk.green("Status: Initialized"));
  console.log(chalk.gray(`Installed version: ${manifest.version}`));
  console.log(chalk.gray(`Stack: ${manifest.stack}`));
  console.log(chalk.gray(`Installed: ${manifest.installedAt}`));
  if (manifest.updatedAt) {
    console.log(chalk.gray(`Last updated: ${manifest.updatedAt}`));
  }

  // Count skills
  const skillsDir = ".claude/skills";
  if (await fileExists(skillsDir)) {
    try {
      const skills = await readdir(skillsDir);
      const skillCount = skills.filter((s) => !s.startsWith(".")).length;
      console.log(chalk.gray(`Skills: ${skillCount}`));
    } catch {
      // Ignore errors
    }
  }

  // Check for local customizations
  const localDir = ".claude/.local";
  if (await fileExists(localDir)) {
    console.log(chalk.blue("Custom overrides: Yes (.claude/.local/)"));
  }

  console.log(chalk.gray("\nRun `sequant doctor` for detailed health check."));
}
