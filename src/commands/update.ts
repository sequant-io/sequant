/**
 * sequant update - Update templates from the package
 */

import chalk from "chalk";
import { diffLines } from "diff";
import inquirer from "inquirer";
import { spawnSync } from "child_process";
import {
  getManifest,
  updateManifest,
  getPackageVersion,
} from "../lib/manifest.js";
import {
  getTemplateContent,
  listTemplateFiles,
  processTemplate,
} from "../lib/templates.js";
import { getConfig, saveConfig } from "../lib/config.js";
import {
  getStackConfig,
  PM_CONFIG,
  getPackageManagerCommands,
} from "../lib/stacks.js";
import { readFile, writeFile, fileExists } from "../lib/fs.js";

interface UpdateOptions {
  dryRun?: boolean;
  force?: boolean;
}

interface FileChange {
  path: string;
  status: "new" | "modified" | "unchanged" | "local-override";
  diff?: string;
}

export async function updateCommand(options: UpdateOptions): Promise<void> {
  console.log(chalk.blue("\n🔄 Checking for updates...\n"));
  console.log(
    chalk.yellow(
      "📢 Note: For seamless auto-updates, install sequant as a Claude Code plugin:\n" +
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
        `⚠️  Warning: You're running an older CLI version (${packageVersion}) than installed (${manifest.version}).`,
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
      console.log(chalk.blue(`📝 Added PM_RUN token: ${tokens.PM_RUN}\n`));
    }
  } else {
    // First-time config setup
    console.log(chalk.blue("📝 Setting up configuration (one-time setup)\n"));

    const stackConfig = getStackConfig(manifest.stack);
    const defaultDevUrl = stackConfig.devUrl;

    // Get package manager run command
    const pm = (manifest.packageManager as keyof typeof PM_CONFIG) || "npm";
    const pmConfig = getPackageManagerCommands(pm);

    if (options.force) {
      tokens = { DEV_URL: defaultDevUrl, PM_RUN: pmConfig.run };
      console.log(chalk.blue(`🌐 Using default dev URL: ${defaultDevUrl}`));
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
    console.log(chalk.green("✅ Configuration saved\n"));
  }

  // Get list of template files
  const templateFiles = await listTemplateFiles();
  const changes: FileChange[] = [];

  for (const templatePath of templateFiles) {
    const localPath = templatePath.replace("templates/", ".claude/");

    // Skip if in .local directory (user customizations)
    if (localPath.includes(".local/")) {
      continue;
    }

    const templateContent = await getTemplateContent(templatePath);
    const exists = await fileExists(localPath);

    if (!exists) {
      changes.push({ path: localPath, status: "new" });
    } else {
      const localContent = await readFile(localPath);
      if (localContent === templateContent) {
        changes.push({ path: localPath, status: "unchanged" });
      } else {
        // Check if there's a local override
        const localOverridePath = localPath.replace(
          ".claude/",
          ".claude/.local/",
        );
        const hasLocalOverride = await fileExists(localOverridePath);

        if (hasLocalOverride) {
          changes.push({ path: localPath, status: "local-override" });
        } else {
          const diff = diffLines(localContent, templateContent)
            .map((part) => {
              const prefix = part.added ? "+" : part.removed ? "-" : " ";
              return part.value
                .split("\n")
                .filter((l) => l)
                .map((l) => `${prefix} ${l}`)
                .join("\n");
            })
            .join("\n");
          changes.push({ path: localPath, status: "modified", diff });
        }
      }
    }
  }

  // Show summary
  const newFiles = changes.filter((c) => c.status === "new");
  const modifiedFiles = changes.filter((c) => c.status === "modified");
  const unchangedFiles = changes.filter((c) => c.status === "unchanged");
  const localOverrides = changes.filter((c) => c.status === "local-override");

  console.log(chalk.bold("Summary:"));
  console.log(chalk.green(`  ✨ New files: ${newFiles.length}`));
  console.log(chalk.yellow(`  📝 Modified: ${modifiedFiles.length}`));
  console.log(chalk.gray(`  ✓ Unchanged: ${unchangedFiles.length}`));
  console.log(chalk.blue(`  🔒 Local overrides: ${localOverrides.length}`));

  if (newFiles.length === 0 && modifiedFiles.length === 0) {
    console.log(chalk.green("\n✅ Everything is up to date!"));
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

  if (options.dryRun) {
    console.log(chalk.gray("\n(dry-run mode - no changes made)"));
    return;
  }

  // Confirm update
  if (!options.force) {
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

  // Apply updates
  console.log(chalk.blue("\n📥 Applying updates..."));
  let updated = 0;

  // Build complete variables for template processing
  const stackConfig = getStackConfig(manifest.stack);
  const variables = {
    ...stackConfig.variables,
    ...tokens,
    PROJECT_NAME: process.cwd().split("/").pop() || "project",
    STACK: manifest.stack,
  };

  for (const file of [...newFiles, ...modifiedFiles]) {
    const templatePath = file.path.replace(".claude/", "templates/");
    let content = await getTemplateContent(templatePath);
    // Process templates with tokens to replace {{DEV_URL}} etc.
    content = processTemplate(content, variables);
    await writeFile(file.path, content);
    updated++;
  }

  // Update manifest
  await updateManifest();

  console.log(chalk.green(`\n✅ Updated ${updated} files`));

  // Check if package.json was updated and run install
  const packageJsonUpdated = [...newFiles, ...modifiedFiles].some(
    (f) => f.path === "package.json" || f.path.endsWith("/package.json"),
  );

  if (packageJsonUpdated) {
    // Use detected package manager or default to npm
    const pm = (manifest.packageManager as keyof typeof PM_CONFIG) || "npm";
    const pmConfig = PM_CONFIG[pm];
    console.log(
      chalk.blue(`\n📦 package.json updated, running ${pmConfig.install}...`),
    );
    const [cmd, ...args] = pmConfig.install.split(" ");
    const result = spawnSync(cmd, args, {
      stdio: "inherit",
      shell: true,
    });
    if (result.status === 0) {
      console.log(chalk.green("✅ Dependencies installed"));
    } else {
      console.log(
        chalk.yellow(`⚠️  ${pmConfig.install} failed - run manually`),
      );
    }
  }
}
