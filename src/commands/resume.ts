/**
 * sequant resume — re-enter runs halted on a waitable rate-limit window
 * (#892).
 *
 * The durable counterpart to `--auto-wait` (#804): when a run halts on an
 * exhausted `five_hour`/`seven_day` window (#860 classification), the halt
 * path writes `windowHalt.resumeAt` to issue state and exits cleanly with the
 * per-issue lock released. This command is the re-entry: a no-op before
 * `resumeAt` (clear message, exit 0 — safe to invoke from cron/launchd every
 * few minutes), and after `resumeAt` it re-runs the halted issues through the
 * normal `sequant run` path with `--resume` semantics, so completed phases
 * (GitHub markers) and completed issues (#837 state guard) are skipped.
 *
 * Re-entries are bounded per issue by {@link MAX_RESUME_REENTRIES} (AC-3), so
 * a window that never reopens cannot ping-pong a scheduler: the bound halts
 * with the same labeled terminal message a spent auto-wait produces today.
 */

import chalk from "chalk";
import { StateManager } from "../lib/workflow/state-manager.js";
import { MAX_RESUME_REENTRIES } from "../lib/workflow/state-schema.js";
import type { IssueState } from "../lib/workflow/state-schema.js";
import { isCompletedIssueStatus } from "../lib/workflow/completed-status.js";
import { formatResetTime } from "../lib/errors.js";
import type { RunOptions } from "../lib/workflow/types.js";
import { runCommand } from "./run.js";

// Re-exported for callers that treat the resume command as the feature's
// entry point; the constant itself lives beside the schema field it bounds.
export { MAX_RESUME_REENTRIES };

/** One resumable (or not-yet / exhausted) issue in a {@link ResumePlan}. */
export interface ResumeCandidate {
  issueNumber: number;
  /** ISO timestamp after which re-entry can proceed. */
  resumeAt: string;
  /** Phase that halted. */
  phase: string;
  /** Re-entry attempts already consumed. */
  reentries: number;
}

/**
 * Partition of halted issues by what `sequant resume` should do with them.
 * Pure data — computed by {@link planResume}, rendered/acted on by the
 * command shell.
 */
export interface ResumePlan {
  /** Past `resumeAt` and under the re-entry bound: re-run these. */
  due: ResumeCandidate[];
  /** Before `resumeAt`: report and exit 0 (AC-2 no-op contract). */
  notYet: ResumeCandidate[];
  /** Re-entry bound consumed (AC-3): terminal, needs human attention. */
  exhausted: ResumeCandidate[];
}

/**
 * Decide what to do with every halted issue (#892 AC-2/AC-3).
 *
 * Pure so the before/after-`resumeAt` and bound edges are unit-testable with
 * an injected clock. Issues whose persisted status is already completed
 * (#837 vocabulary) are excluded even if a stale `windowHalt` survived — the
 * run path would skip them anyway, so re-entering buys nothing.
 *
 * @param states     All persisted issue states.
 * @param requested  Restrict to these issue numbers (empty = all halted).
 * @param now        Epoch ms clock, injectable for tests.
 */
export function planResume(
  states: Record<number, IssueState>,
  requested: number[],
  now: number,
): ResumePlan {
  const plan: ResumePlan = { due: [], notYet: [], exhausted: [] };
  const requestedSet = new Set(requested);

  for (const [key, state] of Object.entries(states)) {
    const issueNumber = Number(key);
    if (requested.length > 0 && !requestedSet.has(issueNumber)) continue;
    if (!state.windowHalt) continue;
    if (isCompletedIssueStatus(state.status)) continue;

    const candidate: ResumeCandidate = {
      issueNumber,
      resumeAt: state.windowHalt.resumeAt,
      phase: state.windowHalt.phase,
      reentries: state.windowHalt.reentries,
    };

    if (candidate.reentries >= MAX_RESUME_REENTRIES) {
      plan.exhausted.push(candidate);
    } else if (new Date(candidate.resumeAt).getTime() > now) {
      plan.notYet.push(candidate);
    } else {
      plan.due.push(candidate);
    }
  }

  // Deterministic output order regardless of state-file key order.
  for (const bucket of [plan.due, plan.notYet, plan.exhausted]) {
    bucket.sort((a, b) => a.issueNumber - b.issueNumber);
  }
  return plan;
}

/**
 * Terminal message for an issue whose re-entry bound is spent (#892 AC-3).
 * Mirrors today's labeled halt vocabulary (`Rate limited — resets at …`,
 * `auto-wait N/M`): names the real cause, the consumed bound, and the manual
 * way out.
 *
 * @internal Exported for testing
 */
