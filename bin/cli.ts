#!/usr/bin/env node
/**
 * Sequant CLI - Quantize your development workflow
 *
 * Sequential AI phases with quality gates for any codebase.
 */

import { Command } from "commander";
import chalk from "chalk";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";
import { initCommand } from "../src/commands/init.js";
import { isLocalNodeModulesInstall } from "../src/lib/version-check.js";
import { configureUI, banner } from "../src/lib/cli-ui.js";
import { isCI, isStdoutTTY } from "../src/lib/tty.js";

// Read version from package.json dynamically
// Works from both source (bin/) and compiled (dist/bin/) locations
function getVersion(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  let dir = __dirname;
  while (dir !== dirname(dir)) {
    const candidate = resolve(dir, "package.json");
    try {
      const content = readFileSync(candidate, "utf-8");
      const pkg = JSON.parse(content);
      if (pkg.name === "sequant") {
        return pkg.version;
      }
    } catch {
      // Not found, continue searching
    }
    dir = dirname(dir);
  }
  return "0.0.0"; // Fallback
}
const version = getVersion();
import { updateCommand } from "../src/commands/update.js";
import { doctorCommand } from "../src/commands/doctor.js";
import { statusCommand } from "../src/commands/status.js";
import { runCommand } from "../src/commands/run.js";
import { logsCommand } from "../src/commands/logs.js";
import { statsCommand } from "../src/commands/stats.js";
import { dashboardCommand } from "../src/commands/dashboard.js";
import {
  stateInitCommand,
  stateRebuildCommand,
  stateCleanCommand,
} from "../src/commands/state.js";

const program = new Command();

// Handle --no-color before parsing
if (process.argv.includes("--no-color")) {
  process.env.FORCE_COLOR = "0";
}

// Configure UI early based on environment and flags
configureUI({
  noColor: process.argv.includes("--no-color") || !!process.env.NO_COLOR,
  jsonMode: process.argv.includes("--json"),
  verbose: process.argv.includes("--verbose") || process.argv.includes("-v"),
  isTTY: isStdoutTTY(),
  isCI: isCI(),
  minimal: process.env.SEQUANT_MINIMAL === "1",
});

// Warn if running from local node_modules (not npx cache or global)
// This helps users who accidentally have a stale local install
if (!process.argv.includes("--quiet") && isLocalNodeModulesInstall()) {
  console.warn(
    chalk.yellow(
      "⚠️  Running sequant from local node_modules\n" +
        "   For latest version: npx sequant@latest\n" +
        "   To remove local: npm uninstall sequant\n",
    ),
  );
}

program
  .name("sequant")
  .description(
    "Quantize your development workflow - Sequential AI phases with quality gates",
  )
  .version(version)
  .option("--no-color", "Disable colored output");

program
  .command("init")
  .description("Initialize Sequant in your project")
  .option("-s, --stack <stack>", "Specify stack (nextjs, rust, python, go)")
  .option("-y, --yes", "Skip confirmation prompts")
  .option("-f, --force", "Overwrite existing configuration")
  .option(
    "-i, --interactive",
    "Force interactive mode even in non-TTY environment",
  )
  .option("--skip-setup", "Skip the dependency setup wizard")
  .option(
    "--no-symlinks",
    "Use copies instead of symlinks for scripts/dev/ files",
  )
  .action(initCommand);

program
  .command("update")
  .description("Update templates from the Sequant package")
  .option("-d, --dry-run", "Show what would be updated without making changes")
  .option("-f, --force", "Overwrite local modifications")
  .action(updateCommand);

program
  .command("doctor")
  .description("Check your Sequant installation for issues")
  .option("--skip-issue-check", "Skip closed-issue verification check")
  .action(doctorCommand);

program
  .command("status")
  .description("Show Sequant version, configuration, and workflow state")
  .argument("[issue]", "Issue number to show details for", parseInt)
  .option("--issues", "Show all tracked issues")
  .option("--json", "Output as JSON")
  .option("--rebuild", "Rebuild state from run logs")
  .option("--cleanup", "Clean up stale/orphaned entries")
  .option("--dry-run", "Preview cleanup without changes")
  .option("--max-age <days>", "Remove entries older than N days", parseInt)
  .option("--all", "Remove all orphaned entries (merged and abandoned)")
  .action((issue, options) => {
    // Support positional arg: `sequant status 42` → --issue 42
    if (issue) {
      options.issue = issue;
    }
    return statusCommand(options);
  });

