/**
 * sequant run - Execute workflow for GitHub issues
 *
 * Runs the Sequant workflow (/spec → /exec → /qa) for one or more issues.
 */

import chalk from "chalk";
import { spawn, spawnSync } from "child_process";
import { getManifest } from "../lib/manifest.js";
import {
  LogWriter,
  createPhaseLogFromTiming,
} from "../lib/workflow/log-writer.js";
import type { RunConfig } from "../lib/workflow/run-log-schema.js";

/**
 * Check if claude CLI is available
 */
function checkClaudeCli(): boolean {
  const result = spawnSync("claude", ["--version"], {
    stdio: "pipe",
    shell: true,
  });
  return result.status === 0;
}
import {
  Phase,
  DEFAULT_PHASES,
  DEFAULT_CONFIG,
  ExecutionConfig,
  IssueResult,
  PhaseResult,
} from "../lib/workflow/types.js";

interface RunOptions {
  phases?: string;
  sequential?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  timeout?: number;
  logJson?: boolean;
  logPath?: string;
}

/**
 * Format duration in human-readable format
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs.toFixed(0)}s`;
}

/**
 * Execute a single phase for an issue using claude CLI
 */
async function executePhase(
  issueNumber: number,
  phase: Phase,
  config: ExecutionConfig,
): Promise<PhaseResult> {
  const startTime = Date.now();

  if (config.dryRun) {
    // Dry run - just simulate
    if (config.verbose) {
      console.log(chalk.gray(`    Would execute: /${phase} ${issueNumber}`));
    }
    return {
      phase,
      success: true,
      durationSeconds: 0,
    };
  }

  // Execute claude CLI with the skill
  return new Promise((resolve) => {
    const command = `/${phase} ${issueNumber}`;
    const timeout = config.phaseTimeout * 1000;

    if (config.verbose) {
      console.log(chalk.gray(`    Executing: ${command}`));
    }

    const proc = spawn(
      "claude",
      ["--print", "--dangerously-skip-permissions", "-p", command],
      {
        stdio: config.verbose ? "inherit" : "pipe",
        shell: true,
        timeout,
      },
    );

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const durationSeconds = (Date.now() - startTime) / 1000;

      if (killed) {
        resolve({
          phase,
          success: false,
          durationSeconds,
          error: `Timeout after ${config.phaseTimeout}s`,
        });
      } else if (code === 0) {
        resolve({
          phase,
          success: true,
          durationSeconds,
        });
      } else {
        resolve({
          phase,
          success: false,
          durationSeconds,
          error: `Exit code ${code}`,
        });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      const durationSeconds = (Date.now() - startTime) / 1000;
      resolve({
        phase,
        success: false,
        durationSeconds,
        error: err.message,
      });
    });
  });
}

/**
 * Fetch issue info from GitHub
 */
async function getIssueInfo(
  issueNumber: number,
): Promise<{ title: string; labels: string[] }> {
  try {
    const result = spawnSync(
      "gh",
      [
        "issue",
        "view",
        String(issueNumber),
        "--json",
        "title,labels",
        "--jq",
        '"\(.title)|\(.labels | map(.name) | join(","))"',
      ],
      { stdio: "pipe", shell: true },
    );

    if (result.status === 0) {
      const output = result.stdout.toString().trim().replace(/^"|"$/g, "");
      const [title, labelsStr] = output.split("|");
      return {
        title: title || `Issue #${issueNumber}`,
        labels: labelsStr ? labelsStr.split(",").filter(Boolean) : [],
      };
    }
  } catch {
    // Ignore errors, use defaults
  }

  return { title: `Issue #${issueNumber}`, labels: [] };
}

/**
 * Main run command
 */
