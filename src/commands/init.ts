/**
 * sequant init - Initialize Sequant in a project
 */

import chalk from "chalk";
import { diffLines } from "diff";
import inquirer from "inquirer";
import { join, dirname } from "path";
import { readdir } from "fs/promises";
import { ui, colors } from "../lib/cli-ui.js";
import {
  detectStack,
  detectAllStacks,
  getStackConfig,
  detectPackageManager,
  getPackageManagerCommands,
  STACKS,
} from "../lib/stacks.js";
import { copyTemplates } from "../lib/templates.js";
import { createManifest } from "../lib/manifest.js";
import { saveConfig } from "../lib/config.js";
import {
  createDefaultSettings,
  generateSettingsReference,
} from "../lib/settings.js";
import { detectAndSaveConventions } from "../lib/conventions-detector.js";
import { fileExists, ensureDir, readFile, writeFile } from "../lib/fs.js";
import { generateAgentsMd, writeAgentsMd } from "../lib/agents-md.js";
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
  agentsMd?: boolean;
  mcp?: boolean;
  upgradeSkills?: boolean;
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
  console.log(chalk.blue(`${label}: ${value} (default)`));
}

export async function initCommand(options: InitOptions): Promise<void> {
  // Handle --upgrade-skills: update skill files from installed package templates
  if (options.upgradeSkills) {
    await upgradeSkills();
    return;
  }

  // Show banner
  console.log(ui.banner());
  console.log(colors.success("\nInitializing Sequant...\n"));

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
      console.log(chalk.yellow("!  Remaining setup issues:\n"));
      for (const issue of wizardRemainingIssues) {
        console.log(chalk.yellow(`   • ${issue}`));
      }
      console.log();
    } else if (warnings.length > 0) {
      console.log(chalk.yellow("!  Prerequisites:\n"));
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
        "!  Sequant appears to be already initialized (.claude/settings.json exists)",
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
          `\nDetected ${allDetectedStacks.length} stacks in this project:`,
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
    console.log(chalk.blue(`Package Manager: ${packageManager}`));
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
  if (options.agentsMd !== false) {
    console.log(
      chalk.gray("  AGENTS.md           (universal agent instructions)"),
    );
  }
  console.log(
    chalk.gray("  .mcp.json           (Claude Code MCP server config)"),
  );

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

  // Create directories with spinner
  const dirSpinner = ui.spinner("Creating directories...");
  dirSpinner.start();
  await ensureDir(".claude/skills");
  await ensureDir(".claude/hooks");
  await ensureDir(".claude/memory");
  await ensureDir(".claude/.sequant");
  await ensureDir(".sequant/logs");
  await ensureDir("scripts/dev");
  dirSpinner.succeed("Created directories");

  // Update .gitignore
  const gitignoreUpdated = await updateGitignore();
  if (gitignoreUpdated) {
    ui.printStatus("success", "Updated .gitignore with Sequant entries");
  }

  // Save config with tokens
  const configSpinner = ui.spinner("Saving configuration...");
  configSpinner.start();
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
  configSpinner.succeed("Saved configuration");

  // Save multi-stack configuration if additional stacks selected
  if (additionalStacks.length > 0) {
    const stackConfig: StackConfigFile = {
      primary: { name: stack! },
      additional: additionalStacks.map((name) => ({ name })),
    };
    await saveStackConfig(stackConfig);
    console.log(chalk.blue("📋 Saved multi-stack configuration"));
  }

  // Create default settings + reference doc (AC-4)
  const settingsSpinner = ui.spinner("Creating default settings...");
  settingsSpinner.start();
  await createDefaultSettings();
  await writeFile(
    ".sequant/settings.reference.md",
    generateSettingsReference(),
  );
  settingsSpinner.succeed("Created default settings + reference doc");

  // Detect codebase conventions
  const conventionsSpinner = ui.spinner("Detecting codebase conventions...");
  conventionsSpinner.start();
  try {
    const conventions = await detectAndSaveConventions(process.cwd());
    const count = Object.keys(conventions.detected).length;
    conventionsSpinner.succeed(`Detected ${count} codebase conventions`);
  } catch {
    conventionsSpinner.warn("Could not detect conventions (non-blocking)");
  }

  // Copy templates (with symlinks for scripts unless --no-symlinks)
  const templatesSpinner = ui.spinner("Copying templates...");
  templatesSpinner.start();
  const { scriptsSymlinked, symlinkResults } = await copyTemplates(
    stack!,
    tokens,
    {
      noSymlinks: options.noSymlinks,
      force: options.force,
      additionalStacks,
    },
  );

  templatesSpinner.succeed("Copied templates");

  // Report symlink status
  if (scriptsSymlinked) {
    ui.printStatus("success", "Created symlinks for scripts/dev/");
  } else if (!options.noSymlinks && symlinkResults) {
    // Some symlinks may have fallen back to copies
    const fallbacks = symlinkResults.filter((r) => r.fallbackToCopy);
    if (fallbacks.length > 0) {
      console.log(
        chalk.yellow("!  Some scripts were copied instead of symlinked:"),
      );
      for (const fb of fallbacks) {
        console.log(chalk.gray(`   ${fb.path}: ${fb.reason}`));
      }
    }
    const skipped = symlinkResults.filter((r) => r.skipped);
    if (skipped.length > 0) {
      console.log(
        chalk.yellow("!  Some scripts were skipped (existing files found):"),
      );
      for (const s of skipped) {
        console.log(chalk.gray(`   ${s.path}: ${s.reason}`));
      }
    }
  }

  // Create manifest
  const manifestSpinner = ui.spinner("Creating manifest...");
  manifestSpinner.start();
  await createManifest(stack!, packageManager ?? undefined);
  manifestSpinner.succeed("Created manifest");

  // Generate AGENTS.md (unless --no-agents-md)
  if (options.agentsMd !== false) {
    const agentsSpinner = ui.spinner("Generating AGENTS.md...");
    agentsSpinner.start();
    try {
      const stackConfig = getStackConfig(stack!);
      const { getProjectName } = await import("../lib/project-name.js");
      const projectName = await getProjectName();
      const agentsMdContent = await generateAgentsMd({
        projectName,
        stack: stack!,
        buildCommand: stackConfig.variables.BUILD_COMMAND,
        testCommand: stackConfig.variables.TEST_COMMAND,
        lintCommand: stackConfig.variables.LINT_COMMAND,
      });
      await writeAgentsMd(agentsMdContent);
      agentsSpinner.succeed("Generated AGENTS.md");
    } catch {
      agentsSpinner.warn("Could not generate AGENTS.md (non-blocking)");
    }
  } else {
    console.log(chalk.gray("Skipping AGENTS.md generation (--no-agents-md)"));
  }

  // Create .mcp.json for Claude Code (always, regardless of --mcp flag)
  const { createProjectMcpJson, detectMcpClients, addSequantToMcpConfig } =
    await import("../lib/mcp-config.js");
  const mcpJsonResult = createProjectMcpJson();
  if (mcpJsonResult.created) {
    ui.printStatus("success", "Created .mcp.json (Claude Code MCP config)");
  } else if (mcpJsonResult.merged) {
    ui.printStatus("success", "Added Sequant to existing .mcp.json");
  } else {
    console.log(
      chalk.gray("   .mcp.json: sequant already configured (skipped)"),
    );
  }

  // Offer MCP server configuration for detected clients (global configs)
  const mcpClients = detectMcpClients();
  const detectedClients = mcpClients.filter((c) => c.exists);

  if (detectedClients.length > 0) {
    console.log(
      chalk.blue(
        `\nDetected ${detectedClients.length} MCP-compatible client(s):`,
      ),
    );
    for (const client of detectedClients) {
      console.log(chalk.gray(`   • ${client.name}`));
    }

    let addMcp: boolean;
    if (skipPrompts) {
      // --yes alone skips MCP config; --yes --mcp explicitly opts in
      addMcp = !!options.mcp;
      if (!addMcp) {
        console.log(
          chalk.gray(
            "   Skipping MCP config (use --mcp to auto-add in non-interactive mode)",
          ),
        );
      }
    } else {
      const { confirm } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirm",
          message:
            "Add Sequant MCP server to detected clients? (enables AI tools to use Sequant)",
          default: true,
        },
      ]);
      addMcp = confirm;
    }

    if (addMcp) {
      for (const client of detectedClients) {
        const added = addSequantToMcpConfig(
          client.configPath,
          client.clientType,
        );
        if (added) {
          ui.printStatus("success", `Added Sequant MCP to ${client.name}`);
        } else {
          console.log(
            chalk.gray(`   ${client.name}: already configured (skipped)`),
          );
        }
      }
    }
  }

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
    ? `\n${chalk.yellow("!  Remember to install missing dependencies before using issue workflows.")}\n${chalk.gray("   Run 'sequant doctor' to verify your setup.\n")}`
    : "";

  // Success message with boxed output
  const nextStepsContent = `${chalk.bold("Next steps:")}
  1. Review .claude/memory/constitution.md
  2. Start using workflow commands:

     ${chalk.cyan("/spec 123")}  - Plan implementation
     ${chalk.cyan("/exec 123")}  - Implement the feature
     ${chalk.cyan("/qa 123")}    - Quality review`;

  console.log(
    "\n" + ui.successBox("Sequant initialized successfully!", nextStepsContent),
  );

  if (prereqReminder) {
    console.log(prereqReminder);
  }

  if (optionalSection) {
    console.log(optionalSection);
  }

  console.log(
    chalk.gray(
      "\nDocumentation: https://github.com/sequant-io/sequant#readme\n",
    ),
  );
}

