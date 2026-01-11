/**
 * sequant init - Initialize Sequant in a project
 */

import chalk from "chalk";
import inquirer from "inquirer";
import {
  detectStack,
  getStackConfig,
  detectPackageManager,
  getPackageManagerCommands,
} from "../lib/stacks.js";
import { copyTemplates } from "../lib/templates.js";
import { createManifest } from "../lib/manifest.js";
import { saveConfig } from "../lib/config.js";
import { createDefaultSettings } from "../lib/settings.js";
import { fileExists, ensureDir, readFile, writeFile } from "../lib/fs.js";
import {
  commandExists,
  isGhAuthenticated,
  getInstallHint,
} from "../lib/system.js";
import {
  shouldUseInteractiveMode,
  getNonInteractiveReason,
} from "../lib/tty.js";
import {
  checkAllDependencies,
  displayDependencyStatus,
  runSetupWizard,
  shouldRunSetupWizard,
} from "../lib/wizard.js";

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
  interactive?: boolean;
  skipSetup?: boolean;
}

/**
 * Entries to add to .gitignore
 */
const GITIGNORE_ENTRIES = [
  "",
  "# Sequant runtime data (logs, settings)",
  ".sequant/",
];

/**
 * Update .gitignore with Sequant entries
 */
async function updateGitignore(): Promise<boolean> {
  const gitignorePath = ".gitignore";
  let content = "";

  if (await fileExists(gitignorePath)) {
    content = await readFile(gitignorePath);

    // Check if already has .sequant/
    if (content.includes(".sequant/")) {
      return false; // Already configured
    }
  }

  // Append entries
  const newContent =
    content.trimEnd() + "\n" + GITIGNORE_ENTRIES.join("\n") + "\n";
  await writeFile(gitignorePath, newContent);
  return true;
}

/**
 * Log a default value being used in non-interactive mode
 */
function logDefault(label: string, value: string): void {
  console.log(chalk.blue(`📦 ${label}: ${value} (default)`));
}

export async function initCommand(options: InitOptions): Promise<void> {
  console.log(chalk.green("\n🚀 Initializing Sequant...\n"));

  // Determine if we should use interactive mode
  const useInteractive = shouldUseInteractiveMode(options.interactive);
  const skipPrompts = options.yes || !useInteractive;

  // Show non-interactive mode message if applicable
  if (!useInteractive && !options.yes) {
    const reason = getNonInteractiveReason();
    console.log(
      chalk.yellow(
        `⚡ Non-interactive mode detected${reason ? ` (${reason})` : ""}`,
      ),
    );
    console.log(
      chalk.gray("   Using defaults. Use --interactive to force prompts.\n"),
    );
  }

  // Check dependencies and run setup wizard if needed
  const depCheckResult = checkAllDependencies();
  let wizardRemainingIssues: string[] = [];

  if (
    shouldRunSetupWizard({ skipSetup: options.skipSetup, yes: options.yes })
  ) {
    // Display dependency status
    displayDependencyStatus(depCheckResult);

    // Run wizard if there are missing required dependencies
    if (depCheckResult.hasMissing) {
      const wizardResult = await runSetupWizard(depCheckResult, {
        skipPrompts,
      });
      wizardRemainingIssues = wizardResult.remainingIssues;
    }
  } else if (options.skipSetup) {
    // User explicitly skipped - show brief status
    console.log(
      chalk.gray("Skipping dependency setup wizard (--skip-setup)\n"),
    );
  }

  // Fall back to legacy warning system for any remaining issues
  const { warnings, suggestions } = checkPrerequisites();

  // Only show warnings if wizard didn't already handle them or if there are remaining issues
  if (
    wizardRemainingIssues.length > 0 ||
    (options.skipSetup && warnings.length > 0)
  ) {
    if (wizardRemainingIssues.length > 0) {
      console.log(chalk.yellow("⚠️  Remaining setup issues:\n"));
      for (const issue of wizardRemainingIssues) {
        console.log(chalk.yellow(`   • ${issue}`));
      }
      console.log();
    } else if (warnings.length > 0) {
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

    if (!skipPrompts) {
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
    if (detected && skipPrompts) {
      stack = detected;
      logDefault("Detected stack", stack);
    } else if (detected && !skipPrompts) {
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

    if (!stack && skipPrompts) {
      // No detection and skipping prompts: use generic as default
      stack = "generic";
      logDefault("Using stack", stack);
    } else if (!stack) {
      const { selectedStack } = await inquirer.prompt([
        {
          type: "list",
          name: "selectedStack",
          message: "Select your project stack:",
          choices: [
            { name: "Next.js / React", value: "nextjs" },
            { name: "Astro", value: "astro" },
            { name: "SvelteKit", value: "sveltekit" },
            { name: "Remix", value: "remix" },
            { name: "Nuxt", value: "nuxt" },
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

  // Detect package manager
  const packageManager = await detectPackageManager();
  if (packageManager) {
    console.log(chalk.blue(`📦 Package Manager: ${packageManager}`));
  }

  // Get stack config for default dev URL
  const stackConfig = getStackConfig(stack!);
  let devUrl = stackConfig.devUrl;

  // Prompt for dev URL
  if (skipPrompts) {
    logDefault("Dev URL", devUrl);
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

  if (!skipPrompts) {
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

  // Update .gitignore
  const gitignoreUpdated = await updateGitignore();
  if (gitignoreUpdated) {
    console.log(chalk.blue("📝 Updated .gitignore with Sequant entries"));
  }

  // Save config with tokens
  console.log(chalk.blue("💾 Saving configuration..."));
  const pmConfig = packageManager
    ? getPackageManagerCommands(packageManager)
    : getPackageManagerCommands("npm");
  const tokens = {
    DEV_URL: devUrl,
    PM_RUN: pmConfig.run, // e.g., "npm run", "bun run", "yarn", "pnpm run"
  };
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
  await createManifest(stack!, packageManager ?? undefined);

  // Build optional suggestions section
  const optionalSuggestions = suggestions.filter((s) =>
    s.startsWith("Optional"),
  );
  const optionalSection =
    optionalSuggestions.length > 0
      ? `\n${chalk.bold("Optional improvements:")}\n${optionalSuggestions.map((s) => `  • ${s.replace("Optional: ", "")}`).join("\n")}\n`
      : "";

  // Build prerequisites reminder if there were remaining issues from wizard or warnings
  const hasRemainingIssues =
    wizardRemainingIssues.length > 0 || warnings.length > 0;
  const prereqReminder = hasRemainingIssues
    ? `\n${chalk.yellow("⚠️  Remember to install missing dependencies before using issue workflows.")}\n${chalk.gray("   Run 'sequant doctor' to verify your setup.\n")}`
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
