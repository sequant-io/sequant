/**
 * sequant init - Initialize Sequant in a project
 */

import chalk from "chalk";
import inquirer from "inquirer";
import {
  detectStack,
  detectAllStacks,
  getStackConfig,
  detectPackageManager,
  getPackageManagerCommands,
  STACKS,
  type DetectedStack,
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
import { saveStackConfig, type StackConfigFile } from "../lib/stack-config.js";

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
  noSymlinks?: boolean;
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
  let additionalStacks: string[] = [];

  if (!stack) {
    // Check for multi-stack project in interactive mode
    const allDetectedStacks = !skipPrompts ? await detectAllStacks() : [];

    if (allDetectedStacks.length > 1 && !skipPrompts) {
      // Multi-stack project detected - show checkbox selection
      console.log(
        chalk.blue(
          `\n🔍 Detected ${allDetectedStacks.length} stacks in this project:`,
        ),
      );
      for (const ds of allDetectedStacks) {
        const location = ds.path ? ` (${ds.path}/)` : " (root)";
        console.log(
          chalk.gray(
            `   • ${STACKS[ds.stack]?.displayName || ds.stack}${location}`,
          ),
        );
      }
      console.log();

      // Multi-stack selection prompt
      const { selectedStacks } = await inquirer.prompt([
        {
          type: "checkbox",
          name: "selectedStacks",
          message: "Select stacks to include in your constitution:",
          choices: allDetectedStacks.map((ds) => ({
            name: `${STACKS[ds.stack]?.displayName || ds.stack}${ds.path ? ` (${ds.path}/)` : " (root)"}`,
            value: ds.stack,
            checked: true, // Pre-select all detected stacks
          })),
          validate: (answer: string[]) => {
            if (answer.length < 1) {
              return "You must select at least one stack.";
            }
            return true;
          },
        },
      ]);

      // First selected stack is the primary
      if (selectedStacks.length > 0) {
        stack = selectedStacks[0];
        additionalStacks = selectedStacks.slice(1);
      }

      // Confirm or change primary stack if multiple selected
      if (selectedStacks.length > 1) {
        const { primaryStack } = await inquirer.prompt([
          {
            type: "list",
            name: "primaryStack",
            message:
              "Which stack should be the primary? (determines dev URL and commands)",
            choices: selectedStacks.map((s: string) => ({
              name: STACKS[s]?.displayName || s,
              value: s,
            })),
          },
        ]);
        stack = primaryStack;
        additionalStacks = selectedStacks.filter(
          (s: string) => s !== primaryStack,
        );
      }
    } else {
      // Single stack detection (original behavior)
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
  }

  // Display selected stacks
  if (additionalStacks.length > 0) {
    console.log(chalk.blue(`\n📋 Primary Stack: ${stack}`));
    console.log(chalk.blue(`   Additional: ${additionalStacks.join(", ")}`));
  } else {
    console.log(chalk.blue(`\n📋 Stack: ${stack}`));
  }

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

  // Save multi-stack configuration if additional stacks selected
  if (additionalStacks.length > 0) {
    const stackConfig: StackConfigFile = {
      primary: { name: stack! },
      additional: additionalStacks.map((name) => ({ name })),
    };
    await saveStackConfig(stackConfig);
    console.log(chalk.blue("📋 Saved multi-stack configuration"));
  }

  // Create default settings
  console.log(chalk.blue("⚙️  Creating default settings..."));
  await createDefaultSettings();

  // Copy templates (with symlinks for scripts unless --no-symlinks)
  console.log(chalk.blue("📄 Copying templates..."));
  const { scriptsSymlinked, symlinkResults } = await copyTemplates(
    stack!,
    tokens,
    {
      noSymlinks: options.noSymlinks,
      force: options.force,
      additionalStacks,
    },
  );

  // Report symlink status
  if (scriptsSymlinked) {
    console.log(chalk.blue("🔗 Created symlinks for scripts/dev/"));
  } else if (!options.noSymlinks && symlinkResults) {
    // Some symlinks may have fallen back to copies
    const fallbacks = symlinkResults.filter((r) => r.fallbackToCopy);
    if (fallbacks.length > 0) {
      console.log(
        chalk.yellow("⚠️  Some scripts were copied instead of symlinked:"),
      );
      for (const fb of fallbacks) {
        console.log(chalk.gray(`   ${fb.path}: ${fb.reason}`));
      }
    }
    const skipped = symlinkResults.filter((r) => r.skipped);
    if (skipped.length > 0) {
      console.log(
        chalk.yellow("⚠️  Some scripts were skipped (existing files found):"),
      );
      for (const s of skipped) {
        console.log(chalk.gray(`   ${s.path}: ${s.reason}`));
      }
    }
  }

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
