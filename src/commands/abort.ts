/**
 * `sequant abort <issue>` — out-of-band escape hatch for a running headless
 * session (#645, Gap 7).
 *
 * `sequant prompt --type abort` queues an abort message into the inbox, which
 * the agent must read via the PostToolUse hook chain. When that chain is
 * broken (the bug originally reported in #645), no in-band abort can land.
 *
 * This command bypasses the inbox entirely: it locates the orchestrator PID
 * via `state.json.relay.pid` (with the per-issue pidfile as fallback) and
 * sends signals directly. The receiving end is the existing ShutdownManager
 * in `sequant run`, which already performs a clean teardown on SIGINT/SIGTERM.
 */

import chalk from "chalk";
import { isPidAlive, readPidFile } from "../lib/relay/pid.js";
import { StateManager } from "../lib/workflow/state-manager.js";
import { findActiveIssues, resolveTargetIssue } from "./prompt.js";

export interface AbortCommandOptions {
  /** Skip the SIGINT grace period; SIGTERM immediately. */
  force?: boolean;
  /** Seconds to wait after SIGINT before escalating. Default 10. */
  graceSeconds?: number;
  json?: boolean;
  /** Test seam: override the system kill function. */
  killFn?: (pid: number, signal: NodeJS.Signals) => void;
  /** Test seam: override the liveness check. */
  isAlive?: (pid: number) => boolean;
  /** Test seam: override the poll interval (ms). Default 250. */
  pollIntervalMs?: number;
  /** Test seam: override SIGTERM grace before SIGKILL (ms). Default 3000. */
  sigtermTimeoutMs?: number;
  /** Test seam: override SIGKILL final wait (ms). Default 2000. */
  sigkillTimeoutMs?: number;
  /** Test seam: override cwd for pidfile resolution. */
  cwd?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send `signal` and wait up to `timeoutMs` for the PID to exit. Returns true
 * if the process died, false if still alive at the deadline.
 */
async function signalAndWait(
  pid: number,
  signal: NodeJS.Signals,
  timeoutMs: number,
  isAlive: (pid: number) => boolean,
  killFn: (pid: number, signal: NodeJS.Signals) => void,
  pollIntervalMs: number,
): Promise<boolean> {
  try {
    killFn(pid, signal);
  } catch {
    // ESRCH (process already dead) → success.
    if (!isAlive(pid)) return true;
    throw new Error(
      `Failed to send ${signal} to PID ${pid} (signal not delivered)`,
    );
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await delay(pollIntervalMs);
  }
  return !isAlive(pid);
}

export async function abortCommand(argsAndOptions: {
  args: string[];
  options: AbortCommandOptions;
}): Promise<void> {
  const { args, options } = argsAndOptions;
  const json = Boolean(options.json);
  const killFn =
    options.killFn ??
    ((pid: number, signal: NodeJS.Signals): void => {
      process.kill(pid, signal);
    });
  const isAlive = options.isAlive ?? isPidAlive;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const cwd = options.cwd ?? process.cwd();

  // Resolve target issue: explicit arg or single-active auto-resolve.
  const stateManager = new StateManager();
  let issueNumber: number;
  const issueArg = args[0];
  if (issueArg !== undefined) {
    const n = Number.parseInt(issueArg, 10);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`Invalid issue number: '${issueArg}'`);
    }
    issueNumber = n;
  } else {
    const all = stateManager.stateExists()
      ? Object.values(await stateManager.getAllIssueStates())
      : [];
    const active = findActiveIssues(all, isAlive, cwd);
    const target = resolveTargetIssue({ explicit: null, activeIssues: active });
    issueNumber = target.issue;
  }

  const issueState = await stateManager.getIssueState(issueNumber);
  const pid = issueState?.relay?.pid ?? readPidFile(issueNumber, cwd) ?? null;

  if (pid === null) {
    const msg = `No relay PID found for #${issueNumber}. Is the run active?`;
    if (json) {
      console.log(
        JSON.stringify({ ok: false, issue: issueNumber, error: msg }),
      );
    } else {
      console.error(chalk.yellow(msg));
    }
    process.exitCode = 1;
    return;
  }

  if (!isAlive(pid)) {
    const msg = `PID ${pid} for #${issueNumber} is already dead.`;
    if (json) {
      console.log(
        JSON.stringify({ ok: true, issue: issueNumber, pid, signal: null }),
      );
    } else {
      console.log(chalk.gray(msg));
    }
    return;
  }

  const graceMs = Math.max(0, (options.graceSeconds ?? 10) * 1000);
  const force = Boolean(options.force);

  let delivered: NodeJS.Signals = "SIGINT";
  let died = false;

  if (!force) {
    if (!json) {
      console.log(
        chalk.gray(
          `Sending SIGINT to PID ${pid} (#${issueNumber}); waiting up to ${
            graceMs / 1000
          }s for graceful exit…`,
        ),
      );
    }
    died = await signalAndWait(
      pid,
      "SIGINT",
      graceMs,
      isAlive,
      killFn,
      pollIntervalMs,
    );
  }

  if (!died) {
    delivered = "SIGTERM";
    if (!json) {
      console.log(
        chalk.yellow(
          force
            ? `Sending SIGTERM to PID ${pid} (#${issueNumber}) (--force)…`
            : `Grace expired; escalating to SIGTERM…`,
        ),
      );
    }
    died = await signalAndWait(
      pid,
      "SIGTERM",
      options.sigtermTimeoutMs ?? 3000,
      isAlive,
      killFn,
      pollIntervalMs,
    );
  }

  if (!died) {
    delivered = "SIGKILL";
    if (!json) {
      console.log(
        chalk.red(`SIGTERM ignored; escalating to SIGKILL on PID ${pid}…`),
      );
    }
    died = await signalAndWait(
      pid,
      "SIGKILL",
      options.sigkillTimeoutMs ?? 2000,
      isAlive,
      killFn,
      pollIntervalMs,
    );
  }

  if (!died) {
    process.exitCode = 1;
  }

  if (json) {
    console.log(
      JSON.stringify({
        ok: died,
        issue: issueNumber,
        pid,
        signal: delivered,
      }),
    );
  } else if (died) {
    console.log(
      chalk.green(`Aborted #${issueNumber} (PID ${pid}, ${delivered}).`),
    );
  } else {
    console.error(
      chalk.red(
        `Failed to abort #${issueNumber}: PID ${pid} still alive after ${delivered}.`,
      ),
    );
  }
}
