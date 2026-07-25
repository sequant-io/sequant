/**
 * Normalized spawn results and never-empty failure reasons (#803)
 *
 * Shared by every merge-check module that reports on a spawned command. The
 * motivating defect: a failure reason built from `stderr` alone renders as
 * `... failed: ` with nothing after it whenever the command wrote its
 * diagnostics to stdout — which is where vitest, tsc, and npm put theirs.
 */

import type { SpawnSyncReturns } from "child_process";

/** Max characters of captured output included in a failure message. */
export const REASON_MAX_CHARS = 500;

/**
 * Outcome of a spawned command, normalized across success, non-zero exit,
 * signal termination, and spawn failure.
 */
export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
  signal: string | null;
  spawnError?: string;
}

/**
 * Normalize a raw `spawnSync` return into a {@link CommandResult}.
 */
export function toCommandResult(
  result: SpawnSyncReturns<string>,
): CommandResult {
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    status: result.status ?? null,
    signal: result.signal ?? null,
    spawnError: result.error?.message,
  };
}

/**
 * Produce a human-readable, never-empty reason for a failed command.
 *
 * Falls through: stderr → stdout tail → spawn error → signal → exit code. The
 * stdout *tail* is used because test runners put the failure summary last,
 * while the stderr *head* is kept because the first error is usually the
 * proximate cause.
 */
export function resolveFailureReason(result: CommandResult): string {
  if (result.stderr) {
    return truncateHead(result.stderr);
  }
  if (result.stdout) {
    return truncateTail(result.stdout);
  }
  if (result.spawnError) {
    return result.spawnError;
  }
  if (result.signal) {
    return `no output; killed by signal ${result.signal} (likely a timeout)`;
  }
  return `no output; exited with code ${result.status ?? "unknown"}`;
}

function truncateHead(text: string): string {
  return text.length > REASON_MAX_CHARS
    ? `${text.slice(0, REASON_MAX_CHARS)}…`
    : text;
}

function truncateTail(text: string): string {
  return text.length > REASON_MAX_CHARS
    ? `…${text.slice(-REASON_MAX_CHARS)}`
    : text;
}
