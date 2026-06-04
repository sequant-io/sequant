/**
 * sequant update - Update templates from the package
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { spawnSync } from "child_process";
import {
  getManifest,
  updateManifest,
  getPackageVersion,
} from "../lib/manifest.js";
import { computeTemplateChanges } from "../lib/templates.js";
import { getConfig, saveConfig } from "../lib/config.js";
import {
  getStackConfig,
  PM_CONFIG,
  getPackageManagerCommands,
} from "../lib/stacks.js";
import { writeFile } from "../lib/fs.js";
import { isStdinTTY } from "../lib/tty.js";

interface UpdateOptions {
  dryRun?: boolean;
  force?: boolean;
  yes?: boolean;
}

/**
 * Print an actionable message and set a non-zero exit code when a prompt is
 * required but stdin is not a TTY (piped/CI). Prevents inquirer from throwing a
 * raw ExitPromptError stack trace. Callers should `return` immediately after.
 */
function refuseNonInteractive(): void {
  console.error(
    chalk.red(
      "\n❌ non-interactive shell: `update` needs to prompt but stdin is not a terminal.",
    ),
  );
  console.error(
    chalk.yellow(
      "   Re-run with `--yes` (or `-y`) to apply updates without prompting.",
    ),
  );
  process.exitCode = 1;
}

