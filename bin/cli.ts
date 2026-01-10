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

const program = new Command();

// Handle --no-color before parsing
if (process.argv.includes("--no-color")) {
  process.env.FORCE_COLOR = "0";
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
  .action(doctorCommand);

program
  .command("status")
  .description("Show Sequant version and configuration status")
  .action(statusCommand);

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

// Parse and execute
program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
  console.log(
    chalk.green(`
  ╔═══════════════════════════════════════════════════════════╗
  ║                                                           ║
  ║   ${chalk.bold("Sequant")} - Quantize your development workflow          ║
  ║                                                           ║
  ║   Sequential AI phases with quality gates                 ║
  ║                                                           ║
  ╚═══════════════════════════════════════════════════════════╝
  `),
  );
  program.help();
}
