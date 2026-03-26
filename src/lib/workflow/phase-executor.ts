/**
 * Phase execution engine for workflow orchestration.
 *
 * Handles executing individual phases via an AgentDriver interface,
 * including cold-start retry logic and MCP fallback strategies.
 *
 * The SDK import has been moved to ClaudeCodeDriver — this module
 * is agent-agnostic.
 */

import chalk from "chalk";
import { execSync } from "child_process";
import { ShutdownManager } from "../shutdown.js";
import { PhaseSpinner } from "../phase-spinner.js";
import { Phase, ExecutionConfig, PhaseResult, QaVerdict } from "./types.js";
import { readAgentsMd } from "../agents-md.js";
import { getDriver } from "./drivers/index.js";
import type { AgentDriver, AgentExecutionConfig } from "./drivers/index.js";

/**
 * Natural language prompts for each phase.
 * Claude Code invokes the corresponding skills via natural language.
 */
const PHASE_PROMPTS: Record<Phase, string> = {
  spec: "Review GitHub issue #{issue} and create an implementation plan with verification criteria. Run the /spec {issue} workflow.",
  "security-review":
    "Perform a deep security analysis for GitHub issue #{issue} focusing on auth, permissions, and sensitive operations. Run the /security-review {issue} workflow.",
  testgen:
    "Generate test stubs for GitHub issue #{issue} based on the specification. Run the /testgen {issue} workflow.",
  exec: "Implement the feature for GitHub issue #{issue} following the spec. Run the /exec {issue} workflow.",
  test: "Execute structured browser-based testing for GitHub issue #{issue}. Run the /test {issue} workflow.",
  verify:
    "Verify the implementation for GitHub issue #{issue} by running commands and capturing output. Run the /verify {issue} workflow.",
  qa: "Review the implementation for GitHub issue #{issue} against acceptance criteria. Run the /qa {issue} workflow.",
  loop: "Parse test/QA findings for GitHub issue #{issue} and iterate until quality gates pass. Run the /loop {issue} workflow.",
  merger:
    "Integrate and merge completed worktrees for GitHub issue #{issue}. Run the /merger {issue} workflow.",
};

/**
 * Self-contained prompts for non-Claude agents (Aider, Codex, etc.).
 * These agents don't have a skill system, so prompts must include
 * full instructions rather than skill invocations.
 */
const AIDER_PHASE_PROMPTS: Record<Phase, string> = {
  spec: `Read GitHub issue #{issue} using 'gh issue view #{issue}'.
Create a spec comment on the issue with:
1. Implementation plan
2. Acceptance criteria as a checklist
3. Risk assessment
Post the comment using 'gh issue comment #{issue} --body "<comment>"'.`,
  "security-review": `Perform a security review for GitHub issue #{issue}.
Read the issue with 'gh issue view #{issue}'.
Check for auth, permissions, injection, and sensitive data issues.
Post findings as a comment on the issue.`,
  testgen: `Generate test stubs for GitHub issue #{issue}.
Read the spec comments on the issue with 'gh issue view #{issue} --comments'.
Create test files with describe/it blocks covering the acceptance criteria.
Use the project's existing test framework.`,
  exec: `Implement the feature described in GitHub issue #{issue}.
Read the issue and any spec comments with 'gh issue view #{issue} --comments'.
Follow the implementation plan from the spec.
Write tests for new functionality.
Ensure the build passes with 'npm test' and 'npm run build'.`,
  test: `Test the implementation for GitHub issue #{issue}.
Run 'npm test' and verify all tests pass.
Check for edge cases and error handling.`,
  verify: `Verify the implementation for GitHub issue #{issue}.
Run relevant commands and capture their output for review.`,
  qa: `Review the changes for GitHub issue #{issue}.
Run 'npm test' and 'npm run build' to verify everything works.
Check each acceptance criterion from the issue comments.
Output a verdict: READY_FOR_MERGE, AC_MET_BUT_NOT_A_PLUS, or AC_NOT_MET
with format "### Verdict: <VERDICT>" followed by an explanation.`,
  loop: `Review test and QA findings for GitHub issue #{issue}.
Fix any issues identified in the QA feedback.
Re-run 'npm test' and 'npm run build' until all quality gates pass.`,
  merger: `Integrate and merge completed worktrees for GitHub issue #{issue}.
Ensure all branches are up to date and merge cleanly.`,
};

/**
 * Phases that require worktree isolation.
 * Only `spec` runs in the main repo (planning-only, no file changes).
 * All other phases must run in the worktree because:
 * 1. They need to read/modify the worktree code
 * 2. Resuming a session created in a different cwd crashes the SDK
 */
const ISOLATED_PHASES: Phase[] = [
  "exec",
  "security-review",
  "testgen",
  "test",
  "qa",
  "loop",
];

/**
 * Cold-start retry threshold in seconds.
 * Failures under this duration are likely Claude Code subprocess initialization
 * issues rather than genuine phase failures (based on empirical data: cold-start
 * failures consistently complete in 15-39s vs 150-310s for real work).
 */
const COLD_START_THRESHOLD_SECONDS = 60;
const COLD_START_MAX_RETRIES = 2;

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
 * Get the prompt for a phase with the issue number substituted.
 * Selects self-contained prompts for non-Claude agents.
 * Includes AGENTS.md content as context so non-Claude agents
 * receive project conventions and workflow instructions.
 *
 * @internal Exported for testing only
 */
