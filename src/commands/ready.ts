/**
 * sequant ready <issue> — post-resolve A+ QA gate (#683)
 *
 * Runs a full-weight `qa → loop → qa` pipeline against an issue's existing
 * worktree, reproducing the maintainer's manual fresh-session A+ pass
 * deterministically, then STOPS at a human merge gate. It NEVER merges.
 *
 * Gate policy (flag > settings.ready.policy > "ac"):
 * - `ac`    (default) — loop until ACs are objectively met; report (not fix)
 *                        quality gaps and Non-Goal-touching findings.
 * - `a-plus` (opt-in)  — loop toward READY_FOR_MERGE, auto-fixing quality gaps.
 *
 * Terminates in `waiting_for_human_merge` (when ready) or `blocked` (needs
 * human / no implementation), persists that state, and emits a structured gap
 * report. See `src/lib/workflow/ready-gate.ts` for the engine.
 */

import { ui, colors } from "../lib/cli-ui.js";
import { getSettings, type ReadyPolicy } from "../lib/settings.js";
import { listWorktrees } from "../lib/workflow/worktree-manager.js";
import { GitHubProvider } from "../lib/workflow/platforms/github.js";
import { getStateManager } from "../lib/workflow/state-manager.js";
import { executePhaseWithRetry } from "../lib/workflow/phase-executor.js";
import { buildProgressWiring } from "./run-progress.js";
import type { RunRenderer } from "../lib/cli-ui/run-renderer-types.js";
import type { LivenessHeartbeat } from "../lib/workflow/heartbeat.js";
import type { ProgressCallback } from "../lib/workflow/types.js";
import {
  runReadyGate,
  parseNonGoals,
  type ReadyPhaseRunner,
  type ReadyResult,
} from "../lib/workflow/ready-gate.js";

export interface ReadyCommandOptions {
  policy?: string;
  maxIterations?: number;
  budget?: number;
  timeout?: number;
  /** Commander surfaces `--no-mcp` as `mcp === false`. */
  mcp?: boolean;
  json?: boolean;
  verbose?: boolean;
}

/**
 * Exit code from a ready result.
 * - 0: ready (awaiting human merge)
 * - 1: not ready — needs human intervention (budget/iterations/stagnation)
 * - 2: not ready — no implementation (#534) or hard error
 */
export function getReadyExitCode(result: ReadyResult): number {
  if (result.ready) return 0;
  if (result.reason === "NO_IMPLEMENTATION") return 2;
  return 1;
}

/**
 * Resolve the gate policy: `--policy` flag > settings.ready.policy > "ac".
 * Invalid flag values fall back to the settings/default value.
 *
 * @internal Exported for testing only.
 */
export function resolvePolicy(
  flag: string | undefined,
  settingsPolicy: ReadyPolicy,
): ReadyPolicy {
  if (flag === "ac" || flag === "a-plus") return flag;
  return settingsPolicy;
}

/**
 * Locate the worktree path for an issue from `git worktree list`.
 *
 * @internal Exported for testing only.
 */
export function resolveWorktreePath(issueNumber: number): string | null {
  const match = listWorktrees().find((w) => w.issue === issueNumber);
  return match?.path ?? null;
}

