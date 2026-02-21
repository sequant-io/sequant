#!/usr/bin/env npx tsx
/**
 * CLI for Test Tautology Detector
 *
 * Reads test files from git diff and outputs tautology detection results.
 *
 * Usage:
 *   npx tsx scripts/qa/tautology-detector-cli.ts [options]
 *
 * Options:
 *   --json     Output results as JSON
 *   --verbose  Include file details in output
 *
 * Exit codes:
 *   0 - Success (no blocking issues)
 *   1 - Blocking: >50% tautological tests
 *   2 - Error running detector
 */

import * as fs from "fs";
import { execSync } from "child_process";
import {
  detectTautologicalTests,
  formatTautologyResults,
  getTautologyVerdictImpact,
} from "../../src/lib/test-tautology-detector.js";

interface CliArgs {
  json: boolean;
  verbose: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  return {
    json: args.includes("--json"),
    verbose: args.includes("--verbose"),
  };
}

function getChangedTestFiles(): string[] {
  try {
    const output = execSync("git diff main...HEAD --name-only", {
      encoding: "utf-8",
    });
    return output
      .trim()
      .split("\n")
      .filter((f) => f && /\.(test|spec)\.[jt]sx?$/.test(f));
  } catch {
    console.error("Error: Failed to get changed files from git");
    return [];
  }
}

function readFileContent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function main(): void {
  const args = parseArgs();
  const testFiles = getChangedTestFiles();

  if (testFiles.length === 0) {
    if (args.json) {
      console.log(
        JSON.stringify({
          status: "skip",
          message: "No test files in diff",
          summary: { totalFiles: 0, totalTests: 0, totalTautological: 0 },
        }),
      );
    } else {
      console.log("No test files changed in diff");
    }
    process.exit(0);
  }

  // Read file contents
  const files: Array<{ path: string; content: string }> = [];
  for (const filePath of testFiles) {
    const content = readFileContent(filePath);
    if (content !== null) {
      files.push({ path: filePath, content });
    } else if (args.verbose) {
      console.error(`Warning: Could not read ${filePath}`);
    }
  }

  // Run detection
  const results = detectTautologicalTests(files);
  const verdictImpact = getTautologyVerdictImpact(results);

  if (args.json) {
    console.log(
      JSON.stringify({
        status: verdictImpact,
        summary: results.summary,
        files: results.fileResults.map((f) => ({
          path: f.filePath,
          totalTests: f.totalTests,
          tautologicalCount: f.tautologicalCount,
          tautologicalTests: f.testBlocks
            .filter((b) => b.isTautological)
            .map((b) => ({
              line: b.lineNumber,
              description: b.description,
              style: b.style,
            })),
        })),
      }),
    );
  } else {
    console.log(formatTautologyResults(results));
  }

  // Exit with appropriate code
  if (verdictImpact === "blocking") {
    process.exit(1);
  }
  process.exit(0);
}

main();