export async function getPhasePrompt(
  phase: Phase,
  issueNumber: number,
  agent?: string,
): Promise<string> {
  const prompts =
    agent && agent !== "claude-code" ? AIDER_PHASE_PROMPTS : PHASE_PROMPTS;
  const basePrompt = prompts[phase].replace(/\{issue\}/g, String(issueNumber));

  // Include AGENTS.md content in the prompt context for non-Claude agent compatibility.
  // Claude reads CLAUDE.md natively, but other agents (Aider, Codex, Gemini CLI)
  // rely on AGENTS.md for project context.
  const agentsMd = await readAgentsMd();
  if (agentsMd) {
    return `Project context (from AGENTS.md):\n\n${agentsMd}\n\n---\n\n${basePrompt}`;
  }

  return basePrompt;
}

/**
 * Execute a single phase for an issue using the configured AgentDriver.
 */
async function executePhase(
  issueNumber: number,
  phase: Phase,
  config: ExecutionConfig,
  sessionId?: string,
  worktreePath?: string,
  shutdownManager?: ShutdownManager,
  spinner?: PhaseSpinner,
): Promise<PhaseResult & { sessionId?: string }> {
  const startTime = Date.now();

  const prompt = await getPhasePrompt(phase, issueNumber, config.agent);

  if (config.dryRun) {
    // Dry run - show the prompt that would be sent, then return
    if (config.verbose) {
      console.log(chalk.gray(`    Would execute: /${phase} ${issueNumber}`));
      console.log(chalk.gray(`    Prompt: ${prompt}`));
    }
    return {
      phase,
      success: true,
      durationSeconds: 0,
      output: prompt,
    };
  }

  if (config.verbose) {
    console.log(chalk.gray(`    Prompt: ${prompt}`));
    if (worktreePath && ISOLATED_PHASES.includes(phase)) {
      console.log(chalk.gray(`    Worktree: ${worktreePath}`));
    }
  }

  // Determine working directory and environment
  const shouldUseWorktree = worktreePath && ISOLATED_PHASES.includes(phase);
  const cwd = shouldUseWorktree ? worktreePath : process.cwd();

  // Resolve file context for file-oriented drivers (e.g., Aider --file)
  let files: string[] | undefined;
  if (config.agent && config.agent !== "claude-code") {
    try {
      const output = execSync("git diff --name-only main...HEAD", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (output) {
        files = output.split("\n").filter(Boolean);
      }
    } catch {
      // No changed files or git error — proceed without file context
    }
  }

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
  // Uses add/remove to support concurrent phase execution (#404)
  if (shutdownManager) {
    shutdownManager.addAbortController(abortController);
  }

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

  // Propagate issue type for skills to adapt behavior (e.g., lighter QA for docs)
  if (config.issueType) {
    env.SEQUANT_ISSUE_TYPE = config.issueType;
  }

  // Track whether we're actively streaming verbose output
  // Pausing spinner once per streaming session prevents truncation from rapid pause/resume cycles
  // (Issue #283: ora's stop() clears the current line, which can truncate output when
  // pause/resume is called for every chunk in rapid succession)
  let verboseStreamingActive = false;

  // Safety: never resume a session when worktree isolation is active.
  // Even if THIS phase doesn't use the worktree, a previous phase may have
  // created the session there. Resuming from a different cwd crashes the SDK
  // (exit code 1). ISOLATED_PHASES prevents this by design, but this guard
  // catches edge cases (e.g. a new phase added without updating ISOLATED_PHASES).
  const canResume = sessionId && !worktreePath;

  // Build AgentExecutionConfig for the driver
  const agentConfig: AgentExecutionConfig = {
    cwd,
    env,
    abortSignal: abortController.signal,
    phaseTimeout: config.phaseTimeout,
    verbose: config.verbose,
    mcp: config.mcp,
    sessionId: canResume ? sessionId : undefined,
    files,
    onOutput: config.verbose
      ? (text: string) => {
          if (!verboseStreamingActive) {
            spinner?.pause();
            verboseStreamingActive = true;
          }
          process.stdout.write(chalk.gray(text));
        }
      : undefined,
    onStderr: config.verbose
      ? (data: string) => {
          if (!verboseStreamingActive) {
            spinner?.pause();
            verboseStreamingActive = true;
          }
          process.stderr.write(chalk.red(data));
        }
      : undefined,
  };

  // Resolve driver from config or default
  const driver: AgentDriver = getDriver(config.agent, {
    aiderSettings: config.aiderSettings,
  });

  const agentResult = await driver.executePhase(prompt, agentConfig);

  // Resume spinner after execution completes (if we paused it)
  if (verboseStreamingActive) {
    spinner?.resume();
  }

  clearTimeout(timeoutId);

  // Remove this specific abort controller from shutdown manager
  if (shutdownManager) {
    shutdownManager.removeAbortController(abortController);
  }

  const durationSeconds = (Date.now() - startTime) / 1000;

  // Map AgentPhaseResult to PhaseResult
  if (agentResult.success) {
    // For QA phase, check the verdict to determine actual success
    // Agent "success" just means the execution completed — we need to parse the verdict
    if (phase === "qa" && agentResult.output) {
      const verdict = parseQaVerdict(agentResult.output);
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
          sessionId: agentResult.sessionId,
          output: agentResult.output,
          verdict,
        };
      }
      return {
        phase,
        success: true,
        durationSeconds,
        sessionId: agentResult.sessionId,
        output: agentResult.output,
        verdict: verdict ?? undefined,
      };
    }

    return {
      phase,
      success: true,
      durationSeconds,
      sessionId: agentResult.sessionId,
      output: agentResult.output,
    };
  }

  return {
    phase,
    success: false,
    durationSeconds,
    error: agentResult.error,
    sessionId: agentResult.sessionId,
  };
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
