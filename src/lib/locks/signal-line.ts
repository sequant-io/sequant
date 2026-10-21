/**
 * The `--signal-other` log line, shared by `sequant locks` and the run
 * orchestrator (#637, #1475).
 */

import type { SignalOtherResult } from "./types.js";

/**
 * Human-readable line for a `--signal-other` attempt. `indent` prefixes the
 * line (the orchestrator nests it under its own output); the text per reason
 * is the same for every caller.
 */
export function formatSignalLine(
  issue: number,
  pid: number,
  result: SignalOtherResult,
  options?: { indent?: string },
): string {
  return `${options?.indent ?? ""}${signalLineText(issue, pid, result)}`;
}

function signalLineText(
  issue: number,
  pid: number,
  result: SignalOtherResult,
): string {
  switch (result.reason) {
    case "sent":
      return `Signaled PID ${pid} (SIGTERM) for #${issue}`;
    case "cross-host":
      return `Could not signal PID ${pid} for #${issue} (cross-host holder)`;
    case "self-or-parent":
      return `Refused to signal PID ${pid} for #${issue} (matches this process or its parent)`;
    case "pid-dead":
      return `Could not signal PID ${pid} for #${issue} (already exited)`;
    case "stale-pid-untrusted":
      return `Refused to signal PID ${pid} for #${issue} (lock is past the age ceiling; that PID has likely been recycled onto an unrelated process)`;
    case "kill-failed":
      return `Could not signal PID ${pid} for #${issue} (kill syscall failed)`;
    case "orchestrator":
      return `Skipped signal for #${issue} (orchestrator mode)`;
  }
}