/**
 * Upgrade installed skill files from the sequant package's templates.
 * Shows a diff preview for each changed file and asks for confirmation.
 */
async function upgradeSkills(): Promise<void> {
  console.log(chalk.bold("\nUpgrading skills from package templates...\n"));

  const installedDir = ".claude/skills";
  if (!(await fileExists(installedDir))) {
    console.log(
      chalk.red("No skills directory found. Run `sequant init` first."),
    );
    return;
  }

  // Resolve the package's templates/skills directory
  const { getTemplatesDir } = await import("../lib/templates.js");
  const templateSkillsDir = join(getTemplatesDir(), "skills");

  // Collect all files from both directories
  const changes: { path: string; installed: string; template: string }[] = [];
  const newFiles: { path: string; content: string }[] = [];

  async function compareDir(
    templateDir: string,
    installedBaseDir: string,
    relativePrefix: string,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(templateDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relPath = join(relativePrefix, entry.name);
      const templatePath = join(templateDir, entry.name);
      const installedPath = join(installedBaseDir, relPath);

      if (entry.isDirectory()) {
        await compareDir(templatePath, installedBaseDir, relPath);
      } else {
        const templateContent = await readFile(templatePath);
        const exists = await fileExists(installedPath);

        if (!exists) {
          newFiles.push({ path: relPath, content: templateContent });
        } else {
          const installedContent = await readFile(installedPath);
          if (installedContent !== templateContent) {
            changes.push({
              path: relPath,
              installed: installedContent,
              template: templateContent,
            });
          }
        }
      }
    }
  }

  await compareDir(templateSkillsDir, installedDir, "");

  if (changes.length === 0 && newFiles.length === 0) {
    console.log(chalk.green("All skills are up to date."));
    return;
  }

  // Show summary
  console.log(chalk.bold("Changes found:"));
  if (changes.length > 0) {
    console.log(chalk.yellow(`  Modified: ${changes.length} file(s)`));
  }
  if (newFiles.length > 0) {
    console.log(chalk.green(`  New: ${newFiles.length} file(s)`));
  }
  console.log();

  // Show diffs for modified files
  for (const change of changes) {
    console.log(chalk.yellow(`--- ${change.path} ---`));
    const diff = diffLines(change.installed, change.template);
    for (const part of diff) {
      if (part.added) {
        process.stdout.write(chalk.green(part.value));
      } else if (part.removed) {
        process.stdout.write(chalk.red(part.value));
      }
      // Skip unchanged lines in diff output
    }
    console.log();
  }

  // Show new files
  for (const file of newFiles) {
    console.log(chalk.green(`+++ ${file.path} (new)`));
  }

  // Ask for confirmation
  const isInteractive = shouldUseInteractiveMode();
  if (isInteractive) {
    const { proceed } = await inquirer.prompt([
      {
        type: "confirm",
        name: "proceed",
        message: `Apply ${changes.length + newFiles.length} skill update(s)?`,
        default: true,
      },
    ]);
    if (!proceed) {
      console.log(chalk.gray("Aborted."));
      return;
    }
  }

  // Apply changes
  for (const change of changes) {
    await writeFile(join(installedDir, change.path), change.template);
  }
  for (const file of newFiles) {
    await ensureDir(dirname(join(installedDir, file.path)));
    await writeFile(join(installedDir, file.path), file.content);
  }

  console.log(
    chalk.green(
      `\nUpgraded ${changes.length + newFiles.length} skill file(s).`,
    ),
  );
}