export async function readyCommand(
  issueArg: string,
  options: ReadyCommandOptions,
): Promise<void> {
  const issueNumber = parseInt(issueArg, 10);
  if (isNaN(issueNumber)) {
    if (options.json) {
      console.log(JSON.stringify({ error: `Invalid issue: ${issueArg}` }));
    } else {
      console.error(
        ui.errorBox("Invalid issue", `"${issueArg}" is not a number`),
      );
    }
    process.exitCode = 2;
    return;
  }

  const settings = await getSettings();
  const policy = resolvePolicy(options.policy, settings.ready.policy);
  const maxIterations =
    typeof options.maxIterations === "number" && options.maxIterations > 0
      ? options.maxIterations
      : settings.run.maxIterations;
  const tokenBudget =
    typeof options.budget === "number" && options.budget > 0
      ? options.budget
      : undefined;
  const phaseTimeout =
    typeof options.timeout === "number" && options.timeout > 0
      ? options.timeout
      : settings.run.timeout;
  const mcp = options.mcp !== false;

  // Resolve the issue's existing worktree (reuses run/state worktree infra).
  const worktreePath = resolveWorktreePath(issueNumber);
  if (!worktreePath) {
    const msg =
      `No worktree found for issue #${issueNumber}. ` +
      `Run \`sequant run ${issueNumber}\` first (or create one with ./scripts/new-feature.sh).`;
    if (options.json) {
      console.log(JSON.stringify({ error: msg }));
    } else {
      console.error(ui.errorBox("No worktree", msg));
    }
    process.exitCode = 2;
    return;
  }

  // Parse the issue's Non-Goals so `ac` mode can mark touching findings
  // report-only. Best-effort: an unavailable body just yields no Non-Goals.
  const gh = new GitHubProvider();
  const body = gh.fetchIssueBodySync(String(issueNumber));
  const nonGoals = body ? parseNonGoals(body) : [];

  // #697: live phase-matrix renderer, reusing the shared `run` wiring (#618)
  // for visual parity. Built only on the non-`--json` path so no live writes
  // corrupt piped JSON (AC-4); the renderer itself degrades to non-TTY line
  // mode when stdout isn't a TTY, same as `run`.
  let renderer: RunRenderer | null = null;
  let heartbeat: LivenessHeartbeat | null = null;
  let onProgress: ProgressCallback | undefined;

  if (!options.json) {
    console.log(ui.headerBox("SEQUANT READY"));
    console.log("");
    console.log(
      colors.muted(
        `Issue #${issueNumber} · policy: ${policy} · max iterations: ${maxIterations}` +
          (tokenBudget
            ? ` · budget: ${tokenBudget.toLocaleString()} tokens`
            : "") +
          `\nWorktree: ${worktreePath}`,
      ),
    );
    console.log(
      colors.muted(
        "Full-weight QA (pre-flight checks ON). Never merges — stops at the human gate.",
      ),
    );
    console.log("");

    // Stream phases as they fire (no `basePhases`): the ready pipeline length
    // is dynamic (1–N qa/loop passes), so a fixed seed would leave a stuck-
    // pending `loop` cell when the gate stops after the first qa.
    ({ renderer, heartbeat, onProgress } = buildProgressWiring({
      tuiEnabled: false,
      quiet: false,
      issueNumbers: [issueNumber],
      phaseTimeoutSeconds: phaseTimeout,
      maxLoopIterations: maxIterations,
    }));
  }

  // SIGINT: clear the live zone before ShutdownManager writes its cleanup
  // banner so the two don't collide on stdout (mirror run.ts:159-162).
  const sigintHandler = (): void => {
    renderer?.dispose();
  };
  if (renderer) process.once("SIGINT", sigintHandler);

  // Real phase runner: wraps executePhaseWithRetry against the worktree. The
  // renderer doubles as the PhasePauseHandle (7th arg) so `--verbose` streaming
  // pauses/resumes the live zone instead of double-rendering (AC-5).
  const runPhase: ReadyPhaseRunner = (phase, config, wt) =>
    executePhaseWithRetry(
      issueNumber,
      phase,
      config,
      undefined,
      wt,
      undefined,
      renderer ?? undefined,
    );

  let result: ReadyResult;
  try {
    result = await runReadyGate({
      issueNumber,
      worktreePath,
      policy,
      maxIterations,
      tokenBudget,
      nonGoals,
      phaseTimeout,
      mcp,
      verbose: options.verbose,
      runPhase,
      onProgress,
    });
  } catch (error) {
    // Dispose the live zone on the error path too — not just the happy path
    // (Derived AC: cleanup on ALL exit paths).
    renderer?.dispose();
    heartbeat?.dispose();
    if (renderer) process.off("SIGINT", sigintHandler);
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.log(JSON.stringify({ error: message }));
    } else {
      console.error(ui.errorBox("Ready gate failed", message));
    }
    process.exitCode = 2;
    return;
  }

  // Persist the terminal state so `sequant status` reflects it (Derived AC).
  // Best-effort: initialize the issue in state if a prior run didn't track it.
  try {
    const stateManager = getStateManager();
    const existing = await stateManager.getIssueState(issueNumber);
    if (!existing) {
      const title =
        gh.fetchIssueTitleSync(String(issueNumber)) ?? `Issue #${issueNumber}`;
      await stateManager.initializeIssue(issueNumber, title, {
        worktree: worktreePath,
      });
    }
    await stateManager.updateIssueStatus(issueNumber, result.issueStatus);
  } catch {
    // State persistence is non-fatal — the report is the primary output.
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          issue: result.issueNumber,
          policy: result.policy,
          ready: result.ready,
          reason: result.reason,
          status: result.issueStatus,
          iterations: result.iterations,
          finalVerdict: result.finalVerdict,
          autoFixed: result.autoFixed,
          remaining: result.remaining,
          tokensUsed: result.tokensUsed,
        },
        null,
        2,
      ),
    );
  } else {
    // #697 AC-6: dispose the live zone BEFORE printing the report so the
    // markdown lands in clean scrollback (mirror run.ts:185-186).
    renderer?.dispose();
    console.log(result.report);
  }

  heartbeat?.dispose();
  if (renderer) process.off("SIGINT", sigintHandler);

  process.exitCode = getReadyExitCode(result);
}
