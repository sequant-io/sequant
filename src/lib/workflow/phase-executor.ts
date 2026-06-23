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
import { execSync, execFileSync } from "child_process";
import { ShutdownManager } from "../shutdown.js";
import {
  Phase,
  ExecutionConfig,
  PhaseResult,
  QaVerdict,
  PhasePauseHandle,
} from "./types.js";
import type { QaSummary } from "./run-log-schema.js";
import { readAgentsMd } from "../agents-md.js";
import { getDriver } from "./drivers/index.js";
import type {
  AgentDriver,
  AgentExecutionConfig,
  AgentPhaseResult,
  ResumeHandle,
} from "./drivers/index.js";
import { classifyError } from "./error-classifier.js";
import { ApiError, BillingError } from "../errors.js";
import { phaseRegistry } from "./phase-registry.js";
import { bracketedConsoleLog } from "./notice.js";

/**
 * Determine whether a phase's session must run inside the issue worktree.
 *
 * Sourced from `phaseRegistry.get(phase).requiresWorktree` — replaces the
 * previous hardcoded `ISOLATED_PHASES` array. Phases must:
 * 1. Read/modify worktree code
 * 2. Resume a session from the same cwd it was created in (SDK constraint)
 */
function phaseRequiresWorktree(phase: Phase): boolean {
  return phaseRegistry.has(phase)
    ? phaseRegistry.get(phase).requiresWorktree
    : false;
}

/**
 * Cold-start retry threshold in seconds.
 * Failures under this duration are likely Claude Code subprocess initialization
 * issues rather than genuine phase failures (based on empirical data: cold-start
 * failures consistently complete in 15-39s vs 150-310s for real work).
 */
const COLD_START_THRESHOLD_SECONDS = 60;
const COLD_START_MAX_RETRIES = 2;

/**
 * Leading + trailing throttle. Fires the wrapped callback immediately on the
 * first call, drops subsequent calls that arrive inside `intervalMs` but
 * remembers the latest payload, and fires one final "trailing" call with that
 * latest payload after the window closes. Used to bridge the agent driver's
 * fine-grained `onOutput` stream (#543) to the TUI's `nowLine` without
 * either burning the 10 Hz snapshot budget on every chunk or losing the last
 * useful chunk before the agent goes idle.
 *
 * `cancel()` clears the pending timer + payload — call after the consuming
 * phase finishes so a residual trailing fire doesn't outlive its phase
 * context. (The orchestrator's stale-phase guard catches it anyway, but
 * cleanup avoids holding even a no-op timer.)
 *
 * @internal Exported for testing only.
 */
export function createThrottledReporter(
  fn: (text: string) => void,
  intervalMs: number,
): { report(text: string): void; cancel(): void } {
  let timer: NodeJS.Timeout | null = null;
  let pending: string | null = null;
  const report = (text: string): void => {
    if (timer) {
      // Inside the throttle window — stash the latest payload for the
      // trailing fire and drop this call.
      pending = text;
      return;
    }
    fn(text);
    timer = setTimeout(() => {
      const trailing = pending;
      pending = null;
      timer = null;
      if (trailing !== null) report(trailing);
    }, intervalMs);
    timer.unref?.();
  };
  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return { report, cancel };
}

/**
 * Spec-specific retry configuration. Sourced from the phase registry's
 * `retryStrategy` field — `phase-registry.ts` is the source of truth.
 *
 * Spec failures have a higher failure rate (~8.6%) than other phases due to
 * transient GitHub API issues and rate limits. One extra retry with backoff
 * recovers most of these without user intervention.
 *
 * Fallback literals (5000 / 1) match the legacy hardcoded values and only
 * fire if the spec registration is removed or its `retryStrategy` is unset,
 * which would be a misconfiguration. Tests pin these at 5000 / 1, so any
 * drift surfaces immediately.
 */
