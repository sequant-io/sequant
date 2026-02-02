#!/usr/bin/env npx tsx
/**
 * QA Cache CLI - Command-line interface for QA caching operations
 *
 * Used by quality-checks.sh to check/update cache before running expensive checks.
 *
 * Usage:
 *   npx tsx scripts/qa/qa-cache-cli.ts check <check-type>   # Check if cached result exists
 *   npx tsx scripts/qa/qa-cache-cli.ts get <check-type>     # Get cached result (JSON)
 *   npx tsx scripts/qa/qa-cache-cli.ts set <check-type>     # Set result (reads JSON from stdin)
 *   npx tsx scripts/qa/qa-cache-cli.ts clear [check-type]   # Clear cache (specific or all)
 *   npx tsx scripts/qa/qa-cache-cli.ts status               # Get status for all checks
 *   npx tsx scripts/qa/qa-cache-cli.ts hash                 # Get current diff hash
 *
 * Exit codes:
 *   0 - Success / Cache hit
 *   1 - Cache miss or error
 *   2 - Invalid arguments
 */

import {
  QACache,
  CHECK_TYPES,
  type CheckType,
  type CachedCheckResult,
} from "../../src/lib/workflow/qa-cache.js";

const cache = new QACache({
  verbose: process.env.DEBUG === "1",
});

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    printUsage();
    process.exit(2);
  }

  switch (command) {
    case "check":
      await handleCheck(args[1]);
      break;
    case "get":
      await handleGet(args[1]);
      break;
    case "set":
      await handleSet(args[1]);
      break;
    case "clear":
      await handleClear(args[1]);
      break;
    case "status":
      await handleStatus();
      break;
    case "hash":
      handleHash();
      break;
    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(2);
  }
}

function printUsage(): void {
  console.log(`
QA Cache CLI - Manage QA check caching

USAGE:
  npx tsx scripts/qa/qa-cache-cli.ts <command> [options]

COMMANDS:
  check <type>    Check if valid cached result exists (exit 0 = hit, 1 = miss)
  get <type>      Get cached result as JSON (exit 1 if not found)
  set <type>      Set cached result (reads JSON from stdin)
  clear [type]    Clear cache (specific check or all if no type given)
  status          Show cache status for all check types
  hash            Show current diff hash

CHECK TYPES:
  ${CHECK_TYPES.join(", ")}

ENVIRONMENT:
  DEBUG=1         Enable verbose logging

EXAMPLES:
  # Check if type-safety has valid cache
  npx tsx scripts/qa/qa-cache-cli.ts check type-safety && echo "cached"

  # Get cached result
  npx tsx scripts/qa/qa-cache-cli.ts get security

  # Set cache result
  echo '{"passed":true,"message":"OK"}' | npx tsx scripts/qa/qa-cache-cli.ts set build

  # Clear all cache (--no-cache equivalent)
  npx tsx scripts/qa/qa-cache-cli.ts clear
  `);
}

function validateCheckType(type: string | undefined): CheckType {
  if (!type) {
    console.error("Error: check type required");
    console.error(`Valid types: ${CHECK_TYPES.join(", ")}`);
    process.exit(2);
  }

  if (!CHECK_TYPES.includes(type as CheckType)) {
    console.error(`Error: invalid check type "${type}"`);
    console.error(`Valid types: ${CHECK_TYPES.join(", ")}`);
    process.exit(2);
  }

  return type as CheckType;
}

async function handleCheck(type: string | undefined): Promise<void> {
  const checkType = validateCheckType(type);
  const result = await cache.get(checkType);

  if (result.hit) {
    console.log("HIT");
    process.exit(0);
  } else {
    console.log(`MISS:${result.missReason}`);
    process.exit(1);
  }
}

async function handleGet(type: string | undefined): Promise<void> {
  const checkType = validateCheckType(type);
  const result = await cache.get(checkType);

  if (result.hit && result.result) {
    console.log(JSON.stringify(result.result, null, 2));
    process.exit(0);
  } else {
    console.error(`No cached result for ${checkType}`);
    process.exit(1);
  }
}

async function handleSet(type: string | undefined): Promise<void> {
  const checkType = validateCheckType(type);

  // Read JSON from stdin
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  if (!input.trim()) {
    console.error("Error: no input provided (expected JSON on stdin)");
    process.exit(2);
  }

  let result: CachedCheckResult["result"];
  try {
    result = JSON.parse(input);
  } catch (error) {
    console.error("Error: invalid JSON input");
    process.exit(2);
  }

  // Validate result structure
  if (
    typeof result.passed !== "boolean" ||
    typeof result.message !== "string"
  ) {
    console.error(
      "Error: result must have 'passed' (boolean) and 'message' (string)",
    );
    process.exit(2);
  }

  await cache.set(checkType, result);
  console.log(`Cached ${checkType} result`);
}

async function handleClear(type: string | undefined): Promise<void> {
  if (type) {
    const checkType = validateCheckType(type);
    await cache.clear(checkType);
    console.log(`Cleared cache for ${checkType}`);
  } else {
    await cache.clearAll();
    console.log("Cleared all cache");
  }
}

async function handleStatus(): Promise<void> {
  const status = await cache.getStatus();

  console.log("\n### Cache Status\n");
  console.log("| Check Type | Status | Reason |");
  console.log("|------------|--------|--------|");

  for (const checkType of CHECK_TYPES) {
    const s = status[checkType];
    const statusIcon = s.hit ? "✅ HIT" : "❌ MISS";
    const reason = s.missReason ?? "-";
    console.log(`| ${checkType} | ${statusIcon} | ${reason} |`);
  }
  console.log();
}

function handleHash(): void {
  const hash = cache.computeDiffHash();
  console.log(hash);
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
