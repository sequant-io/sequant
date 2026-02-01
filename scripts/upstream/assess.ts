#!/usr/bin/env npx tsx
/**
 * CLI script for running upstream assessments
 * Usage:
 *   npx tsx scripts/upstream/assess.ts                    # Assess latest
 *   npx tsx scripts/upstream/assess.ts v2.1.29           # Assess specific version
 *   npx tsx scripts/upstream/assess.ts --since v2.1.25   # Assess since version
 *   npx tsx scripts/upstream/assess.ts --dry-run         # Dry run mode
 *   npx tsx scripts/upstream/assess.ts --help            # Show help
 */

import {
  runUpstream,
  validateVersion,
  checkGhCliAvailable,
} from "../../src/lib/upstream/index.js";
import type { AssessmentOptions } from "../../src/lib/upstream/types.js";

function showHelp(): void {
  console.log(`
Upstream Assessment CLI

Usage:
  npx tsx scripts/upstream/assess.ts [options] [version]

Options:
  --since <version>   Assess all versions since the specified version
  --dry-run          Generate report but don't create issues
  --force            Re-assess even if already assessed
  --help             Show this help message

Examples:
  npx tsx scripts/upstream/assess.ts                    # Assess latest release
  npx tsx scripts/upstream/assess.ts v2.1.29           # Assess specific version
  npx tsx scripts/upstream/assess.ts --since v2.1.25   # Assess all since v2.1.25
  npx tsx scripts/upstream/assess.ts --dry-run         # Preview without creating issues
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse arguments
  const options: AssessmentOptions = {};
  let positionalVersion: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      showHelp();
      process.exit(0);
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg === "--since") {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith("-")) {
        console.error("Error: --since requires a version argument");
        process.exit(1);
      }
      options.since = nextArg;
      i++; // Skip next arg
      continue;
    }

    // Positional argument (version)
    if (!arg.startsWith("-")) {
      positionalVersion = arg;
    }
  }

  // Set version from positional arg if provided
  if (positionalVersion) {
    options.version = positionalVersion;
  }

  // Validate version inputs early to provide clear error messages
  try {
    if (options.version) {
      validateVersion(options.version);
    }
    if (options.since) {
      validateVersion(options.since);
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : "Invalid version format"}`,
    );
    console.error(
      "Version must be in semver format (e.g., v1.2.3 or 1.2.3-beta.1)",
    );
    process.exit(1);
  }

  // Check gh CLI availability
  const ghStatus = await checkGhCliAvailable();
  if (!ghStatus.available || !ghStatus.authenticated) {
    console.error(`Error: ${ghStatus.error}`);
    process.exit(1);
  }

  // Run assessment
  console.log("Starting upstream assessment...");
  console.log(`Options: ${JSON.stringify(options)}`);

  try {
    const result = await runUpstream(options);

    if (!result) {
      console.log(
        "No assessment performed (already assessed or no releases found)",
      );
      process.exit(0);
    }

    // Print summary
    if ("assessments" in result) {
      // BatchedAssessment
      console.log("\n=== Batched Assessment Complete ===");
      console.log(`Versions assessed: ${result.versions.length}`);
      console.log(`From: ${result.sinceVersion} → ${result.toVersion}`);
      if (result.summaryIssueNumber) {
        console.log(`Summary issue: #${result.summaryIssueNumber}`);
      }
    } else {
      // Single UpstreamAssessment
      console.log("\n=== Assessment Complete ===");
      console.log(`Version: ${result.version}`);
      console.log(`Breaking changes: ${result.summary.breakingChanges}`);
      console.log(`Deprecations: ${result.summary.deprecations}`);
      console.log(`New tools: ${result.summary.newTools}`);
      console.log(`Hook changes: ${result.summary.hookChanges}`);
      console.log(`Opportunities: ${result.summary.opportunities}`);
      console.log(`No action: ${result.summary.noAction}`);
      if (result.issuesCreated.length > 0) {
        console.log(
          `Issues created: ${result.issuesCreated.map((n) => `#${n}`).join(", ")}`,
        );
      }
    }

    console.log("\nDone!");
  } catch (error) {
    console.error("Assessment failed:", error);
    process.exit(1);
  }
}

main();