const SPEC_RETRY_STRATEGY = phaseRegistry.get("spec").retryStrategy;
/** @internal Exported for testing only */
export const SPEC_RETRY_BACKOFF_MS = SPEC_RETRY_STRATEGY?.backoffMs ?? 5000;
/** @internal Exported for testing only */
export const SPEC_EXTRA_RETRIES = SPEC_RETRY_STRATEGY?.extraRetries ?? 1;

export function parseQaVerdict(output: string): QaVerdict | null {
  if (!output) return null;

  // Match various verdict formats:
  // - "### Verdict: X" (markdown header)
  // - "**Verdict:** X" (bold label with colon inside)
  // - "**Verdict:** **X**" (bold label and bold value)
  // - "Verdict: X" (plain)
  // - "Verdict: ✅ X" (emoji-prefixed value — QA agents commonly write this)
  // The gap between "Verdict:" and the token tolerates any run of
  // non-alphanumeric characters (emoji, ✅/❌/⚠️, asterisks, whitespace). A
  // negated ASCII class (not an emoji literal class) keeps this ReDoS-safe and
  // avoids the no-misleading-character-class lint, matching parseQaSummary's
  // approach below. Without this, `Verdict: ✅ READY_FOR_MERGE` parsed as null
  // and a genuine PASS was recorded as "completed without a parseable verdict"
  // (live repro: `sequant run 687 --phases exec,qa`, 2026-06-01).
  // Case insensitive, handles optional markdown formatting.
  const verdictMatch = output.match(
    /(?:###?\s*)?(?:\*\*)?Verdict:?[^A-Za-z0-9_]*(READY_FOR_MERGE|AC_MET_BUT_NOT_A_PLUS|AC_NOT_MET|NEEDS_VERIFICATION)\*?\*?/i,
  );

  if (!verdictMatch) return null;

  // Normalize to uppercase with underscores
  const verdict = verdictMatch[1].toUpperCase().replace(/-/g, "_") as QaVerdict;
  return verdict;
}

/**
 * Parse condensed QA summary from QA phase output (#434).
 *
 * Handles multiple AC table formats produced by the QA skill:
 * - 5-column: | AC-N | source | desc | STATUS | notes |
 * - 4-column: | AC-N | desc | STATUS | notes |
 * - 3-column: | AC-N | desc | STATUS |
 *
 * Status cells may contain emoji prefixes (✅ MET), shorthand
 * (PARTIAL), or trailing text (MET — explanation).
 *
 * @internal Exported for testing only
 */
export function parseQaSummary(output: string): QaSummary | null {
  if (!output) return null;

  // Anchored pattern: cell content starts with optional emoji, then status keyword
  // Uses alternation (not character class) to avoid ESLint no-misleading-character-class
  const STATUS_CELL =
    /^(?:\u2705|\u274C|\u26A0\uFE0F|\u2B50|\u2139\uFE0F|\u2753|\u2757)?\s*(MET|NOT_MET|PARTIALLY_MET|PARTIAL|PENDING|N\/A)\b/i;

  const lines = output.split("\n");
  const acRows = lines.filter((line) => /^\s*\|\s*\*?\*?AC-\d+/.test(line));

  if (acRows.length === 0) return null;

  let acMet = 0;
  let acTotal = 0;

  for (const row of acRows) {
    const cells = row
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);

    // Scan cells right-to-left to find the status cell
    let found = false;
    for (let i = cells.length - 1; i >= 1; i--) {
      const match = cells[i].match(STATUS_CELL);
      if (match) {
        const status = match[1].toUpperCase();
        acTotal++;
        if (status === "MET") acMet++;
        found = true;
        break;
      }
    }
    // Row with AC-N but no parseable status is skipped
    if (!found) continue;
  }

  if (acTotal === 0) return null;

  const gaps = parseListSection(output, /\*\*(?:Issues|Gaps)/);
  const suggestions = parseListSection(output, /\*\*Suggestions/);

  return { acMet, acTotal, gaps, suggestions };
}

