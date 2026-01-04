/**
 * sequant update - Update templates from the package
 */

import chalk from "chalk";
import { diffLines } from "diff";
import inquirer from "inquirer";
import { getManifest, updateManifest } from "../lib/manifest.js";
import { getTemplateContent, listTemplateFiles } from "../lib/templates.js";
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

  // Check if initialized
  const manifest = await getManifest();
  if (!manifest) {
    console.log(
      chalk.red("❌ Sequant is not initialized. Run `sequant init` first."),
    );
    return;
  }

  console.log(chalk.gray(`Current version: ${manifest.version}`));
  console.log(chalk.gray(`Stack: ${manifest.stack}\n`));

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

  for (const file of [...newFiles, ...modifiedFiles]) {
    const templatePath = file.path.replace(".claude/", "templates/");
    const content = await getTemplateContent(templatePath);
    await writeFile(file.path, content);
    updated++;
  }

  // Update manifest
  await updateManifest();

  console.log(chalk.green(`\n✅ Updated ${updated} files`));
}
