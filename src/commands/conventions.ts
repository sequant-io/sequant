/**
 * sequant conventions - View and manage codebase conventions
 */

import chalk from "chalk";
import {
  detectAndSaveConventions,
  loadConventions,
  formatConventions,
  CONVENTIONS_PATH,
} from "../lib/conventions-detector.js";
import { fileExists, writeFile, readFile } from "../lib/fs.js";

interface ConventionsOptions {
  detect?: boolean;
  reset?: boolean;
}

export async function conventionsCommand(
  options: ConventionsOptions,
): Promise<void> {
  if (options.reset) {
    await handleReset();
    return;
  }

  if (options.detect) {
    await handleDetect();
    return;
  }

  // Default: show current conventions
  await handleShow();
}

async function handleDetect(): Promise<void> {
  console.log(chalk.blue("Detecting codebase conventions..."));
  const result = await detectAndSaveConventions(process.cwd());
  const count = Object.keys(result.detected).length;
  console.log(chalk.green(`\nDetected ${count} conventions:`));
  console.log(formatConventions(result));
  console.log(chalk.gray(`\nSaved to ${CONVENTIONS_PATH}`));
}

async function handleReset(): Promise<void> {
  const existing = await loadConventions();
  if (!existing) {
    console.log(chalk.yellow("No conventions file found. Nothing to reset."));
    return;
  }

  // Keep manual entries, clear detected
  const reset = {
    detected: {},
    manual: existing.manual,
    detectedAt: "",
  };
  await writeFile(CONVENTIONS_PATH, JSON.stringify(reset, null, 2));
  console.log(
    chalk.green("Detected conventions cleared. Manual entries preserved."),
  );
  if (Object.keys(existing.manual).length > 0) {
    console.log(chalk.gray("\nManual entries kept:"));
    for (const [key, value] of Object.entries(existing.manual)) {
      console.log(chalk.gray(`  ${key}: ${value}`));
    }
  }
}

async function handleShow(): Promise<void> {
  if (!(await fileExists(CONVENTIONS_PATH))) {
    console.log(chalk.yellow("No conventions detected yet."));
    console.log(
      chalk.gray(
        "Run 'sequant conventions --detect' or 'sequant init' to detect conventions.",
      ),
    );
    return;
  }

  const conventions = await loadConventions();
  if (!conventions) {
    console.log(chalk.yellow("Could not read conventions file."));
    return;
  }

  console.log(formatConventions(conventions));
  console.log(
    chalk.gray(`\nEdit ${CONVENTIONS_PATH} to add manual overrides.`),
  );
}