/**
 * Parse a markdown bullet list section, filtering out "None" variants.
 */
function parseListSection(output: string, headerPattern: RegExp): string[] {
  const items: string[] = [];
  const lines = output.split("\n");

  let inSection = false;
  for (const line of lines) {
    if (headerPattern.test(line)) {
      // If the header line itself contains a bullet (inline), capture it
      inSection = true;
      continue;
    }

    if (inSection) {
      // Section ends at next markdown header or bold label
      if (/^#{1,4}\s/.test(line) || /^\*\*[^*]+\*\*:/.test(line)) {
        break;
      }

      const bulletMatch = line.match(/^\s*[-*]\s+(.+)/);
      if (bulletMatch) {
        const trimmed = bulletMatch[1].trim();
        // Filter "None", "None found", "None — text", etc.
        if (trimmed && !/^None\b/i.test(trimmed)) {
          items.push(trimmed);
        }
      } else if (line.trim() === "") {
        continue;
      } else {
        break;
      }
    }
  }

  return items;
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
 * Resolve the base ref the zero-diff guard should compare against for
 * this worktree.
 *
 * Reads `branch.<current>.sequantBase` — written by `scripts/new-feature.sh`
 * when a worktree is created with `--base <branch>`. Returns `origin/<base>`
 * (prepending `origin/` only when the recorded value does not already
 * reference a remote). Falls back to `"origin/main"` on missing config,
 * missing branch, or any git error — preserves the pre-#537 behavior
 * for worktrees that predate this change or are managed outside
 * `new-feature.sh`.
 *
 * Uses `execFileSync` (not `execSync`) so argv is passed directly to
 * `execve` without shell interpretation — the recorded value originates
 * from the user-supplied `--base` CLI flag, and shell-interpolating it
 * would open a shell-injection vector. With `execFileSync`, a malicious
 * value is at worst treated as an invalid revspec by git (triggering
 * the fail-open path), never executed as shell.
 *
 * @internal Exported for testing only.
 */
export function resolveBaseRef(cwd: string): string {
  const fallback = "origin/main";
  let branch: string;
  try {
    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdio: "pipe",
    })
      .toString()
      .trim();
  } catch {
    return fallback;
  }
  // Guard against multi-line output (paranoid — should never happen) and
  // the detached-HEAD case where we have no recorded base to look up.
  if (!branch || branch === "HEAD" || branch.includes("\n")) return fallback;
  let recorded: string;
  try {
    recorded = execFileSync(
      "git",
      ["config", "--get", `branch.${branch}.sequantBase`],
      { cwd, stdio: "pipe" },
    )
      .toString()
      .trim();
  } catch {
    return fallback;
  }
  if (!recorded || recorded.includes("\n")) return fallback;
  return recorded.startsWith("origin/") ? recorded : `origin/${recorded}`;
}

/**
 * Check whether the exec phase produced any changes in the worktree.
 * Returns true if HEAD has commits unique to it relative to the resolved
 * base ref (see {@link resolveBaseRef}) OR uncommitted work is present.
 *
 * Uses `git rev-list --count <base>..HEAD` (commits reachable from HEAD
 * but not the base) instead of `git diff <base>..HEAD`, because the
 * two-dot diff also fires in reverse when the base has advanced past HEAD
 * — on stale branches that would falsely report "has commits" even when the
 * exec phase produced nothing, reintroducing the bug #534 is fixing.
 *
 * The base ref defaults to `origin/main` but is overridden to the worktree's
 * recorded base (see #537) so zero-diff execs are still detected on
 * custom-base worktrees (e.g. those created with `--base feature/epic`).
 *
 * Fails open (returns true) on git errors — a missing origin ref is better
 * diagnosed as a real zero-diff run than as a false phase failure.
 *
 * @internal Exported for testing only.
 */
