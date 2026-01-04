/**
 * sequant init - Initialize Sequant in a project
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { detectStack } from "../lib/stacks.js";
import { copyTemplates } from "../lib/templates.js";
import { createManifest } from "../lib/manifest.js";
import { fileExists, ensureDir } from "../lib/fs.js";

interface InitOptions {
  stack?: string;
  yes?: boolean;
  force?: boolean;
}

export async function initCommand(options: InitOptions): Promise<void> {
  console.log(chalk.green("\n🚀 Initializing Sequant...\n"));

  // Check if already initialized
  const configExists = await fileExists(".claude/settings.json");
  if (configExists && !options.force) {
    console.log(
      chalk.yellow(
        "⚠️  Sequant appears to be already initialized (.claude/settings.json exists)",
      ),
    );
    console.log(chalk.gray("   Use --force to reinitialize\n"));

    if (!options.yes) {
      const { proceed } = await inquirer.prompt([
        {
          type: "confirm",
          name: "proceed",
          message: "Continue anyway?",
          default: false,
        },
      ]);
      if (!proceed) {
        console.log(chalk.gray("Aborted."));
        return;
      }
    }
  }

  // Detect or prompt for stack
  let stack = options.stack;
  if (!stack) {
    const detected = await detectStack();
    if (detected && options.yes) {
      stack = detected;
      console.log(chalk.blue(`📦 Detected stack: ${stack}`));
    } else if (detected) {
      const { confirmedStack } = await inquirer.prompt([
        {
          type: "list",
          name: "confirmedStack",
          message: `Detected ${detected} project. Is this correct?`,
          choices: [
            { name: `Yes, use ${detected}`, value: detected },
            { name: "No, let me choose", value: null },
          ],
        },
      ]);
      stack = confirmedStack;
    }

    if (!stack) {
      const { selectedStack } = await inquirer.prompt([
        {
          type: "list",
          name: "selectedStack",
          message: "Select your project stack:",
          choices: [
            { name: "Next.js / React", value: "nextjs" },
            { name: "Rust", value: "rust" },
            { name: "Python", value: "python" },
            { name: "Go", value: "go" },
            { name: "Generic (no stack-specific config)", value: "generic" },
          ],
        },
      ]);
      stack = selectedStack;
    }
  }

  console.log(chalk.blue(`\n📋 Stack: ${stack}`));

  // Show what will be created
  console.log(chalk.gray("\nWill create:"));
  console.log(chalk.gray("  .claude/"));
  console.log(chalk.gray("  ├── skills/         (14 workflow skills)"));
  console.log(chalk.gray("  ├── hooks/          (pre/post tool hooks)"));
  console.log(chalk.gray("  ├── memory/         (constitution & context)"));
  console.log(chalk.gray("  └── settings.json   (hooks configuration)"));

  if (!options.yes) {
    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: "Proceed with installation?",
        default: true,
      },
    ]);
    if (!confirm) {
      console.log(chalk.gray("Aborted."));
      return;
    }
  }

  // Create directories
  console.log(chalk.blue("\n📁 Creating directories..."));
  await ensureDir(".claude/skills");
  await ensureDir(".claude/hooks");
  await ensureDir(".claude/memory");

  // Copy templates
  console.log(chalk.blue("📄 Copying templates..."));
  await copyTemplates(stack!);

  // Create manifest
  console.log(chalk.blue("📋 Creating manifest..."));
  await createManifest(stack!);

  // Success message
  console.log(
    chalk.green(`
✅ Sequant initialized successfully!

${chalk.bold("Next steps:")}
  1. Review .claude/memory/constitution.md and customize for your project
  2. Start using workflow commands in Claude Code:

     ${chalk.cyan("/spec 123")}    - Plan implementation for issue #123
     ${chalk.cyan("/exec 123")}    - Implement the feature
     ${chalk.cyan("/qa 123")}      - Quality review

${chalk.bold("Documentation:")}
  https://github.com/admarble/sequant#readme
`),
  );
}
