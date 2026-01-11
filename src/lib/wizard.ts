/**
 * Setup wizard for guiding users through dependency installation
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { commandExists, isGhAuthenticated, getInstallHint } from "./system.js";
import { isCI } from "./tty.js";

/**
 * Dependency status after checking
 */
export interface DependencyStatus {
  name: string;
  displayName: string;
  installed: boolean;
  authenticated?: boolean; // For deps that require auth (like gh)
  required: boolean;
  docsUrl: string;
}

/**
 * Result of checking all dependencies
 */
export interface DependencyCheckResult {
  dependencies: DependencyStatus[];
  allRequiredMet: boolean;
  hasMissing: boolean;
}

/**
 * Check the status of all required and optional dependencies
 */
export function checkAllDependencies(): DependencyCheckResult {
  const dependencies: DependencyStatus[] = [];

  // GitHub CLI (required)
  const ghInstalled = commandExists("gh");
  const ghAuthenticated = ghInstalled ? isGhAuthenticated() : false;
  dependencies.push({
    name: "gh",
    displayName: "GitHub CLI (gh)",
    installed: ghInstalled,
    authenticated: ghAuthenticated,
    required: true,
    docsUrl: "https://cli.github.com",
  });

  // Claude Code CLI (required)
  const claudeInstalled = commandExists("claude");
  dependencies.push({
    name: "claude",
    displayName: "Claude Code CLI",
    installed: claudeInstalled,
    required: true,
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code",
  });

  // jq (optional)
  const jqInstalled = commandExists("jq");
  dependencies.push({
    name: "jq",
    displayName: "jq (JSON processor)",
    installed: jqInstalled,
    required: false,
    docsUrl: "https://jqlang.github.io/jq/",
  });

  const allRequiredMet = dependencies
    .filter((d) => d.required)
    .every((d) => {
      if (d.name === "gh") {
        return d.installed && d.authenticated;
      }
      return d.installed;
    });

  const hasMissing = dependencies.some((d) => {
    if (d.name === "gh") {
      return !d.installed || !d.authenticated;
    }
    return d.required && !d.installed;
  });

  return { dependencies, allRequiredMet, hasMissing };
}

/**
 * Display the dependency check results
 */
export function displayDependencyStatus(result: DependencyCheckResult): void {
  console.log(chalk.blue("\nChecking dependencies...\n"));

  for (const dep of result.dependencies) {
    if (dep.installed) {
      if (dep.name === "gh" && !dep.authenticated) {
        console.log(
          chalk.yellow(
            `  ${chalk.yellow("!")} ${dep.displayName} - installed but not authenticated`,
          ),
        );
      } else {
        console.log(
          chalk.green(`  ${chalk.green("✓")} ${dep.displayName} - installed`),
        );
      }
    } else {
      const marker = dep.required ? chalk.red("✗") : chalk.yellow("○");
      const status = dep.required
        ? "not installed (required)"
        : "not installed (optional)";
      console.log(`  ${marker} ${dep.displayName} - ${status}`);
    }
  }
  console.log();
}

/**
 * Get detailed install instructions for a dependency
 */
export function getInstallInstructions(depName: string): string[] {
  const instructions: string[] = [];
  const installHint = getInstallHint(depName);

  switch (depName) {
    case "gh":
      instructions.push(
        `${chalk.cyan("→")} Install: ${chalk.bold(installHint)}`,
      );
      instructions.push(
        `${chalk.cyan("→")} Or visit: ${chalk.underline("https://cli.github.com")}`,
      );
      instructions.push(
        `${chalk.cyan("→")} After install, run: ${chalk.bold("gh auth login")}`,
      );
      break;

    case "claude":
      instructions.push(
        `${chalk.cyan("→")} Install: ${chalk.bold("npm install -g @anthropic-ai/claude-code")}`,
      );
      instructions.push(
        `${chalk.cyan("→")} Or visit: ${chalk.underline("https://docs.anthropic.com/en/docs/claude-code")}`,
      );
      break;

    case "jq":
      instructions.push(
        `${chalk.cyan("→")} Install: ${chalk.bold(installHint)}`,
      );
      instructions.push(
        `${chalk.cyan("→")} Or visit: ${chalk.underline("https://jqlang.github.io/jq/")}`,
      );
      break;

    default:
      instructions.push(`${chalk.cyan("→")} Install ${depName}`);
  }

  return instructions;
}

/**
 * Result from running the setup wizard
 */
export interface WizardResult {
  skipped: boolean;
  completed: boolean;
  remainingIssues: string[];
}

