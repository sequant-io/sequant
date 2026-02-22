/**
 * Phase Execution Module
 *
 * Handles execution of individual workflow phases using Claude Agent SDK:
 * - Phase execution with SDK integration
 * - Automatic retry for cold-start failures
 * - MCP fallback strategy
 * - Timeout handling
 *
 * @module phase-executor
 */

import chalk from "chalk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { getMcpServersConfig } from "../system.js";
import { ShutdownManager } from "../shutdown.js";
import { PhaseSpinner } from "../phase-spinner.js";
import type {
  Phase,
  ExecutionConfig,
  PhaseResult,
  QaVerdict,
} from "./types.js";

/**
 * Natural language prompts for each phase
 * These prompts will invoke the corresponding skills via natural language
 */
export const PHASE_PROMPTS: Record<Phase, string> = {
  spec: "Review GitHub issue #{issue} and create an implementation plan with verification criteria. Run the /spec {issue} workflow.",
  "security-review":
    "Perform a deep security analysis for GitHub issue #{issue} focusing on auth, permissions, and sensitive operations. Run the /security-review {issue} workflow.",
  testgen:
    "Generate test stubs for GitHub issue #{issue} based on the specification. Run the /testgen {issue} workflow.",
  exec: "Implement the feature for GitHub issue #{issue} following the spec. Run the /exec {issue} workflow.",
  test: "Execute structured browser-based testing for GitHub issue #{issue}. Run the /test {issue} workflow.",
  qa: "Review the implementation for GitHub issue #{issue} against acceptance criteria. Run the /qa {issue} workflow.",
  loop: "Parse test/QA findings for GitHub issue #{issue} and iterate until quality gates pass. Run the /loop {issue} workflow.",
};

/**
 * Phases that require worktree isolation (exec, test, qa)
 * Spec runs in main repo since it's planning-only
 */
export const ISOLATED_PHASES: Phase[] = ["exec", "test", "qa"];

/**
 * Cold-start retry threshold in seconds.
 * Failures under this duration are likely Claude Code subprocess initialization
 * issues rather than genuine phase failures (based on empirical data: cold-start
 * failures consistently complete in 15-39s vs 150-310s for real work).
 */
const COLD_START_THRESHOLD_SECONDS = 60;
const COLD_START_MAX_RETRIES = 2;

/**
 * Parse QA verdict from phase output
 *
 * Looks for verdict patterns in the QA output:
 * - "### Verdict: READY_FOR_MERGE"
 * - "**Verdict:** AC_NOT_MET"
 * - "Verdict: AC_MET_BUT_NOT_A_PLUS"
 *
 * @param output - The captured output from QA phase
 * @returns The parsed verdict or null if not found
 */