export function reentryBoundMessage(candidate: ResumeCandidate): string {
  const resetLabel = formatResetTime(new Date(candidate.resumeAt).getTime());
  return (
    `Rate limited — re-entry bound reached ` +
    `(${candidate.reentries}/${MAX_RESUME_REENTRIES}), window still closed ` +
    `at last halt (${candidate.phase} phase, resumable at ${resetLabel}). ` +
    `Re-run manually with: npx sequant run ${candidate.issueNumber} --resume`
  );
}

/**
 * The delegated run options for a re-entry: `resume: true` (completed phases
 * are skipped via GitHub markers) and nothing else. `RunOptions` is
 * normalized so an absent field means "resolve from settings/defaults"
 * (`config-resolver` only reacts to explicit `false` / `no*` fields), so a
 * bare object behaves exactly like an attended `sequant run <issue> --resume`
 * — MCP, retry ladder, rebase, and PR creation all follow the user's settings.
 *
 * @internal Exported for testing
 */
export function buildReentryRunOptions(): RunOptions {
  return { resume: true };
}

/** Options accepted by {@link resumeCommand}. */
export interface ResumeCommandOptions {
  /** Print the plan without consuming a re-entry or spawning a run. */
  dryRun?: boolean;
}

/**
 * Command entry for `sequant resume [issues...]`.
 *
 * Exit contract (load-bearing for schedulers, AC-2):
 * - nothing halted / nothing due yet → exit 0 (quiet no-op);
 * - due issues → re-entry counter consumed, then delegates to the normal run
 *   path (its exit code stands);
 * - only exhausted issues → exit 1 with the labeled terminal message, so a
 *   wrapper can alert a human instead of silently looping forever.
 */
export async function resumeCommand(
  issues: string[],
  options: ResumeCommandOptions = {},
): Promise<void> {
  const requested = issues.map((raw) => {
    const n = parseInt(raw, 10);
    if (isNaN(n) || n <= 0) {
      console.log(chalk.red(`❌ Invalid issue number: ${raw}`));
      process.exitCode = 1;
    }
    return n;
  });
  if (process.exitCode === 1) return;

  const stateManager = new StateManager();
  const states = await stateManager.getAllIssueStates();
  const plan = planResume(states, requested, Date.now());

  if (
    plan.due.length === 0 &&
    plan.notYet.length === 0 &&
    plan.exhausted.length === 0
  ) {
    console.log(
      chalk.gray("No halted issues to resume (no windowHalt in state)."),
    );
    return;
  }

  for (const candidate of plan.notYet) {
    const resetLabel = formatResetTime(new Date(candidate.resumeAt).getTime());
    console.log(
      chalk.yellow(
        `⏸ #${candidate.issueNumber} not yet resumable — window reopens at ` +
          `${resetLabel} (${candidate.phase} phase halted)`,
      ),
    );
  }

  for (const candidate of plan.exhausted) {
    console.log(
      chalk.red(
        `❌ #${candidate.issueNumber}: ${reentryBoundMessage(candidate)}`,
      ),
    );
  }

  if (plan.due.length === 0) {
    // AC-2: pre-`resumeAt` is a clean no-op (exit 0). Only an exhausted-only
    // outcome is terminal (exit 1) — there is nothing left for a scheduler to
    // wait for.
    if (plan.notYet.length === 0 && plan.exhausted.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  if (options.dryRun) {
    for (const candidate of plan.due) {
      console.log(
        chalk.green(
          `▶ #${candidate.issueNumber} due for re-entry ` +
            `(${candidate.reentries + 1}/${MAX_RESUME_REENTRIES}) — dry run, not started`,
        ),
      );
    }
    return;
  }

  // Consume the re-entry BEFORE running (AC-3): a re-entry that halts again
  // on a still-closed window must already be counted, or the bound never
  // trips. A re-entry that makes progress clears the record (and counter)
  // via the halt path's success handling.
  for (const candidate of plan.due) {
    const count = await stateManager.incrementWindowHaltReentries(
      candidate.issueNumber,
    );
    console.log(
      chalk.green(
        `▶ Resuming #${candidate.issueNumber} ` +
          `(re-entry ${count ?? candidate.reentries + 1}/${MAX_RESUME_REENTRIES}, ` +
          `halted in ${candidate.phase})`,
      ),
    );
  }

  await runCommand(
    plan.due.map((candidate) => String(candidate.issueNumber)),
    buildReentryRunOptions(),
  );
}