program
  .command("run")
  .description("Execute workflow for GitHub issues using Claude Agent SDK")
  .argument("[issues...]", "Issue numbers to process")
  .option("--phases <list>", "Phases to run (default: spec,exec,qa)")
  .option("--sequential", "Run issues sequentially")
  .option("-d, --dry-run", "Preview without execution")
  .option("-v, --verbose", "Verbose output with streaming")
  .option("--timeout <seconds>", "Timeout per phase in seconds", parseInt)
  .option("--log-json", "Enable structured JSON logging (default: true)")
  .option("--no-log", "Disable JSON logging for this run")
  .option("--log-path <path>", "Custom log directory path")
  .option("-q, --quality-loop", "Enable quality loop with auto-retry")
  .option(
    "--max-iterations <n>",
    "Max iterations for quality loop (default: 3)",
    parseInt,
  )
  .option(
    "--batch <issues>",
    'Group of issues to run together (e.g., --batch "1 2" --batch "3")',
    (value: string, prev: string[]) => prev.concat([value]),
    [],
  )
  .option("--smart-tests", "Enable smart test detection (default)")
  .option("--no-smart-tests", "Disable smart test detection")
  .option("--testgen", "Run testgen phase after spec")
  .option("--quiet", "Suppress version warnings and non-essential output")
  .option(
    "--chain",
    "Chain issues: each branches from previous (requires --sequential)",
  )
  .option(
    "--qa-gate",
    "Wait for QA pass before starting next issue in chain (requires --chain)",
  )
  .option(
    "--base <branch>",
    "Base branch for worktree creation (default: main or settings.run.defaultBase)",
  )
  .option("--no-mcp", "Disable MCP server injection in headless mode")
  .action(runCommand);

program
  .command("logs")
  .description("View and analyze workflow run logs")
  .option("-p, --path <path>", "Custom log directory path")
  .option("-n, --last <n>", "Show last N runs", parseInt)
  .option("--json", "Output as JSON")
  .option("-i, --issue <number>", "Filter by issue number", parseInt)
  .option("--failed", "Show only failed runs")
  .option("--rotate", "Rotate logs (delete oldest to meet thresholds)")
  .option("-d, --dry-run", "Show what would be rotated without deleting")
  .action(logsCommand);

program
  .command("stats")
  .description("Show aggregate statistics for workflow runs")
  .option("-p, --path <path>", "Custom log directory path")
  .option("--csv", "Output as CSV")
  .option("--json", "Output as JSON")
  .action(statsCommand);

program
  .command("dashboard")
  .description("Start visual workflow dashboard in browser")
  .option("-p, --port <port>", "Port to run server on", parseInt)
  .option("--no-open", "Don't automatically open browser")
  .option("-v, --verbose", "Enable verbose logging")
  .action(dashboardCommand);

// State management command with subcommands
const stateCmd = program
  .command("state")
  .description("Manage workflow state for worktrees");

stateCmd
  .command("init")
  .description("Populate state for untracked worktrees")
  .option("--json", "Output as JSON")
  .option("-v, --verbose", "Enable verbose output")
  .action(stateInitCommand);

stateCmd
  .command("rebuild")
  .description("Recreate state from logs and worktrees")
  .option("--json", "Output as JSON")
  .option("-v, --verbose", "Enable verbose output")
  .option("-f, --force", "Force rebuild without confirmation")
  .action(stateRebuildCommand);

stateCmd
  .command("clean")
  .description("Remove entries for deleted worktrees")
  .option("--json", "Output as JSON")
  .option("-v, --verbose", "Enable verbose output")
  .option("-d, --dry-run", "Preview cleanup without changes")
  .option("--max-age <days>", "Remove entries older than N days", parseInt)
  .option("--all", "Remove all orphaned entries (merged and abandoned)")
  .action(stateCleanCommand);

// Parse and execute
program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
  console.log(banner());
  program.help();
}
