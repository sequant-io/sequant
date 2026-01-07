#!/usr/bin/env npx tsx
/**
 * execute-issues.ts - TypeScript Claude Code Workflow Automation
 *
 * Executes /spec → /exec → /test → /qa workflow for GitHub issues.
 * TypeScript port of scripts/execute-issues.sh with added features.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/dev/execute-issues.ts 123        # Single issue
 *   npx tsx --env-file=.env.local scripts/dev/execute-issues.ts 123 124 125 # Multiple parallel
 *   PHASES=exec,qa npx tsx --env-file=.env.local scripts/dev/execute-issues.ts 123  # Custom phases
 *   PHASES=spec,testgen,exec,qa npx tsx --env-file=.env.local scripts/dev/execute-issues.ts 123  # With test generation
 *   npx tsx --env-file=.env.local scripts/dev/execute-issues.ts --batch "123 124" --batch "125 126"
 *   npx tsx --env-file=.env.local scripts/dev/execute-issues.ts --sequential 123 124 125  # Respect dependencies
 *   QUALITY_LOOP=true npx tsx --env-file=.env.local scripts/dev/execute-issues.ts 123     # Auto-iterate
 *   npx tsx scripts/dev/execute-issues.ts --test            # Run quick validation tests
 *   npx tsx scripts/dev/execute-issues.ts --cleanup-orphans # Clean stale runs
 *
 * Important:
 *   Use --env-file=.env.local to enable database logging to workflow_runs table.
 *   Without this flag, workflow runs will not be recorded (warning shown at startup).
 *
 * Environment Variables:
 *   PHASES           - Comma-separated phases (default: spec,exec,qa)
 *                      Available: spec, testgen, exec, test, qa, loop
 *                      Note: testgen requires /spec to have run first with verification criteria
 *   PHASE_TIMEOUT    - Timeout in seconds per phase (default: 1800)
 *   QUALITY_LOOP     - Enable auto-iteration (default: false). Auto-includes testgen phase.
 *   MAX_ITERATIONS   - Max fix iterations per phase (default: 3)
 *   SKIP_VERIFICATION - Skip /exec verification (default: false)
 *
 * Features:
 *   - Auto-detect UI issues for /test inclusion
 *   - Optional /testgen phase for shift-left testing (requires /spec comment)
 *   - Dependency detection and sequential execution (#355)
 *   - Quality loop mode with /loop iterations
 *   - Post-exec verification to catch hallucinated implementations
 *   - Structured logging to workflow_runs table
 *   - Crash cleanup for orphaned runs
 */

import { createLogger, Logger } from "../lib/logger";
import { isHelpRequested, printUsage } from "../lib/cli-args";
import type {
  Phase,
  ExecutionConfig,
  ExecuteIssuesArgs,
  IssueBatch,
  IssueResult,
  BatchResult,
} from "./lib/types";
import { DEFAULT_CONFIG } from "./lib/types";
import { runIssue, formatDuration } from "./lib/issue-executor";
import {
  cleanupOrphanedRuns,
  markAllActiveRunsFailed,
  canLogToSupabase,
} from "./lib/workflow-tracker";
import {
  buildDependencyGraph,
  hasInterdependencies,
  formatDependencyGraph,
} from "./lib/dependency-detector";
import { runWithListr, isTTY } from "./lib/task-renderer";

// =====================================================
// CLI PARSING
// =====================================================

/**
 * Parse CLI arguments
 */