/**
 * Run the interactive setup wizard for missing dependencies
 *
 * @param result - The dependency check result
 * @param options - Options for the wizard
 * @returns The wizard result
 */
export async function runSetupWizard(
  result: DependencyCheckResult,
  options: { skipPrompts?: boolean } = {},
): Promise<WizardResult> {
  const missingDeps = result.dependencies.filter((d) => {
    if (d.name === "gh") {
      return !d.installed || !d.authenticated;
    }
    return d.required && !d.installed;
  });

  if (missingDeps.length === 0) {
    return { skipped: false, completed: true, remainingIssues: [] };
  }

  // In non-interactive mode, just return the issues
  if (options.skipPrompts) {
    return {
      skipped: true,
      completed: false,
      remainingIssues: missingDeps.map((d) => {
        if (d.name === "gh" && d.installed && !d.authenticated) {
          return `${d.displayName} not authenticated`;
        }
        return `${d.displayName} not installed`;
      }),
    };
  }

  // Ask if user wants to set up missing dependencies
  let setupDeps = false;
  try {
    const response = await inquirer.prompt([
      {
        type: "confirm",
        name: "setupDeps",
        message: "Would you like to set up missing dependencies?",
        default: true,
      },
    ]);
    setupDeps = response.setupDeps;
  } catch {
    // If prompt fails (e.g., non-interactive), skip wizard
    return {
      skipped: true,
      completed: false,
      remainingIssues: missingDeps.map((d) => {
        if (d.name === "gh" && d.installed && !d.authenticated) {
          return `${d.displayName} not authenticated`;
        }
        return `${d.displayName} not installed`;
      }),
    };
  }

  if (!setupDeps) {
    return {
      skipped: true,
      completed: false,
      remainingIssues: missingDeps.map((d) => {
        if (d.name === "gh" && d.installed && !d.authenticated) {
          return `${d.displayName} not authenticated`;
        }
        return `${d.displayName} not installed`;
      }),
    };
  }

  // Guide through each missing dependency
  const remainingIssues: string[] = [];

  for (const dep of missingDeps) {
    console.log(chalk.bold(`\nSetting up ${dep.displayName}...\n`));

    const instructions = getInstallInstructions(dep.name);
    for (const instruction of instructions) {
      console.log(`  ${instruction}`);
    }
    console.log();

    let action = "skip";
    try {
      const response = await inquirer.prompt([
        {
          type: "list",
          name: "action",
          message: "What would you like to do?",
          choices: [
            { name: "I've installed it - verify now", value: "verify" },
            { name: "Skip for now", value: "skip" },
          ],
        },
      ]);
      action = response.action;
    } catch {
      // If prompt fails, skip this dependency
      action = "skip";
    }

    if (action === "verify") {
      // Re-check this dependency
      const isNowInstalled = commandExists(dep.name);
      const isNowAuthenticated =
        dep.name === "gh"
          ? isNowInstalled
            ? isGhAuthenticated()
            : false
          : true;

      if (isNowInstalled && isNowAuthenticated) {
        console.log(
          chalk.green(`\n  ✓ ${dep.displayName} - now installed and ready!\n`),
        );
      } else if (dep.name === "gh" && isNowInstalled && !isNowAuthenticated) {
        console.log(
          chalk.yellow(
            `\n  ! ${dep.displayName} - installed but not authenticated yet\n`,
          ),
        );
        remainingIssues.push(`${dep.displayName} not authenticated`);
      } else {
        console.log(
          chalk.yellow(`\n  ! ${dep.displayName} - not detected yet\n`),
        );
        remainingIssues.push(`${dep.displayName} not installed`);
      }
    } else {
      if (dep.name === "gh" && dep.installed && !dep.authenticated) {
        remainingIssues.push(`${dep.displayName} not authenticated`);
      } else {
        remainingIssues.push(`${dep.displayName} not installed`);
      }
    }
  }

  return {
    skipped: false,
    completed: remainingIssues.length === 0,
    remainingIssues,
  };
}

/**
 * Determine if the setup wizard should be run
 *
 * @param options - Options from the init command
 * @returns true if wizard should run
 */
export function shouldRunSetupWizard(options: {
  skipSetup?: boolean;
  yes?: boolean;
  interactive?: boolean;
}): boolean {
  // Skip if --skip-setup flag is set
  if (options.skipSetup) {
    return false;
  }

  // Skip in CI environments
  if (isCI()) {
    return false;
  }

  return true;
}