export function parseQaVerdict(output: string): QaVerdict | null {
  if (!output) return null;

  // Match various verdict formats:
  // - "### Verdict: X" (markdown header)
  // - "**Verdict:** X" (bold label with colon inside)
  // - "**Verdict:** **X**" (bold label and bold value)
  // - "Verdict: X" (plain)
  // Case insensitive, handles optional markdown formatting
  const verdictMatch = output.match(
    /(?:###?\s*)?(?:\*\*)?Verdict:?\*?\*?\s*\*?\*?\s*(READY_FOR_MERGE|AC_MET_BUT_NOT_A_PLUS|AC_NOT_MET|NEEDS_VERIFICATION)\*?\*?/i,
  );

  if (!verdictMatch) return null;

  // Normalize to uppercase with underscores
  const verdict = verdictMatch[1].toUpperCase().replace(/-/g, "_") as QaVerdict;
  return verdict;
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(seconds: number): string {
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
export function getPhasePrompt(phase: Phase, issueNumber: number): string {
  return PHASE_PROMPTS[phase].replace(/\{issue\}/g, String(issueNumber));
}

/**
 * Execute a single phase for an issue using Claude Agent SDK
 */
export async function executePhase(
  issueNumber: number,
  phase: Phase,
  config: ExecutionConfig,
  sessionId?: string,
  worktreePath?: string,
  shutdownManager?: ShutdownManager,
  spinner?: PhaseSpinner,
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
    if (worktreePath && ISOLATED_PHASES.includes(phase)) {
      console.log(chalk.gray(`    Worktree: ${worktreePath}`));
    }
  }

  // Determine working directory and environment
  const shouldUseWorktree = worktreePath && ISOLATED_PHASES.includes(phase);
  const cwd = shouldUseWorktree ? worktreePath : process.cwd();

  // Track stderr for error diagnostics (declared outside try for catch access)
  let capturedStderr = "";

  try {
    // Check if shutdown is in progress
    if (shutdownManager?.shuttingDown) {
      return {
        phase,
        success: false,
        durationSeconds: 0,
        error: "Shutdown in progress",
      };
    }

    // Create abort controller for timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, config.phaseTimeout * 1000);

    // Register abort controller with shutdown manager for graceful shutdown
    if (shutdownManager) {
      shutdownManager.setAbortController(abortController);
    }

    let resultSessionId: string | undefined;
    let resultMessage: SDKResultMessage | undefined;
    let lastError: string | undefined;
    let capturedOutput = "";

    // Build environment with worktree isolation variables
    const env: Record<string, string> = {
      ...process.env,
      CLAUDE_HOOKS_SMART_TESTS: config.noSmartTests ? "false" : "true",
    };

    // Set worktree isolation environment variables
    if (shouldUseWorktree) {
      env.SEQUANT_WORKTREE = worktreePath;
      env.SEQUANT_ISSUE = String(issueNumber);
    }

    // Set orchestration context for skills to detect they're part of a workflow
    // Skills can check these to skip redundant pre-flight checks
    env.SEQUANT_ORCHESTRATOR = "sequant-run";
    env.SEQUANT_PHASE = phase;

    // Execute using Claude Agent SDK
    // Note: Don't resume sessions when switching to worktree (different cwd breaks resume)
    const canResume = sessionId && !shouldUseWorktree;

    // Get MCP servers config if enabled
    // Reads from Claude Desktop config and passes to SDK for headless MCP support
    const mcpServers = config.mcp ? getMcpServersConfig() : undefined;

    // Track whether we're actively streaming verbose output
    // Pausing spinner once per streaming session prevents truncation from rapid pause/resume cycles
    // (Issue #283: ora's stop() clears the current line, which can truncate output when
    // pause/resume is called for every chunk in rapid succession)
    let verboseStreamingActive = false;

    const queryInstance = query({
      prompt,
      options: {
        abortController,
        cwd,
        // Load project settings including skills
        settingSources: ["project"],
        // Use Claude Code's system prompt and tools
        systemPrompt: { type: "preset", preset: "claude_code" },
        tools: { type: "preset", preset: "claude_code" },
        // Bypass permissions for headless execution
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // Resume from previous session if provided (but not when switching directories)
        ...(canResume ? { resume: sessionId } : {}),
        // Configure smart tests and worktree isolation via environment
        env,
        // Pass MCP servers for headless mode (AC-2)
        ...(mcpServers ? { mcpServers } : {}),
        // Capture stderr for debugging (helps diagnose early exit failures)
        stderr: (data: string) => {
          capturedStderr += data;
          // Write stderr in verbose mode
          if (config.verbose) {
            // Pause spinner once to avoid truncation (Issue #283)
            if (!verboseStreamingActive) {
              spinner?.pause();
              verboseStreamingActive = true;
            }
            process.stderr.write(chalk.red(data));
          }
        },
      },
    });

    // Stream and process messages
    for await (const message of queryInstance) {
      // Capture session ID from system init message
      if (message.type === "system" && message.subtype === "init") {
        resultSessionId = message.session_id;
      }

      // Capture output from assistant messages
      if (message.type === "assistant") {
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
          capturedOutput += textContent;
          // Show streaming output in verbose mode
          if (config.verbose) {
            // Pause spinner once at start of streaming to avoid truncation
            // (Issue #283: repeated pause/resume causes ora to clear lines between chunks)
            if (!verboseStreamingActive) {
              spinner?.pause();
              verboseStreamingActive = true;
            }
            process.stdout.write(chalk.gray(textContent));
          }
        }
      }

      // Capture the final result
      if (message.type === "result") {
        resultMessage = message;
      }
    }

    // Resume spinner after streaming completes (if we paused it)
    if (verboseStreamingActive) {
      spinner?.resume();
      verboseStreamingActive = false;
    }

    clearTimeout(timeoutId);

    // Clear abort controller from shutdown manager
    if (shutdownManager) {
      shutdownManager.clearAbortController();
    }

    const durationSeconds = (Date.now() - startTime) / 1000;

    // Check result status
    if (resultMessage) {
      if (resultMessage.subtype === "success") {
        // For QA phase, check the verdict to determine actual success
        // SDK "success" just means the query completed - we need to parse the verdict
        if (phase === "qa" && capturedOutput) {
          const verdict = parseQaVerdict(capturedOutput);
          // Only READY_FOR_MERGE and NEEDS_VERIFICATION are considered passing
          // NEEDS_VERIFICATION is external verification, not a code quality issue
          if (
            verdict &&
            verdict !== "READY_FOR_MERGE" &&
            verdict !== "NEEDS_VERIFICATION"
          ) {
            return {
              phase,
              success: false,
              durationSeconds,
              error: `QA verdict: ${verdict}`,
              sessionId: resultSessionId,
              output: capturedOutput,
              verdict, // Include parsed verdict
            };
          }
          // Pass case - include verdict for logging
          return {
            phase,
            success: true,
            durationSeconds,
            sessionId: resultSessionId,
            output: capturedOutput,
            verdict: verdict ?? undefined, // Include if found
          };
        }

        return {
          phase,
          success: true,
          durationSeconds,
          sessionId: resultSessionId,
          output: capturedOutput,
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

    // Include stderr in error message if available (helps diagnose early exit failures)
    const stderrSuffix = capturedStderr
      ? `\nStderr: ${capturedStderr.slice(0, 500)}`
      : "";

    return {
      phase,
      success: false,
      durationSeconds,
      error: error + stderrSuffix,
    };
  }
}

/**
 * Execute a phase with automatic retry for cold-start failures and MCP fallback.
 *
 * Retry strategy:
 * 1. If phase fails within COLD_START_THRESHOLD_SECONDS, retry up to COLD_START_MAX_RETRIES times
 * 2. If still failing and MCP is enabled, retry once with MCP disabled (npx-based MCP servers
 *    can fail on first run due to cold-cache issues)
 *
 * The MCP fallback is safe because MCP servers are optional enhancements, not required
 * for core functionality.
 */
/**
 * @internal Exported for testing only
 */
export async function executePhaseWithRetry(
  issueNumber: number,
  phase: Phase,
  config: ExecutionConfig,
  sessionId?: string,
  worktreePath?: string,
  shutdownManager?: ShutdownManager,
  spinner?: PhaseSpinner,
  /** @internal Injected for testing — defaults to module-level executePhase */
  executePhaseFn: typeof executePhase = executePhase,
): Promise<PhaseResult & { sessionId?: string }> {
  // Skip retry logic if explicitly disabled
  if (config.retry === false) {
    return executePhaseFn(
      issueNumber,
      phase,
      config,
      sessionId,
      worktreePath,
      shutdownManager,
      spinner,
    );
  }

  let lastResult: PhaseResult & { sessionId?: string };

  // Phase 1: Cold-start retry attempts (with MCP enabled if configured)
  for (let attempt = 0; attempt <= COLD_START_MAX_RETRIES; attempt++) {
    lastResult = await executePhaseFn(
      issueNumber,
      phase,
      config,
      sessionId,
      worktreePath,
      shutdownManager,
      spinner,
    );

    const duration = lastResult.durationSeconds ?? 0;

    // Success or genuine failure (took long enough to be real work)
    if (lastResult.success || duration >= COLD_START_THRESHOLD_SECONDS) {
      return lastResult;
    }

    // Cold-start failure detected — retry
    if (attempt < COLD_START_MAX_RETRIES) {
      if (config.verbose) {
        console.log(
          chalk.yellow(
            `\n    ⟳ Cold-start failure detected (${duration.toFixed(1)}s), retrying... (attempt ${attempt + 2}/${COLD_START_MAX_RETRIES + 1})`,
          ),
        );
      }
    }
  }

  // Capture the original error for better diagnostics
  const originalError = lastResult!.error;

  // Phase 2: MCP fallback - if MCP is enabled and we're still failing, try without MCP
  // This handles npx-based MCP servers that fail on first run due to cold-cache issues
  if (config.mcp && !lastResult!.success) {
    console.log(
      chalk.yellow(
        `\n    ⚠️ Phase failed with MCP enabled, retrying without MCP...`,
      ),
    );

    // Create config copy with MCP disabled
    const configWithoutMcp: ExecutionConfig = {
      ...config,
      mcp: false,
    };

    const retryResult = await executePhaseFn(
      issueNumber,
      phase,
      configWithoutMcp,
      sessionId,
      worktreePath,
      shutdownManager,
      spinner,
    );

    if (retryResult.success) {
      console.log(
        chalk.green(
          `    ✓ Phase succeeded without MCP (MCP cold-start issue detected)`,
        ),
      );
      return retryResult;
    }

    // Both attempts failed - return original error for better diagnostics
    return {
      ...lastResult!,
      error: originalError,
    };
  }

  return lastResult!;
}