function parseExecuteIssuesArgs(argv: string[]): ExecuteIssuesArgs {
  const args: ExecuteIssuesArgs = {
    issues: [],
    batches: [],
    test: false,
    help: false,
    sequential: false,
    forceParallel: false,
    qualityLoop: process.env.QUALITY_LOOP === "true",
    skipVerification: process.env.SKIP_VERIFICATION === "true",
    verbose: false,
    noSmartTests: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
      i++;
      continue;
    }

    if (arg === "--test") {
      args.test = true;
      i++;
      continue;
    }

    if (arg === "--cleanup-orphans") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-") && /^\d+$/.test(next)) {
        args.cleanupOrphans = parseInt(next, 10);
        i += 2;
      } else {
        args.cleanupOrphans = true;
        i++;
      }
      continue;
    }

    if (arg === "--batch") {
      const next = argv[i + 1];
      if (!next) {
        console.error("Error: --batch requires an argument");
        process.exit(1);
      }
      const issues = next
        .split(/\s+/)
        .map((n) => parseInt(n, 10))
        .filter((n) => !isNaN(n));
      args.batches.push({
        batchNumber: args.batches.length + 1,
        issues,
      });
      i += 2;
      continue;
    }

    if (arg === "--sequential") {
      args.sequential = true;
      i++;
      continue;
    }

    if (arg === "--force-parallel") {
      args.forceParallel = true;
      i++;
      continue;
    }

    if (arg === "--phases") {
      const next = argv[i + 1];
      if (next) {
        args.phases = next.split(",").map((p) => p.trim() as Phase);
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (arg === "--timeout") {
      const next = argv[i + 1];
      if (next && /^\d+$/.test(next)) {
        args.timeout = parseInt(next, 10);
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (arg === "--max-iterations") {
      const next = argv[i + 1];
      if (next && /^\d+$/.test(next)) {
        args.maxIterations = parseInt(next, 10);
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (arg === "--quality-loop") {
      args.qualityLoop = true;
      i++;
      continue;
    }

    if (arg === "--skip-verification") {
      args.skipVerification = true;
      i++;
      continue;
    }

    if (arg === "--no-smart-tests") {
      args.noSmartTests = true;
      i++;
      continue;
    }

    if (arg === "--verbose" || arg === "-v") {
      args.verbose = true;
      i++;
      continue;
    }

    // Positional - issue number
    const issueNum = parseInt(arg, 10);
    if (!isNaN(issueNum)) {
      args.issues.push(issueNum);
    }
    i++;
  }

  return args;
}

/**
 * Build config from args and environment
 */
function buildConfig(args: ExecuteIssuesArgs): ExecutionConfig {
  const config: ExecutionConfig = { ...DEFAULT_CONFIG };

  // Phases from args or env
  if (args.phases) {
    config.phases = args.phases;
  } else if (process.env.PHASES) {
    config.phases = process.env.PHASES.split(",").map((p) => p.trim() as Phase);
  }

  // Timeout
  if (args.timeout !== undefined) {
    config.phaseTimeout = args.timeout;
  } else if (process.env.PHASE_TIMEOUT) {
    config.phaseTimeout = parseInt(process.env.PHASE_TIMEOUT, 10);
  }

  // Quality loop
  config.qualityLoop = args.qualityLoop;

  // If quality loop enabled, auto-include testgen after spec phase
  if (config.qualityLoop && !config.phases.includes("testgen")) {
    const specIndex = config.phases.indexOf("spec");
    if (specIndex !== -1) {
      config.phases.splice(specIndex + 1, 0, "testgen");
    }
  }

  // Max iterations
  if (args.maxIterations !== undefined) {
    config.maxIterations = args.maxIterations;
  } else if (process.env.MAX_ITERATIONS) {
    config.maxIterations = parseInt(process.env.MAX_ITERATIONS, 10);
  }

  // Skip verification
  config.skipVerification = args.skipVerification;

  // Sequential mode
  config.sequential = args.sequential;
  config.forceParallel = args.forceParallel;

  // Verbose
  config.verbose = args.verbose;

  // Smart tests (enabled by default, --no-smart-tests disables)
  config.noSmartTests = args.noSmartTests;

  return config;
}

// =====================================================
// EXECUTION MODES
// =====================================================

/**
 * Run issues in parallel with listr2 rendering
 *
 * Uses listr2 for TTY environments to provide:
 * - Spinner animation while tasks are running
 * - Checkmark/X when tasks complete
 * - Duration display after completion
 * - Non-interleaved output in parallel execution
 *
 * Falls back to simple renderer for non-TTY (CI) environments.
 */
async function runParallel(
  issues: number[],
  config: ExecutionConfig,
  log: Logger,
): Promise<IssueResult[]> {
  // Use listr2 for parallel execution with proper rendering
  const results = await runWithListr(
    issues,
    async (issueNumber, execConfig) => {
      // Create a silent logger for listr2 execution
      // (listr2 handles the visual output, we suppress console logs)
      const silentLog = createLogger({ silent: true });
      return runIssue(issueNumber, execConfig, silentLog);
    },
    config,
    {
      verbose: config.verbose,
      forceNonTTY: !isTTY(),
    },
  );

  return results;
}

/**
 * Run issues sequentially (respecting dependencies)
 */
async function runSequential(
  issues: number[],
  config: ExecutionConfig,
  log: Logger,
): Promise<IssueResult[]> {
  const graph = await buildDependencyGraph(issues);

  if (graph.hasCycles) {
    log.error("Dependency cycle detected! Cannot run sequentially.");
    log.error(formatDependencyGraph(graph));
    return [];
  }

  const order = graph.sortedOrder ?? issues;
  log.info(
    `Sequential execution order: ${order.map((n) => `#${n}`).join(" → ")}`,
  );

  const results: IssueResult[] = [];
  for (const issue of order) {
    log.info(`\n${"─".repeat(40)}`);
    const result = await runIssue(issue, config, log);
    results.push(result);

    // If this issue failed and others depend on it, warn
    if (!result.success) {
      const dependents = issues.filter((i) => {
        const deps = graph.edges.get(i);
        return deps && deps.includes(issue);
      });
      if (dependents.length > 0) {
        log.warn(
          `Issue #${issue} failed. Dependent issues affected: ${dependents.map((d) => `#${d}`).join(", ")}`,
        );
      }
    }
  }

  return results;
}

/**
 * Run batches sequentially, issues within batch in parallel
 */
async function runBatches(
  batches: IssueBatch[],
  config: ExecutionConfig,
  log: Logger,
): Promise<BatchResult[]> {
  const results: BatchResult[] = [];

  for (const batch of batches) {
    log.info(`\n${"━".repeat(40)}`);
    log.info(`BATCH ${batch.batchNumber}`);
    log.info(`${"━".repeat(40)}`);

    const issueResults = await runParallel(batch.issues, config, log);
    results.push({
      batchNumber: batch.batchNumber,
      issueResults,
      success: issueResults.every((r) => r.success),
    });

    log.info(`\n⏳ Waiting for BATCH ${batch.batchNumber} to complete...`);
    log.success(`✓ BATCH ${batch.batchNumber} Complete`);
  }

  return results;
}

// =====================================================
// MAIN
// =====================================================

async function main() {
  const argv = process.argv.slice(2);
  const args = parseExecuteIssuesArgs(argv);

  // Help
  if (args.help || isHelpRequested(argv)) {
    printUsage(
      "execute-issues.ts",
      "Execute Claude Code workflow (/spec → /exec → /qa) for GitHub issues.",
      {
        "<issue_numbers>": "Issue numbers to process (space-separated)",
        '--batch "N M"': "Run issues N and M as a batch (repeatable)",
        "--sequential":
          "Run issues sequentially, respecting dependencies (#355)",
        "--force-parallel": "Force parallel even if dependencies detected",
        "--cleanup-orphans [hours]":
          "Mark stale runs (>N hours old) as failed (default: 2)",
        "--test": "Run quick validation tests (no Claude calls)",
        "--phases <list>":
          "Phases to run (default: spec,exec,qa). Available: spec,testgen,exec,test,qa,loop",
        "--timeout <seconds>": "Timeout per phase (default: 1800)",
        "--quality-loop":
          "Enable auto-iteration with /loop (auto-includes testgen phase)",
        "--max-iterations <n>": "Max fix iterations per phase (default: 3)",
        "--skip-verification": "Skip /exec verification",
        "--no-smart-tests":
          "Disable smart tests (auto-run tests after file edits)",
        "--verbose, -v": "Verbose output",
        "--help, -h": "Show this help message",
      },
      [
        "npx tsx --env-file=.env.local scripts/dev/execute-issues.ts 123",
        "npx tsx --env-file=.env.local scripts/dev/execute-issues.ts 123 124 125",
        "PHASES=exec,qa npx tsx --env-file=.env.local scripts/dev/execute-issues.ts 123",
        "PHASES=spec,testgen,exec,qa npx tsx --env-file=.env.local scripts/dev/execute-issues.ts 123  # With test stubs",
        'npx tsx --env-file=.env.local scripts/dev/execute-issues.ts --batch "123 124" --batch "125 126"',
        "npx tsx --env-file=.env.local scripts/dev/execute-issues.ts --sequential 123 124 125",
        "QUALITY_LOOP=true npx tsx --env-file=.env.local scripts/dev/execute-issues.ts 123  # Runs spec,testgen,exec,qa",
        "npx tsx scripts/dev/execute-issues.ts --cleanup-orphans",
        "npx tsx scripts/dev/execute-issues.ts --test",
      ],
    );
    process.exit(0);
  }

  const config = buildConfig(args);
  const log = createLogger({ verbose: config.verbose });

  // Register crash cleanup
  const cleanup = async () => {
    await markAllActiveRunsFailed("process_crash", "Script interrupted");
    process.exit(1);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Test mode
  if (args.test) {
    log.info("🧪 Running validation tests...");
    // Import and run tests dynamically
    try {
      const { runWorkflowTests } = await import("./lib/test-runner");
      const passed = await runWorkflowTests();
      process.exit(passed ? 0 : 1);
    } catch {
      log.warn("Test runner not implemented yet");
      process.exit(0);
    }
  }

  // Cleanup orphans mode
  if (args.cleanupOrphans !== undefined) {
    const hours =
      typeof args.cleanupOrphans === "number" ? args.cleanupOrphans : 2;
    await cleanupOrphanedRuns(hours);
    process.exit(0);
  }

  // Validate we have issues
  const allIssues =
    args.batches.length > 0
      ? args.batches.flatMap((b) => b.issues)
      : args.issues;

  if (allIssues.length === 0) {
    log.error("Error: No issues specified\n");
    printUsage("execute-issues.ts", "", {}, []);
    process.exit(1);
  }

  log.success("🚀 Claude Code Workflow Execution\n");

  // Warn if database logging is disabled
  if (!canLogToSupabase()) {
    log.warn("⚠️ Database logging disabled (missing database credentials)");
    console.log("");
  }

  // Always cleanup orphans first
  if (canLogToSupabase()) {
    await cleanupOrphanedRuns();
    console.log("");
  }

  // Check for dependencies if running multiple issues
  if (allIssues.length > 1 && !config.sequential && !config.forceParallel) {
    const graph = await buildDependencyGraph(allIssues);

    if (hasInterdependencies(graph)) {
      log.warn("⚠️ Dependencies detected between issues!");
      log.info(formatDependencyGraph(graph));
      log.info("");

      if (graph.hasCycles) {
        log.error("Cannot proceed: dependency cycle detected.");
        log.info("Please resolve the cycle or use --force-parallel to ignore.");
        process.exit(1);
      }

      log.info("Options:");
      log.info("  1. Use --sequential to respect dependency order");
      log.info("  2. Use --force-parallel to ignore dependencies");
      log.info("");
      log.info("Exiting. Re-run with one of the above options.");
      process.exit(1);
    }
  }

  // Execute
  let results: IssueResult[];

  if (args.batches.length > 0) {
    // Batch mode
    const batchResults = await runBatches(args.batches, config, log);
    results = batchResults.flatMap((b) => b.issueResults);
  } else if (config.sequential) {
    // Sequential mode
    results = await runSequential(args.issues, config, log);
  } else {
    // Parallel mode
    results = await runParallel(args.issues, config, log);
  }

  // Summary
  console.log("");
  log.success("━".repeat(60));
  log.success("✓ All Issues Processed!");
  log.success("━".repeat(60));
  console.log("");

  // Show results summary
  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  log.info(`Results: ${passed} passed, ${failed} failed`);

  for (const result of results) {
    const status = result.success ? "✅" : "❌";
    const phases = result.phaseResults
      .map((p) => {
        const pStatus = p.success ? "✓" : "✗";
        const duration = p.durationSeconds
          ? `(${formatDuration(p.durationSeconds)})`
          : "";
        return `${p.phase}:${pStatus}${duration}`;
      })
      .join(" ");
    log.info(`  ${status} #${result.issueNumber}: ${phases}`);

    if (result.abortReason) {
      log.info(`     Abort: ${result.abortReason}`);
    }
    if (result.loopTriggered) {
      log.info(`     Quality loop triggered`);
    }
  }

  console.log("");
  log.info("📝 Logs: /tmp/claude-issue-*.log | 📦 Archived: /tmp/claude-logs/");
  log.info("Next: Review logs → Check GitHub comments → Review and merge PRs");

  // Exit with error if any failed
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  markAllActiveRunsFailed("process_crash", err.message).then(() =>
    process.exit(1),
  );
});