export function hasExecChanges(cwd: string): boolean {
  const baseRef = resolveBaseRef(cwd);
  let commitsAhead: boolean;
  try {
    const count = execFileSync(
      "git",
      ["rev-list", "--count", `${baseRef}..HEAD`],
      { cwd, stdio: "pipe" },
    )
      .toString()
      .trim();
    commitsAhead = Number.parseInt(count, 10) > 0;
  } catch {
    return true;
  }
  if (commitsAhead) return true;
  try {
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      stdio: "pipe",
    })
      .toString()
      .trim();
    return porcelain.length > 0;
  } catch {
    return true;
  }
}

/**
 * Map a successful AgentPhaseResult to a PhaseResult, applying phase-specific
 * guards that catch agent sessions which returned success without producing
 * usable work (#534):
 *
 * - `qa`: fails when no parseable verdict is found (empty or malformed output).
 * - `exec`: fails when no commits and no uncommitted changes exist.
 *
 * @internal Exported for testing only.
 */
export function mapAgentSuccessToPhaseResult(
  phase: Phase,
  agentResult: AgentPhaseResult,
  durationSeconds: number,
  cwd: string,
): PhaseResult & { sessionId?: string; resumeHandle?: ResumeHandle } {
  const tails = {
    stderrTail: agentResult.stderrTail,
    stdoutTail: agentResult.stdoutTail,
    exitCode: agentResult.exitCode,
  };
  const resume = {
    sessionId: agentResult.sessionId,
    resumeHandle: agentResult.resumeHandle,
  };

  if (phase === "qa") {
    const verdict = agentResult.output
      ? parseQaVerdict(agentResult.output)
      : null;
    const summary = agentResult.output
      ? (parseQaSummary(agentResult.output) ?? undefined)
      : undefined;
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
        ...resume,
        output: agentResult.output,
        verdict,
        summary,
        ...tails,
      };
    }
    if (!verdict) {
      // #534: a null verdict (empty or unparseable output) is not success.
      return {
        phase,
        success: false,
        durationSeconds,
        error: "QA completed without a parseable verdict",
        ...resume,
        output: agentResult.output,
        summary,
        ...tails,
      };
    }
    return {
      phase,
      success: true,
      durationSeconds,
      ...resume,
      output: agentResult.output,
      verdict,
      summary,
      ...tails,
    };
  }

  if (phase === "exec" && !hasExecChanges(cwd)) {
    // #534: an exec phase that produced nothing is not success.
    return {
      phase,
      success: false,
      durationSeconds,
      error: "exec produced no changes (no commits, no uncommitted work)",
      ...resume,
      output: agentResult.output,
      ...tails,
    };
  }

  return {
    phase,
    success: true,
    durationSeconds,
    ...resume,
    output: agentResult.output,
    ...tails,
  };
}

/**
 * Map a failed driver result to a `PhaseResult`.
 *
 * Symmetric to {@link mapAgentSuccessToPhaseResult}; extracted so the
 * failure-path mapping (notably the #739 capped/output gating) is unit-testable
 * without spawning a driver.
 *
 * `output` is propagated **only** for a capped phase (#739): a capped result is
 * incomplete-but-not-hard-failed, so its partial work must survive downstream.
 * A genuine (non-capped) failure keeps the historical behaviour of dropping
 * `output`, leaving the `/loop` fix-context (`formatFailureContext`) unchanged.
 *
 * @internal Exported for testing only
 */
