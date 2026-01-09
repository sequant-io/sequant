/**
 * sequant init - Initialize Sequant in a project
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { detectStack, getStackConfig } from "../lib/stacks.js";
import { copyTemplates } from "../lib/templates.js";
import { createManifest } from "../lib/manifest.js";
import { saveConfig } from "../lib/config.js";
import { createDefaultSettings, SETTINGS_PATH } from "../lib/settings.js";
import { fileExists, ensureDir } from "../lib/fs.js";
import {
  commandExists,
  isGhAuthenticated,
  getInstallHint,
} from "../lib/system.js";

/**
 * Check prerequisites and display warnings
 */
function checkPrerequisites(): { warnings: string[]; suggestions: string[] } {
  const warnings: string[] = [];
  const suggestions: string[] = [];

  // Check for gh CLI
  if (!commandExists("gh")) {
    warnings.push(
      "GitHub CLI (gh) is not installed. Required for issue workflows.",
    );
    suggestions.push(`Install: ${getInstallHint("gh")}`);
  } else if (!isGhAuthenticated()) {
    warnings.push("GitHub CLI is not authenticated.");
    suggestions.push("Run: gh auth login");
  }

  // Check for jq (optional)
  if (!commandExists("jq")) {
    suggestions.push(
      `Optional: Install jq for faster JSON parsing (${getInstallHint("jq")})`,
    );
  }

  return { warnings, suggestions };
}

interface InitOptions {
  stack?: string;
  yes?: boolean;
  force?: boolean;
}

export async function initCommand(options: InitOptions): Promise<void> {
  console.log(chalk.green("\n🚀 Initializing Sequant...\n"));

  // Check prerequisites and display warnings
  const { warnings, suggestions } = checkPrerequisites();
  if (warnings.length > 0) {
    console.log(chalk.yellow("⚠️  Prerequisites:\n"));
    for (const warning of warnings) {
      console.log(chalk.yellow(`   • ${warning}`));
    }
    for (const suggestion of suggestions.filter(
      (s) => !s.startsWith("Optional"),
    )) {
      console.log(chalk.gray(`     ${suggestion}`));
    }
    console.log();
  }

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

  // Get stack config for default dev URL
  const stackConfig = getStackConfig(stack!);
  let devUrl = stackConfig.devUrl;

  // Prompt for dev URL
  if (options.yes) {
    console.log(chalk.blue(`🌐 Dev URL: ${devUrl} (default)`));
  } else {
    const { inputDevUrl } = await inquirer.prompt([
      {
        type: "input",
        name: "inputDevUrl",
        message: "Development server URL:",
        default: devUrl,
      },
    ]);
    devUrl = inputDevUrl;
  }

  // Show what will be created
  console.log(chalk.gray("\nWill create:"));
  console.log(chalk.gray("  .claude/"));
  console.log(chalk.gray("  ├── skills/         (14 workflow skills)"));
  console.log(chalk.gray("  ├── hooks/          (pre/post tool hooks)"));
  console.log(chalk.gray("  ├── memory/         (constitution & context)"));
  console.log(chalk.gray("  └── settings.json   (hooks configuration)"));
  console.log(chalk.gray("  .sequant/"));
  console.log(chalk.gray("  ├── settings.json   (run preferences)"));
  console.log(chalk.gray("  └── logs/           (workflow run logs)"));
  console.log(chalk.gray("  scripts/dev/"));
  console.log(chalk.gray("  └── *.sh            (worktree helpers)"));

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
  await ensureDir(".claude/.sequant");
  await ensureDir(".sequant/logs");
  await ensureDir("scripts/dev");

  // Save config with tokens
  console.log(chalk.blue("💾 Saving configuration..."));
  const tokens = { DEV_URL: devUrl };
  await saveConfig({
    tokens,
    stack: stack!,
    initialized: new Date().toISOString(),
  });

  // Create default settings
  console.log(chalk.blue("⚙️  Creating default settings..."));
  await createDefaultSettings();

  // Copy templates
  console.log(chalk.blue("📄 Copying templates..."));
  await copyTemplates(stack!, tokens);

  // Create manifest
  console.log(chalk.blue("📋 Creating manifest..."));
  await createManifest(stack!);

  // Build optional suggestions section
  const optionalSuggestions = suggestions.filter((s) =>
    s.startsWith("Optional"),
  );
  const optionalSection =
    optionalSuggestions.length > 0
      ? `\n${chalk.bold("Optional improvements:")}\n${optionalSuggestions.map((s) => `  • ${s.replace("Optional: ", "")}`).join("\n")}\n`
      : "";

  // Build prerequisites reminder if there were warnings
  const prereqReminder =
    warnings.length > 0
      ? `\n${chalk.yellow("⚠️  Remember to address prerequisites above before using issue workflows.")}\n`
      : "";

  // Success message
  console.log(
    chalk.green(`
✅ Sequant initialized successfully!
${prereqReminder}
${chalk.bold("Next steps:")}
  1. Review .claude/memory/constitution.md and customize for your project
  2. Start using workflow commands in Claude Code:

     ${chalk.cyan("/spec 123")}    - Plan implementation for issue #123
     ${chalk.cyan("/exec 123")}    - Implement the feature
     ${chalk.cyan("/qa 123")}      - Quality review
${optionalSection}
${chalk.bold("Documentation:")}
  https://github.com/admarble/sequant#readme
`),
  );
}
