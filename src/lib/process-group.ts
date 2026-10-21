/**
 * killProcessGroup — the one way sequant signals a detached child's tree (#1472).
 *
 * Callers spawn with `detached: true`, which makes the child a group leader,
 * so `-pid` addresses the whole tree. Used by the codex and opencode drivers
 * and by the MCP `sequant_run` tool.
 */

import type { ChildProcess } from "child_process";
import { noteSuppressed } from "./workflow/suppressed.js";

/**
 * Grace before the drivers escalate a timed-out or aborted agent to SIGKILL.
 * The drivers' children have no force-exit contract, unlike the MCP tool's
 * `sequant run` child (see `SIGKILL_GRACE_MS` in `src/mcp/tools/run.ts`), so
 * this is its own value rather than an import of that one.
 */
export const DRIVER_SIGKILL_GRACE_MS = 5000;

export interface KillProcessGroupOptions {
  /** Send SIGKILL after this many ms unless the child has closed. Absent: no escalation. */
  graceMs?: number;
}

export interface KillProcessGroupResult {
  /** True when a kill was sent to this child, now or by an earlier call. */
  requested: boolean;
}

/** Children already signalled, so a second call never sends a second SIGTERM. */
const signalled = new WeakSet<ChildProcess>();

/**
 * SIGTERM the child's process group, then SIGKILL it after `graceMs` unless
 * the child has closed. Idempotent per child.
 */
export function killProcessGroup(
  child: ChildProcess,
  opts: KillProcessGroupOptions = {},
): KillProcessGroupResult {
  if (signalled.has(child)) return { requested: true };
  // Loose `!=`: test doubles carry neither property, and `undefined` must
  // read as "still running".
  if (child.exitCode != null || child.signalCode != null) {
    return { requested: false };
  }
  const pid = child.pid;
  if (pid === undefined) return { requested: false };

  signalled.add(child);

  if (opts.graceMs !== undefined) {
    let closed = false;
    child.on("close", () => {
      closed = true;
    });
    setTimeout(() => {
      if (!closed) signalGroup(pid, "SIGKILL");
    }, opts.graceMs).unref();
  }

  signalGroup(pid, "SIGTERM");
  return { requested: true };
}

/**
 * Signal the group, swallowing ESRCH. ESRCH means it already exited between
 * the check and the signal.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      // Fall back to signalling the child directly — better a killed leader
      // than a run that ignores its timeout.
      try {
        process.kill(pid, signal);
      } catch (err) {
        // Already gone.
        noteSuppressed("other", err, "process-group:78");
      }
    }
  }
}
