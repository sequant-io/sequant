/**
 * sequant run - Execute workflow for GitHub issues
 *
 * Runs the Sequant workflow (/spec → /exec → /qa) for one or more issues
 * using the Claude Agent SDK for proper skill invocation.
 */

import chalk from "chalk";
import { spawnSync } from "child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { getManifest } from "../lib/manifest.js";
import {
  LogWriter,
  createPhaseLogFromTiming,
} from "../lib/workflow/log-writer.js";
import type { RunConfig } from "../lib/workflow/run-log-schema.js";
import {
  Phase,
  DEFAULT_PHASES,
  DEFAULT_CONFIG,
  ExecutionConfig,
  IssueResult,
  PhaseResult,
} from "../lib/workflow/types.js";

/**
 * Natural language prompts for each phase
 * These prompts will invoke the corresponding skills via natural language
 */
const PHASE_PROMPTS: Record<Phase, string> = {
  spec: "Review GitHub issue #{issue} and create an implementation plan with verification criteria. Run the /spec {issue} workflow.",
  testgen:
    "Generate test stubs for GitHub issue #{issue} based on the specification. Run the /testgen {issue} workflow.",
  exec: "Implement the feature for GitHub issue #{issue} following the spec. Run the /exec {issue} workflow.",
  test: "Execute structured browser-based testing for GitHub issue #{issue}. Run the /test {issue} workflow.",
  qa: "Review the implementation for GitHub issue #{issue} against acceptance criteria. Run the /qa {issue} workflow.",
  loop: "Parse test/QA findings for GitHub issue #{issue} and iterate until quality gates pass. Run the /loop {issue} workflow.",
};

/**
 * UI-related labels that trigger automatic test phase
 */
const UI_LABELS = ["ui", "frontend", "admin", "web", "browser"];