export function mapAgentFailureToPhaseResult(
  phase: Phase,
  agentResult: AgentPhaseResult,
  durationSeconds: number,
): PhaseResult & { sessionId?: string; resumeHandle?: ResumeHandle } {
  return {
    phase,
    success: false,
    durationSeconds,
    error: agentResult.error,
    // Propagate the driver's typed cause (#732) so the retry logic can prefer
    // it over stderr-regex classification and gate the MCP fallback.
    structuredError: agentResult.structuredError,
    // Propagate the turn-cap flag and the partial output (#739). On the failure
    // path `output` was previously dropped entirely — for a capped phase the
    // partial work is usable and must be preserved, mirroring the driver/skill
    // slice from #733. Gating `output` on `capped` keeps non-capped failures
    // byte-for-byte identical to pre-#739 behaviour.
    capped: agentResult.capped,
    output: agentResult.capped ? agentResult.output : undefined,
    sessionId: agentResult.sessionId,
    resumeHandle: agentResult.resumeHandle,
    stderrTail: agentResult.stderrTail,
    stdoutTail: agentResult.stdoutTail,
    exitCode: agentResult.exitCode,
  };
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
  promptContext?: string,
): Promise<string> {
  const definition = phaseRegistry.get(phase);
  // Non-claude drivers consult driverOverrides[<driver>] first; fall back to
  // the default promptTemplate when no override is registered for the driver.
  const driverPrompt =
    agent && agent !== "claude-code"
      ? definition.driverOverrides?.[agent]?.promptTemplate
      : undefined;
  const template = driverPrompt ?? definition.promptTemplate;
  let basePrompt = template.replace(/\{issue\}/g, String(issueNumber));

  // Append phase-specific context (e.g., QA findings for loop phase)
  if (promptContext) {
    basePrompt += `\n\n---\n\n${promptContext}`;
  }

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
  resumeHandle?: ResumeHandle,
  worktreePath?: string,
  shutdownManager?: ShutdownManager,
  spinner?: PhasePauseHandle,
): Promise<PhaseResult & { sessionId?: string; resumeHandle?: ResumeHandle }> {
  const startTime = Date.now();

  const prompt = await getPhasePrompt(
    phase,
    issueNumber,
    config.agent,
    config.promptContext,
  );

  if (config.dryRun) {
    // Dry run - show the prompt that would be sent, then return
    if (config.verbose) {
      bracketedConsoleLog(
        spinner,
        chalk.gray(`    Would execute: /${phase} ${issueNumber}`),
      );
      bracketedConsoleLog(spinner, chalk.gray(`    Prompt: ${prompt}`));
    }
    return {
      phase,
      success: true,
      durationSeconds: 0,
      output: prompt,
    };
  }

  if (config.verbose) {
    bracketedConsoleLog(spinner, chalk.gray(`    Prompt: ${prompt}`));
    if (worktreePath && phaseRequiresWorktree(phase)) {
      bracketedConsoleLog(spinner, chalk.gray(`    Worktree: ${worktreePath}`));
    }
  }

  // Determine working directory and environment
  const shouldUseWorktree = worktreePath && phaseRequiresWorktree(phase);
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

  // #683: force full-weight QA. `sequant ready` sets config.fullQa so its QA
  // pass runs the standalone branch-freshness / process-state pre-flight checks
  // even though SEQUANT_ORCHESTRATOR is set unconditionally above. Scoped to the
  // qa phase — the loop/exec phases don't have a git-trust skip to override.
  if (config.fullQa && phase === "qa") {
    env.SEQUANT_FULL_QA = "1";
  }

  // Propagate issue type for skills to adapt behavior (e.g., lighter QA for docs)
  if (config.issueType) {
    env.SEQUANT_ISSUE_TYPE = config.issueType;
  }

  // Pass QA context to loop phase so it doesn't need to reconstruct from GitHub (#488)
  if (config.lastVerdict) {
    env.SEQUANT_LAST_VERDICT = config.lastVerdict;
  }
  if (config.failedAcs) {
    env.SEQUANT_FAILED_ACS = config.failedAcs;
  }

  // Propagate parallel isolation mode to exec skill (#485)
  if (config.isolateParallel) {
    env.SEQUANT_ISOLATE_PARALLEL = "true";
  }

  // Activate interactive relay (#383) unless explicitly disabled.
  // `relay-check.sh` (sourced from post-tool.sh) reads this env var on every
  // tool call. Disabled by default in non-interactive scenarios — controlled
  // via `settings.run.relay` (true by default).
  if (config.relayEnabled) {
    env.SEQUANT_RELAY = "true";
    try {
      const { resolveBundledFramePath } =
        await import("../relay/activation.js");
      const framePath = resolveBundledFramePath();
      if (framePath) env.SEQUANT_RELAY_FRAME = framePath;
    } catch {
      /* relay module unavailable — fall back to bash's search heuristic. */
    }
  }

  // Track whether we're actively streaming verbose output
  // Pausing spinner once per streaming session prevents truncation from rapid pause/resume cycles
  // (Issue #283: ora's stop() clears the current line, which can truncate output when
  // pause/resume is called for every chunk in rapid succession)
  let verboseStreamingActive = false;

  // Activity ping throttle (#543): the agent driver streams text in many small
  // chunks; the TUI only polls at 10 Hz. Coalesce to ≤2 calls per ~100ms
  // window (leading + trailing) so we don't burn the poll budget on snapshot
  // churn but still surface the latest chunk before the agent goes idle.
  const ACTIVITY_THROTTLE_MS = 100;
  const onActivity = config.onActivity;
  const throttle = onActivity
    ? createThrottledReporter((text: string) => {
        try {
          onActivity(text);
        } catch {
          // Activity reporting must never disrupt the run.
        }
      }, ACTIVITY_THROTTLE_MS)
    : undefined;
  const reportActivity = throttle ? throttle.report : undefined;

  // Resolve driver before the resume check — eligibility is now driver-owned
  // (#674). Each driver's `canResume(handle, cwd)` enforces its own contract:
  // Claude Code requires byte-equal cwd match (session storage is
  // cwd-namespaced); Aider declines all resume (no session concept); Codex
  // (when added in #497) folds in AGENTS.md parity. Replacing the prior
  // `sessionId && !worktreePath` heuristic also unblocks same-worktree resume
  // across phases.
  const driver: AgentDriver = getDriver(config.agent, {
    aiderSettings: config.aiderSettings,
  });

  const eligibleHandle =
    resumeHandle && driver.canResume(resumeHandle, cwd)
      ? resumeHandle
      : undefined;

  // Build AgentExecutionConfig for the driver
  const agentConfig: AgentExecutionConfig = {
    cwd,
    env,
    abortSignal: abortController.signal,
    phaseTimeout: config.phaseTimeout,
    verbose: config.verbose,
    mcp: config.mcp,
    resumeHandle: eligibleHandle,
    sessionId: eligibleHandle?.token,
    files,
    onOutput:
      config.verbose || reportActivity
        ? (text: string) => {
            if (config.verbose) {
              if (!verboseStreamingActive) {
                spinner?.pause();
                verboseStreamingActive = true;
              }
              // eslint-disable-next-line no-restricted-syntax -- spinner is paused above; verbose subprocess streaming bypasses log-update intentionally.
              process.stdout.write(chalk.gray(text));
            }
            reportActivity?.(text);
          }
        : undefined,
    onStderr: config.verbose
      ? (data: string) => {
          if (!verboseStreamingActive) {
            spinner?.pause();
            verboseStreamingActive = true;
          }
          // eslint-disable-next-line no-restricted-syntax -- spinner is paused above; verbose subprocess streaming bypasses log-update intentionally.
          process.stderr.write(chalk.red(data));
        }
      : undefined,
  };

  const agentResult = await driver.executePhase(prompt, agentConfig);

  // Cancel any pending trailing activity fire — phase is done; the
  // orchestrator's stale-phase guard would no-op a late call anyway, but
  // clearing the timer is cheaper than letting it elapse.
  throttle?.cancel();

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

  if (agentResult.success) {
    return mapAgentSuccessToPhaseResult(
      phase,
      agentResult,
      durationSeconds,
      cwd,
    );
  }

  return mapAgentFailureToPhaseResult(phase, agentResult, durationSeconds);
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
  resumeHandle?: ResumeHandle,
  worktreePath?: string,
  shutdownManager?: ShutdownManager,
  spinner?: PhasePauseHandle,
  /** @internal Injected for testing — defaults to module-level executePhase */
  executePhaseFn: typeof executePhase = executePhase,
  /** @internal Injected for testing — defaults to setTimeout-based delay */
  delayFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<PhaseResult & { sessionId?: string; resumeHandle?: ResumeHandle }> {
  // Skip retry logic if explicitly disabled
  if (config.retry === false) {
    return executePhaseFn(
      issueNumber,
      phase,
      config,
      resumeHandle,
      worktreePath,
      shutdownManager,
      spinner,
    );
  }

  // Skip cold-start retries for phases registered with `retryStrategy.maxRetries: 0`.
  // `loop` is the canonical user (#488) — it's always a re-run after a failed QA,
  // never a first boot. Failures at 47-51s are genuine skill failures, not cold-start
  // issues. Without this guard, 2 cold-start retries + 1 MCP fallback = 3 wasted
  // spawns per loop. Sourcing the decision from the registry makes the rule
  // data-driven — any future phase registered with `maxRetries: 0` inherits the
  // same behavior without a code change here.
  const skipColdStartRetry =
    phaseRegistry.has(phase) &&
    phaseRegistry.get(phase).retryStrategy?.maxRetries === 0;

  let lastResult: PhaseResult & {
    sessionId?: string;
    resumeHandle?: ResumeHandle;
  };

  if (skipColdStartRetry) {
    // Single attempt — no cold-start retry loop
    lastResult = await executePhaseFn(
      issueNumber,
      phase,
      config,
      resumeHandle,
      worktreePath,
      shutdownManager,
      spinner,
    );

    if (lastResult.success) {
      return lastResult;
    }

    // Turn-capped phase (#739): incomplete-but-not-hard-failed. A retry cannot
    // un-cap a turn limit, so short-circuit before any fallback — same rationale
    // as the billing skip (#732), but capped must skip *all* retries (incl.
    // cold-start), so an explicit early return is required, not just a guard
    // flag at the MCP gate.
    if (lastResult.capped) {
      return lastResult;
    }
  } else {
    // Phase 1: Cold-start retry attempts (with MCP enabled if configured)
    for (let attempt = 0; attempt <= COLD_START_MAX_RETRIES; attempt++) {
      lastResult = await executePhaseFn(
        issueNumber,
        phase,
        config,
        resumeHandle,
        worktreePath,
        shutdownManager,
        spinner,
      );

      const duration = lastResult.durationSeconds ?? 0;

      // Success → return immediately
      if (lastResult.success) {
        return lastResult;
      }

      // Turn-capped phase (#739): short-circuit before cold-start retries, the
      // MCP fallback, and the spec-extra retry — a retry cannot un-cap a turn
      // limit. The early return here (rather than a guard at the MCP gate alone)
      // is what skips the cold-start re-spawns, unlike the billing case which
      // still cold-start-retries in the <60s window.
      if (lastResult.capped) {
        return lastResult;
      }

      // Genuine failure (took long enough to be real work) → skip cold-start retries.
      // Use error classification (AC-9): if the error is retryable (e.g., API
      // rate limit, transient 503), allow one more attempt even for genuine failures.
      if (duration >= COLD_START_THRESHOLD_SECONDS) {
        // Prefer the driver's structured cause (#732) — it reflects the real
        // SDK rate-limit/billing signal — over stderr-regex classification,
        // which only sees text and never the structured data.
        const typedError =
          lastResult.structuredError ??
          classifyError(lastResult.stderrTail ?? [], lastResult.exitCode);
        if (typedError.isRetryable && attempt < COLD_START_MAX_RETRIES) {
          if (config.verbose) {
            const label =
              typedError instanceof ApiError
                ? `API error (status ${typedError.metadata.statusCode ?? "unknown"})`
                : typedError.name;
            bracketedConsoleLog(
              spinner,
              chalk.yellow(
                `\n    ⟳ Retryable error: ${label}, retrying... (attempt ${attempt + 2}/${COLD_START_MAX_RETRIES + 1})`,
              ),
            );
          }
          continue;
        }
        if (phase === "spec") {
          break;
        }
        return lastResult;
      }

      // Cold-start failure detected — retry
      if (attempt < COLD_START_MAX_RETRIES) {
        if (config.verbose) {
          bracketedConsoleLog(
            spinner,
            chalk.yellow(
              `\n    ⟳ Cold-start failure detected (${duration.toFixed(1)}s), retrying... (attempt ${attempt + 2}/${COLD_START_MAX_RETRIES + 1})`,
            ),
          );
        }
      }
    }
  }

  // Capture the original error for better diagnostics
  const originalError = lastResult!.error;

  // Phase 2: MCP fallback - if MCP is enabled and we're still failing, try without MCP
  // This handles npx-based MCP servers that fail on first run due to cold-cache issues.
  // Skip for `loop` phase — MCP is never the cause of loop failures (#488).
  //
  // Also skip when the failure is a billing/credits error (#732): a no-MCP
  // retry cannot refill credits, so the misleading "retrying without MCP"
  // noise (#592) would only mask the real cause. The accurate structured
  // message (e.g. "Out of credits") is surfaced instead.
  const failureIsBilling = lastResult!.structuredError instanceof BillingError;
  // Belt-and-suspenders (#739): the capped early-returns above already exit
  // before reaching here, but gate the MCP fallback on `!failureIsCapped` too so
  // intent is documented and future code paths can't accidentally re-spawn a
  // capped phase without MCP.
  const failureIsCapped = lastResult!.capped === true;
  if (
    config.mcp &&
    !lastResult!.success &&
    !skipColdStartRetry &&
    !failureIsBilling &&
    !failureIsCapped
  ) {
    bracketedConsoleLog(
      spinner,
      chalk.yellow(
        `\n    ! Phase failed with MCP enabled, retrying without MCP...`,
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
      resumeHandle,
      worktreePath,
      shutdownManager,
      spinner,
    );

    if (retryResult.success) {
      bracketedConsoleLog(
        spinner,
        chalk.green(
          `    ✓ Phase succeeded without MCP (MCP cold-start issue detected)`,
        ),
      );
      return retryResult;
    }

    // Update lastResult for Phase 3 (spec retry)
    lastResult = retryResult;

    // Non-spec phases: return original error after MCP fallback exhausted
    if (phase !== "spec") {
      return {
        ...lastResult!,
        error: originalError,
      };
    }
  }

  // Phase 3: Spec-specific retry — spec has a higher transient failure rate
  // than other phases (~8.6%), so one extra retry with backoff recovers most cases.
  if (phase === "spec" && !lastResult!.success) {
    for (let i = 0; i < SPEC_EXTRA_RETRIES; i++) {
      bracketedConsoleLog(
        spinner,
        chalk.yellow(
          `\n    ⟳ Spec phase failed, retrying with ${SPEC_RETRY_BACKOFF_MS}ms backoff... (spec retry ${i + 1}/${SPEC_EXTRA_RETRIES})`,
        ),
      );

      await delayFn(SPEC_RETRY_BACKOFF_MS);

      const specRetryResult = await executePhaseFn(
        issueNumber,
        phase,
        config,
        resumeHandle,
        worktreePath,
        shutdownManager,
        spinner,
      );

      if (specRetryResult.success) {
        bracketedConsoleLog(
          spinner,
          chalk.green(`    ✓ Spec phase succeeded on retry`),
        );
        return specRetryResult;
      }

      lastResult = specRetryResult;
    }

    // All spec retries exhausted — return with original error for diagnostics
    return {
      ...lastResult!,
      error: originalError,
    };
  }

  return lastResult!;
}
