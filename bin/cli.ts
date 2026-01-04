#!/usr/bin/env node
/**
 * Sequant CLI - Quantize your development workflow
 *
 * Sequential AI phases with quality gates for any codebase.
 */

import { Command } from "commander";
import chalk from "chalk";
import { initCommand } from "../src/commands/init.js";
import { updateCommand } from "../src/commands/update.js";
import { doctorCommand } from "../src/commands/doctor.js";
import { statusCommand } from "../src/commands/status.js";

const program = new Command();

program
  .name("sequant")
  .description(
    "Quantize your development workflow - Sequential AI phases with quality gates",
  )
  .version("0.1.0");

program
  .command("init")
  .description("Initialize Sequant in your project")
  .option("-s, --stack <stack>", "Specify stack (nextjs, rust, python, go)")
  .option("-y, --yes", "Skip confirmation prompts")
  .option("-f, --force", "Overwrite existing configuration")
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
  .option("--fix", "Attempt to fix issues automatically")
  .action(doctorCommand);

program
  .command("status")
  .description("Show Sequant version and configuration status")
  .action(statusCommand);

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