export async function runCommand(
  issues: string[],
  options: RunOptions,
): Promise<void> {
  console.log(chalk.blue("\n🚀 Sequant Workflow Execution\n"));

  // Check if initialized
  const manifest = await getManifest();
  if (!manifest) {
    console.log(
      chalk.red("❌ Sequant is not initialized. Run `sequant init` first."),
    );
    return;
  }

  // Check if claude CLI is available (skip for dry-run)
  if (!options.dryRun && !checkClaudeCli()) {
    console.log(
      chalk.red(
        "❌ Claude CLI not found. Install it from https://claude.ai/code",
      ),
    );
    console.log(chalk.gray("  Or use --dry-run to preview without execution."));
    return;
  }

  // Parse issue numbers
  const issueNumbers = issues
    .map((i) => parseInt(i, 10))
    .filter((n) => !isNaN(n));

  if (issueNumbers.length === 0) {
    console.log(chalk.red("❌ No valid issue numbers provided."));
    console.log(chalk.gray("\nUsage: sequant run <issues...> [options]"));
    console.log(chalk.gray("Example: sequant run 1 2 3 --sequential"));
    return;
  }

  // Build config
  const config: ExecutionConfig = {
    ...DEFAULT_CONFIG,
    phases: options.phases
      ? (options.phases.split(",").map((p) => p.trim()) as Phase[])
      : DEFAULT_PHASES,
    sequential: options.sequential ?? false,
    dryRun: options.dryRun ?? false,
    verbose: options.verbose ?? false,
    phaseTimeout: options.timeout ?? DEFAULT_CONFIG.phaseTimeout,
  };

  // Initialize log writer if JSON logging enabled
  let logWriter: LogWriter | null = null;
  if (options.logJson && !config.dryRun) {
    const runConfig: RunConfig = {
      phases: config.phases,
      sequential: config.sequential,
      qualityLoop: config.qualityLoop,
      maxIterations: config.maxIterations,
    };

    logWriter = new LogWriter({
      logPath: options.logPath,
      verbose: config.verbose,
    });
    await logWriter.initialize(runConfig);
  }

  // Display configuration
  console.log(chalk.gray(`  Stack: ${manifest.stack}`));
  console.log(chalk.gray(`  Phases: ${config.phases.join(" → ")}`));
  console.log(
    chalk.gray(`  Mode: ${config.sequential ? "sequential" : "parallel"}`),
  );
  if (config.dryRun) {
    console.log(chalk.yellow(`  ⚠️  DRY RUN - no actual execution`));
  }
  if (logWriter) {
    console.log(
      chalk.gray(
        `  Logging: JSON (run ${logWriter.getRunId()?.slice(0, 8)}...)`,
      ),
    );
  }
  console.log(
    chalk.gray(`  Issues: ${issueNumbers.map((n) => `#${n}`).join(", ")}`),
  );

  // Execute
  const results: IssueResult[] = [];

  if (config.sequential) {
    // Sequential execution
    for (const issueNumber of issueNumbers) {
      // Start issue logging
      if (logWriter) {
        const issueInfo = await getIssueInfo(issueNumber);
        logWriter.startIssue(issueNumber, issueInfo.title, issueInfo.labels);
      }

      const result = await runIssueWithLogging(issueNumber, config, logWriter);
      results.push(result);

      // Complete issue logging
      if (logWriter) {
        logWriter.completeIssue();
      }

      if (!result.success) {
        console.log(
          chalk.yellow(
            `\n  ⚠️  Issue #${issueNumber} failed, stopping sequential execution`,
          ),
        );
        break;
      }
    }
  } else {
    // Parallel execution (for now, just run sequentially but don't stop on failure)
    // TODO: Add proper parallel execution with listr2
    for (const issueNumber of issueNumbers) {
      // Start issue logging
      if (logWriter) {
        const issueInfo = await getIssueInfo(issueNumber);
        logWriter.startIssue(issueNumber, issueInfo.title, issueInfo.labels);
      }

      const result = await runIssueWithLogging(issueNumber, config, logWriter);
      results.push(result);

      // Complete issue logging
      if (logWriter) {
        logWriter.completeIssue();
      }
    }
  }

  // Finalize log
  let logPath: string | null = null;
  if (logWriter) {
    logPath = await logWriter.finalize();
  }

  // Summary
  console.log(chalk.blue("\n" + "━".repeat(50)));
  console.log(chalk.blue("  Summary"));
  console.log(chalk.blue("━".repeat(50)));

  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log(
    chalk.gray(
      `\n  Results: ${chalk.green(`${passed} passed`)}, ${chalk.red(`${failed} failed`)}`,
    ),
  );

  for (const result of results) {
    const status = result.success ? chalk.green("✓") : chalk.red("✗");
    const duration = result.durationSeconds
      ? chalk.gray(` (${formatDuration(result.durationSeconds)})`)
      : "";
    const phases = result.phaseResults
      .map((p) => (p.success ? chalk.green(p.phase) : chalk.red(p.phase)))
      .join(" → ");
    console.log(`  ${status} #${result.issueNumber}: ${phases}${duration}`);
  }

  console.log("");

  if (logPath) {
    console.log(chalk.gray(`  📝 Log: ${logPath}`));
    console.log("");
  }

  if (config.dryRun) {
    console.log(
      chalk.yellow(
        "  ℹ️  This was a dry run. Use without --dry-run to execute.",
      ),
    );
    console.log("");
  }

  // Exit with error if any failed
  if (failed > 0 && !config.dryRun) {
    process.exit(1);
  }
}

/**
 * Execute all phases for a single issue with logging
 */
async function runIssueWithLogging(
  issueNumber: number,
  config: ExecutionConfig,
  logWriter: LogWriter | null,
): Promise<IssueResult> {
  const startTime = Date.now();
  const phaseResults: PhaseResult[] = [];

  console.log(chalk.blue(`\n  Issue #${issueNumber}`));

  for (const phase of config.phases) {
    console.log(chalk.gray(`    ⏳ ${phase}...`));

    const phaseStartTime = new Date();
    const result = await executePhase(issueNumber, phase, config);
    const phaseEndTime = new Date();
    phaseResults.push(result);

    // Log phase result
    if (logWriter) {
      const phaseLog = createPhaseLogFromTiming(
        phase,
        issueNumber,
        phaseStartTime,
        phaseEndTime,
        result.success
          ? "success"
          : result.error?.includes("Timeout")
            ? "timeout"
            : "failure",
        { error: result.error },
      );
      logWriter.logPhase(phaseLog);
    }

    if (result.success) {
      const duration = result.durationSeconds
        ? ` (${formatDuration(result.durationSeconds)})`
        : "";
      console.log(chalk.green(`    ✓ ${phase}${duration}`));
    } else {
      console.log(chalk.red(`    ✗ ${phase}: ${result.error}`));
      // Stop on first failure
      break;
    }
  }

  const durationSeconds = (Date.now() - startTime) / 1000;
  const success = phaseResults.every((r) => r.success);

  return {
    issueNumber,
    success,
    phaseResults,
    durationSeconds,
  };
}
