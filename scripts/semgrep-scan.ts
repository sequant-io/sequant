#!/usr/bin/env npx tsx
/**
 * Semgrep Scan Runner
 *
 * Runs Semgrep static analysis with stack-aware rulesets.
 * Integrates with the /qa skill workflow.
 *
 * Usage:
 *   npx tsx scripts/semgrep-scan.ts [options] [files...]
 *
 * Options:
 *   --stack <name>    Override detected stack (nextjs, python, go, etc.)
 *   --json            Output raw JSON format
 *   --changed-only    Only scan files changed from main branch
 *   --help            Show this help message
 *
 * Examples:
 *   npx tsx scripts/semgrep-scan.ts
 *   npx tsx scripts/semgrep-scan.ts --changed-only
 *   npx tsx scripts/semgrep-scan.ts --stack python src/
 *   npx tsx scripts/semgrep-scan.ts src/api/ src/lib/
 */

import { execSync } from "child_process";

import {
  checkSemgrepAvailability,
  formatFindingsForDisplay,
  getCustomRulesPath,
  getRulesForStack,
  getSemgrepVerdictContribution,
  hasCustomRules,
  runSemgrepScan,
} from "../src/lib/semgrep.js";
import { detectStack } from "../src/lib/stacks.js";

interface CliOptions {
  stack?: string;
  json: boolean;
  changedOnly: boolean;
  help: boolean;
  targets: string[];
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    changedOnly: false,
    help: false,
    targets: [],
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--stack" && i + 1 < args.length) {
      options.stack = args[i + 1];
      i += 2;
    } else if (arg === "--json") {
      options.json = true;
      i++;
    } else if (arg === "--changed-only") {
      options.changedOnly = true;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
      i++;
    } else if (!arg.startsWith("-")) {
      options.targets.push(arg);
      i++;
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  return options;
}

function showHelp(): void {
  console.log(`
Semgrep Scan Runner - Static analysis with stack-aware rulesets

Usage:
  npx tsx scripts/semgrep-scan.ts [options] [files...]

Options:
  --stack <name>    Override detected stack (nextjs, python, go, rust, etc.)
  --json            Output raw JSON format
  --changed-only    Only scan files changed from main branch
  --help, -h        Show this help message

Supported Stacks:
  nextjs, astro, sveltekit, remix, nuxt, rust, python, go, generic

Custom Rules:
  Place custom Semgrep rules in .sequant/semgrep-rules.yaml
  They will be automatically loaded alongside stack rules.

Examples:
  # Scan entire project with auto-detected stack
  npx tsx scripts/semgrep-scan.ts

  # Scan only changed files
  npx tsx scripts/semgrep-scan.ts --changed-only

  # Scan specific directories with explicit stack
  npx tsx scripts/semgrep-scan.ts --stack python src/api/

  # Get JSON output for programmatic use
  npx tsx scripts/semgrep-scan.ts --json > results.json
`);
}

function getChangedFiles(): string[] {
  try {
    const output = execSync("git diff main...HEAD --name-only", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output
      .split("\n")
      .filter((f) => f.trim())
      .filter(
        (f) =>
          f.endsWith(".ts") ||
          f.endsWith(".tsx") ||
          f.endsWith(".js") ||
          f.endsWith(".jsx") ||
          f.endsWith(".py") ||
          f.endsWith(".go") ||
          f.endsWith(".rs"),
      );
  } catch {
    console.error("Warning: Could not get changed files from git");
    return [];
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  // Check Semgrep availability first
  console.log("🔍 Checking Semgrep availability...");
  const availability = await checkSemgrepAvailability();

  if (!availability.available) {
    console.log("⚠️  Semgrep not installed");
    console.log("");
    console.log("To install Semgrep:");
    console.log("  pip install semgrep");
    console.log("  # or");
    console.log("  brew install semgrep");
    console.log("");
    console.log("Semgrep scan skipped (graceful degradation)");

    if (options.json) {
      console.log(
        JSON.stringify({
          success: true,
          skipped: true,
          skipReason: "Semgrep not installed",
          findings: [],
          criticalCount: 0,
          warningCount: 0,
          infoCount: 0,
        }),
      );
    }
    process.exit(0);
  }

  const useNpxNote = availability.useNpx ? " (via npx)" : "";
  console.log(`✅ Semgrep available${useNpxNote}`);
  console.log("");

  // Detect or use specified stack
  const stack = options.stack || (await detectStack());
  const ruleset = getRulesForStack(stack);
  console.log(`📚 Stack: ${ruleset.name}`);
  console.log(`   Rules: ${ruleset.rules.join(", ")}`);

  // Check for custom rules
  if (hasCustomRules()) {
    const customPath = getCustomRulesPath();
    console.log(`   Custom rules: ${customPath}`);
  }
  console.log("");

  // Determine targets
  let targets = options.targets;
  if (targets.length === 0) {
    if (options.changedOnly) {
      targets = getChangedFiles();
      if (targets.length === 0) {
        console.log("No changed files to scan");
        if (options.json) {
          console.log(
            JSON.stringify({
              success: true,
              findings: [],
              criticalCount: 0,
              warningCount: 0,
              infoCount: 0,
            }),
          );
        }
        process.exit(0);
      }
      console.log(`Scanning ${targets.length} changed file(s)...`);
    } else {
      // Default to current directory
      targets = ["."];
      console.log("Scanning entire project...");
    }
  } else {
    console.log(`Scanning: ${targets.join(", ")}...`);
  }
  console.log("");

  // Run the scan
  const result = await runSemgrepScan({
    targets,
    stack,
    useCustomRules: true,
  });

  // Output results
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("## Static Analysis (Semgrep)");
    console.log("");

    if (result.skipped) {
      console.log(`⚠️  Skipped: ${result.skipReason}`);
    } else if (!result.success) {
      console.log(`❌ Error: ${result.error}`);
    } else {
      // Summary line
      if (result.criticalCount === 0 && result.warningCount === 0) {
        console.log("✅ No security issues found");
      } else {
        if (result.criticalCount > 0) {
          console.log(`❌ ${result.criticalCount} critical finding(s)`);
        }
        if (result.warningCount > 0) {
          console.log(`⚠️  ${result.warningCount} warning(s)`);
        }
        if (result.infoCount > 0) {
          console.log(`ℹ️  ${result.infoCount} info finding(s)`);
        }
      }

      // Detailed findings
      if (result.findings.length > 0) {
        console.log("");
        console.log(formatFindingsForDisplay(result.findings));
      }

      // Verdict contribution
      console.log("");
      const verdict = getSemgrepVerdictContribution(result);
      if (verdict.blocking) {
        console.log(`🚫 Verdict: BLOCKING - ${verdict.reason}`);
      } else {
        console.log(`✅ Verdict: ${verdict.reason}`);
      }
    }
  }

  // Exit with appropriate code
  if (result.criticalCount > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