export async function updateCommand(options: UpdateOptions): Promise<void> {
  console.log(chalk.blue("\nChecking for updates...\n"));
  console.log(
    chalk.yellow(
      "Note: For seamless auto-updates, install sequant as a Claude Code plugin:\n" +
        "   /plugin install sequant@claude-plugin-directory\n" +
        "   Plugin users get auto-updates without running update manually.\n",
    ),
  );

  // Check if initialized
  const manifest = await getManifest();
  if (!manifest) {
    console.log(
      chalk.red("❌ Sequant is not initialized. Run `sequant init` first."),
    );
    return;
  }

  const packageVersion = getPackageVersion();
  console.log(chalk.gray(`Current version: ${manifest.version}`));
  console.log(chalk.gray(`Stack: ${manifest.stack}`));
  console.log(chalk.gray(`CLI version: ${packageVersion}\n`));

  // Warn if running an older CLI version than what's installed
  const [mMajor, mMinor, mPatch] = manifest.version.split(".").map(Number);
  const [pMajor, pMinor, pPatch] = packageVersion.split(".").map(Number);
  const manifestNum = mMajor * 10000 + mMinor * 100 + mPatch;
  const packageNum = pMajor * 10000 + pMinor * 100 + pPatch;
  if (packageNum < manifestNum) {
    console.log(
      chalk.yellow(
        `!  Warning: You're running an older CLI version (${packageVersion}) than installed (${manifest.version}).`,
      ),
    );
    console.log(chalk.yellow(`   Run with: npx sequant@latest update\n`));
  }

  // Get config with tokens (or migrate legacy installs)
  let config = await getConfig();
  let tokens: Record<string, string>;

  if (config) {
    tokens = config.tokens;
    console.log(chalk.gray(`Dev URL: ${tokens.DEV_URL || "(not set)"}\n`));

    // Add PM_RUN if missing (for existing installs before v1.3.0)
    if (!tokens.PM_RUN) {
      const pm = (manifest.packageManager as keyof typeof PM_CONFIG) || "npm";
      const pmConfig = getPackageManagerCommands(pm);
      tokens.PM_RUN = pmConfig.run;
      config.tokens = tokens;
      await saveConfig(config);
      console.log(chalk.blue(`Added PM_RUN token: ${tokens.PM_RUN}\n`));
    }
  } else {
    // First-time config setup
    console.log(chalk.blue("Setting up configuration (one-time setup)\n"));

    const stackConfig = getStackConfig(manifest.stack);
    const defaultDevUrl = stackConfig.devUrl;

    // Get package manager run command
    const pm = (manifest.packageManager as keyof typeof PM_CONFIG) || "npm";
    const pmConfig = getPackageManagerCommands(pm);

    if (options.force || options.yes) {
      tokens = { DEV_URL: defaultDevUrl, PM_RUN: pmConfig.run };
      console.log(chalk.blue(`Using default dev URL: ${defaultDevUrl}`));
    } else if (!isStdinTTY()) {
      refuseNonInteractive();
      return;
    } else {
      const { inputDevUrl } = await inquirer.prompt([
        {
          type: "input",
          name: "inputDevUrl",
          message: "Development server URL:",
          default: defaultDevUrl,
        },
      ]);
      tokens = { DEV_URL: inputDevUrl, PM_RUN: pmConfig.run };
    }

    // Save the new config
    config = {
      tokens,
      stack: manifest.stack,
      initialized: manifest.installedAt,
    };
    await saveConfig(config);
    console.log(chalk.green("✔ Configuration saved\n"));
  }

  // Compute changes using the shared, variable-aware comparison.
  // Templates are rendered (PROJECT_NAME, STACK_NOTES, etc.) before diffing,
  // and in-place-customizable files (constitution) are protected as overrides.
  const changes = await computeTemplateChanges(manifest.stack, tokens);

  // Show summary
  const newFiles = changes.filter((c) => c.status === "new");
  const modifiedFiles = changes.filter((c) => c.status === "modified");
  const unchangedFiles = changes.filter((c) => c.status === "unchanged");
  const localOverrides = changes.filter((c) => c.status === "local-override");

  console.log(chalk.bold("Summary:"));
  console.log(chalk.green(`  New files: ${newFiles.length}`));
  console.log(chalk.yellow(`  Modified: ${modifiedFiles.length}`));
  console.log(chalk.gray(`  ✓ Unchanged: ${unchangedFiles.length}`));
  console.log(chalk.blue(`  Local overrides: ${localOverrides.length}`));

  // Local overrides are protected by default — only --force overwrites them.
  const applySet = options.force
    ? [...newFiles, ...modifiedFiles, ...localOverrides]
    : [...newFiles, ...modifiedFiles];

  if (applySet.length === 0) {
    if (localOverrides.length > 0) {
      console.log(
        chalk.blue(
          `\n✔ No updates to apply. ${localOverrides.length} local override(s) protected (use --force to overwrite).`,
        ),
      );
    } else {
      console.log(chalk.green("\n✔ Everything is up to date!"));
    }
    return;
  }

  // Show changes
  if (modifiedFiles.length > 0) {
    console.log(chalk.bold("\nModified files:"));
    for (const file of modifiedFiles) {
      console.log(chalk.yellow(`  ${file.path}`));
      if (options.dryRun && file.diff) {
        console.log(chalk.gray(file.diff));
      }
    }
  }

  if (newFiles.length > 0) {
    console.log(chalk.bold("\nNew files:"));
    for (const file of newFiles) {
      console.log(chalk.green(`  ${file.path}`));
    }
  }

  if (options.force && localOverrides.length > 0) {
    console.log(chalk.bold("\nLocal overrides (forced overwrite):"));
    for (const file of localOverrides) {
      console.log(chalk.blue(`  ${file.path}`));
    }
  }

  if (options.dryRun) {
    console.log(chalk.gray("\n(dry-run mode - no changes made)"));
    return;
  }

  // Confirm update. --yes and --force both auto-confirm; otherwise we need a
  // prompt, which is impossible without a TTY — bail cleanly instead of crashing.
  if (!options.force && !options.yes) {
    if (!isStdinTTY()) {
      refuseNonInteractive();
      return;
    }
    const { proceed } = await inquirer.prompt([
      {
        type: "confirm",
        name: "proceed",
        message: "Apply updates?",
        default: true,
      },
    ]);
    if (!proceed) {
      console.log(chalk.gray("Aborted."));
      return;
    }
  }

  // Apply updates — content was already rendered with the shared variable set
  // during change detection, so just write it.
  console.log(chalk.blue("\nApplying updates..."));
  let updated = 0;

  for (const file of applySet) {
    await writeFile(file.path, file.rendered);
    updated++;
  }

  // Update manifest
  await updateManifest();

  console.log(chalk.green(`\n✔ Updated ${updated} files`));

  // Check if package.json was updated and run install
  const packageJsonUpdated = applySet.some(
    (f) => f.path === "package.json" || f.path.endsWith("/package.json"),
  );

  if (packageJsonUpdated) {
    // Use detected package manager or default to npm
    const pm = (manifest.packageManager as keyof typeof PM_CONFIG) || "npm";
    const pmConfig = PM_CONFIG[pm];
    console.log(
      chalk.blue(`\npackage.json updated, running ${pmConfig.install}...`),
    );
    const [cmd, ...args] = pmConfig.install.split(" ");
    const result = spawnSync(cmd, args, {
      stdio: "inherit",
      shell: true,
    });
    if (result.status === 0) {
      console.log(chalk.green("✔ Dependencies installed"));
    } else {
      console.log(chalk.yellow(`!  ${pmConfig.install} failed - run manually`));
    }
  }
}