interface RunOptions {
  phases?: string;
  sequential?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  timeout?: number;
  logJson?: boolean;
  logPath?: string;
  qualityLoop?: boolean;
  maxIterations?: number;
  batch?: string[];
  smartTests?: boolean;
  noSmartTests?: boolean;
  testgen?: boolean;
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
 * Get the prompt for a phase with the issue number substituted
 */
function getPhasePrompt(phase: Phase, issueNumber: number): string {
  return PHASE_PROMPTS[phase].replace(/\{issue\}/g, String(issueNumber));
}

/**
 * Execute a single phase for an issue using Claude Agent SDK
 */
async function executePhase(
  issueNumber: number,
  phase: Phase,
  config: ExecutionConfig,
  sessionId?: string,
): Promise<PhaseResult & { sessionId?: string }> {
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

  const prompt = getPhasePrompt(phase, issueNumber);

  if (config.verbose) {
    console.log(chalk.gray(`    Prompt: ${prompt}`));
  }

  try {
    // Create abort controller for timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, config.phaseTimeout * 1000);

    let resultSessionId: string | undefined;
    let resultMessage: SDKResultMessage | undefined;
    let lastError: string | undefined;

    // Execute using Claude Agent SDK
    const queryInstance = query({
      prompt,
      options: {
        abortController,
        cwd: process.cwd(),
        // Load project settings including skills
        settingSources: ["project"],
        // Use Claude Code's system prompt and tools
        systemPrompt: { type: "preset", preset: "claude_code" },
        tools: { type: "preset", preset: "claude_code" },
        // Bypass permissions for headless execution
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // Resume from previous session if provided
        ...(sessionId ? { resume: sessionId } : {}),
        // Configure smart tests via environment
        env: {
          ...process.env,
          CLAUDE_HOOKS_SMART_TESTS: config.noSmartTests ? "false" : "true",
        },
      },
    });

    // Stream and process messages
    for await (const message of queryInstance) {
      // Capture session ID from system init message
      if (message.type === "system" && message.subtype === "init") {
        resultSessionId = message.session_id;
      }

      // Show streaming output in verbose mode
      if (config.verbose && message.type === "assistant") {
        // Extract text content from the message
        const content = message.message.content as Array<{
          type: string;
          text?: string;
        }>;
        const textContent = content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text)
          .join("");
        if (textContent) {
          process.stdout.write(chalk.gray(textContent));
        }
      }

      // Capture the final result
      if (message.type === "result") {
        resultMessage = message;
      }
    }

    clearTimeout(timeoutId);

    const durationSeconds = (Date.now() - startTime) / 1000;

    // Check result status
    if (resultMessage) {
      if (resultMessage.subtype === "success") {
        return {
          phase,
          success: true,
          durationSeconds,
          sessionId: resultSessionId,
        };
      } else {
        // Handle error subtypes
        const errorSubtype = resultMessage.subtype;
        if (errorSubtype === "error_max_turns") {
          lastError = "Max turns reached";
        } else if (errorSubtype === "error_during_execution") {
          lastError =
            resultMessage.errors?.join(", ") || "Error during execution";
        } else if (errorSubtype === "error_max_budget_usd") {
          lastError = "Budget limit exceeded";
        } else {
          lastError = `Error: ${errorSubtype}`;
        }

        return {
          phase,
          success: false,
          durationSeconds,
          error: lastError,
          sessionId: resultSessionId,
        };
      }
    }

    // No result message received
    return {
      phase,
      success: false,
      durationSeconds: (Date.now() - startTime) / 1000,
      error: "No result received from Claude",
      sessionId: resultSessionId,
    };
  } catch (err) {
    const durationSeconds = (Date.now() - startTime) / 1000;
    const error = err instanceof Error ? err.message : String(err);

    // Check if it was an abort (timeout)
    if (error.includes("abort") || error.includes("AbortError")) {
      return {
        phase,
        success: false,
        durationSeconds,
        error: `Timeout after ${config.phaseTimeout}s`,
      };
    }

    return {
      phase,
      success: false,
      durationSeconds,
      error,
    };
  }
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
 * Check if an issue has UI-related labels
 */
function hasUILabels(labels: string[]): boolean {
  return labels.some((label) =>
    UI_LABELS.some((uiLabel) => label.toLowerCase().includes(uiLabel)),
  );
}

/**
 * Determine phases to run based on options and issue labels
 */
function determinePhasesForIssue(
  basePhases: Phase[],
  labels: string[],
  options: RunOptions,
): Phase[] {
  let phases = [...basePhases];

  // Add testgen phase after spec if requested
  if (options.testgen && phases.includes("spec")) {
    const specIndex = phases.indexOf("spec");
    if (!phases.includes("testgen")) {
      phases.splice(specIndex + 1, 0, "testgen");
    }
  }

  // Auto-detect UI issues and add test phase
  if (hasUILabels(labels) && !phases.includes("test")) {
    // Add test phase before qa if present, otherwise at the end
    const qaIndex = phases.indexOf("qa");
    if (qaIndex !== -1) {
      phases.splice(qaIndex, 0, "test");
    } else {
      phases.push("test");
    }
  }

  return phases;
}

/**
 * Parse environment variables for CI configuration
 */
function getEnvConfig(): Partial<RunOptions> {
  const config: Partial<RunOptions> = {};

  if (process.env.SEQUANT_QUALITY_LOOP === "true") {
    config.qualityLoop = true;
  }

  if (process.env.SEQUANT_MAX_ITERATIONS) {
    const maxIter = parseInt(process.env.SEQUANT_MAX_ITERATIONS, 10);
    if (!isNaN(maxIter)) {
      config.maxIterations = maxIter;
    }
  }

  if (process.env.SEQUANT_SMART_TESTS === "false") {
    config.noSmartTests = true;
  }

  if (process.env.SEQUANT_TESTGEN === "true") {
    config.testgen = true;
  }

  return config;
}

/**
 * Parse batch arguments into groups of issues
 */
function parseBatches(batchArgs: string[]): number[][] {
  return batchArgs.map((batch) =>
    batch
      .split(/\s+/)
      .map((n) => parseInt(n, 10))
      .filter((n) => !isNaN(n)),
  );
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

  // Merge environment config with CLI options
  const envConfig = getEnvConfig();
  const mergedOptions = { ...envConfig, ...options };

  // Parse issue numbers (or use batch mode)
  let issueNumbers: number[];
  let batches: number[][] | null = null;

  if (mergedOptions.batch && mergedOptions.batch.length > 0) {
    batches = parseBatches(mergedOptions.batch);
    issueNumbers = batches.flat();
    console.log(
      chalk.gray(
        `  Batch mode: ${batches.map((b) => `[${b.join(", ")}]`).join(" → ")}`,
      ),
    );
  } else {
    issueNumbers = issues.map((i) => parseInt(i, 10)).filter((n) => !isNaN(n));
  }

  if (issueNumbers.length === 0) {
    console.log(chalk.red("❌ No valid issue numbers provided."));
    console.log(chalk.gray("\nUsage: sequant run <issues...> [options]"));
    console.log(chalk.gray("Example: sequant run 1 2 3 --sequential"));
    console.log(
      chalk.gray('Batch example: sequant run --batch "1 2" --batch "3"'),
    );
    return;
  }

  // Build config
  const config: ExecutionConfig = {
    ...DEFAULT_CONFIG,
    phases: mergedOptions.phases
      ? (mergedOptions.phases.split(",").map((p) => p.trim()) as Phase[])
      : DEFAULT_PHASES,
    sequential: mergedOptions.sequential ?? false,
    dryRun: mergedOptions.dryRun ?? false,
    verbose: mergedOptions.verbose ?? false,
    phaseTimeout: mergedOptions.timeout ?? DEFAULT_CONFIG.phaseTimeout,
    qualityLoop: mergedOptions.qualityLoop ?? false,
    maxIterations: mergedOptions.maxIterations ?? DEFAULT_CONFIG.maxIterations,
    noSmartTests: mergedOptions.noSmartTests ?? false,
  };

  // Initialize log writer if JSON logging enabled
  let logWriter: LogWriter | null = null;
  if (mergedOptions.logJson && !config.dryRun) {
    const runConfig: RunConfig = {
      phases: config.phases,
      sequential: config.sequential,
      qualityLoop: config.qualityLoop,
      maxIterations: config.maxIterations,
    };

    logWriter = new LogWriter({
      logPath: mergedOptions.logPath,
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
  if (config.qualityLoop) {
    console.log(
      chalk.gray(
        `  Quality loop: enabled (max ${config.maxIterations} iterations)`,
      ),
    );
  }
  if (mergedOptions.testgen) {
    console.log(chalk.gray(`  Testgen: enabled`));
  }
  if (config.noSmartTests) {
    console.log(chalk.gray(`  Smart tests: disabled`));
  }
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

  if (batches) {
    // Batch execution: run batches sequentially, issues within batch based on mode
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      console.log(
        chalk.blue(
          `\n  Batch ${batchIdx + 1}/${batches.length}: Issues ${batch.map((n) => `#${n}`).join(", ")}`,
        ),
      );

      const batchResults = await executeBatch(
        batch,
        config,
        logWriter,
        mergedOptions,
      );
      results.push(...batchResults);

      // Check if batch failed and we should stop
      const batchFailed = batchResults.some((r) => !r.success);
      if (batchFailed && config.sequential) {
        console.log(
          chalk.yellow(
            `\n  ⚠️  Batch ${batchIdx + 1} failed, stopping batch execution`,
          ),
        );
        break;
      }
    }
  } else if (config.sequential) {
    // Sequential execution
    for (const issueNumber of issueNumbers) {
      const issueInfo = await getIssueInfo(issueNumber);

      // Start issue logging
      if (logWriter) {
        logWriter.startIssue(issueNumber, issueInfo.title, issueInfo.labels);
      }

      const result = await runIssueWithLogging(
        issueNumber,
        config,
        logWriter,
        issueInfo.labels,
        mergedOptions,
      );
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
      const issueInfo = await getIssueInfo(issueNumber);

      // Start issue logging
      if (logWriter) {
        logWriter.startIssue(issueNumber, issueInfo.title, issueInfo.labels);
      }

      const result = await runIssueWithLogging(
        issueNumber,
        config,
        logWriter,
        issueInfo.labels,
        mergedOptions,
      );
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
    const loopInfo = result.loopTriggered ? chalk.yellow(" [loop]") : "";
    console.log(
      `  ${status} #${result.issueNumber}: ${phases}${loopInfo}${duration}`,
    );
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
 * Execute a batch of issues
 */
async function executeBatch(
  issueNumbers: number[],
  config: ExecutionConfig,
  logWriter: LogWriter | null,
  options: RunOptions,
): Promise<IssueResult[]> {
  const results: IssueResult[] = [];

  for (const issueNumber of issueNumbers) {
    const issueInfo = await getIssueInfo(issueNumber);

    // Start issue logging
    if (logWriter) {
      logWriter.startIssue(issueNumber, issueInfo.title, issueInfo.labels);
    }

    const result = await runIssueWithLogging(
      issueNumber,
      config,
      logWriter,
      issueInfo.labels,
      options,
    );
    results.push(result);

    // Complete issue logging
    if (logWriter) {
      logWriter.completeIssue();
    }
  }

  return results;
}

/**
 * Execute all phases for a single issue with logging and quality loop
 */
async function runIssueWithLogging(
  issueNumber: number,
  config: ExecutionConfig,
  logWriter: LogWriter | null,
  labels: string[],
  options: RunOptions,
): Promise<IssueResult> {
  const startTime = Date.now();
  const phaseResults: PhaseResult[] = [];
  let loopTriggered = false;
  let sessionId: string | undefined;

  console.log(chalk.blue(`\n  Issue #${issueNumber}`));

  // Determine phases for this specific issue
  const phases = determinePhasesForIssue(config.phases, labels, options);
  if (phases.length !== config.phases.length) {
    console.log(chalk.gray(`    Phases adjusted: ${phases.join(" → ")}`));
  }

  let iteration = 0;
  const maxIterations = config.qualityLoop ? config.maxIterations : 1;

  while (iteration < maxIterations) {
    iteration++;

    if (config.qualityLoop && iteration > 1) {
      console.log(
        chalk.yellow(
          `    Quality loop iteration ${iteration}/${maxIterations}`,
        ),
      );
      loopTriggered = true;
    }

    let phasesFailed = false;

    for (const phase of phases) {
      console.log(chalk.gray(`    ⏳ ${phase}...`));

      const phaseStartTime = new Date();
      const result = await executePhase(issueNumber, phase, config, sessionId);
      const phaseEndTime = new Date();

      // Capture session ID for subsequent phases
      if (result.sessionId) {
        sessionId = result.sessionId;
      }

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
        phasesFailed = true;

        // If quality loop enabled, run loop phase to fix issues
        if (config.qualityLoop && iteration < maxIterations) {
          console.log(chalk.yellow(`    Running /loop to fix issues...`));

          const loopResult = await executePhase(
            issueNumber,
            "loop",
            config,
            sessionId,
          );
          phaseResults.push(loopResult);

          if (loopResult.sessionId) {
            sessionId = loopResult.sessionId;
          }

          if (loopResult.success) {
            console.log(chalk.green(`    ✓ loop - retrying phases`));
            // Continue to next iteration
            break;
          } else {
            console.log(chalk.red(`    ✗ loop: ${loopResult.error}`));
          }
        }

        // Stop on first failure (if not in quality loop or loop failed)
        break;
      }
    }

    // If all phases passed, exit the loop
    if (!phasesFailed) {
      break;
    }

    // If we're not in quality loop mode, don't retry
    if (!config.qualityLoop) {
      break;
    }
  }

  const durationSeconds = (Date.now() - startTime) / 1000;
  const success =
    phaseResults.length > 0 && phaseResults.every((r) => r.success);

  return {
    issueNumber,
    success,
    phaseResults,
    durationSeconds,
    loopTriggered,
  };
}
