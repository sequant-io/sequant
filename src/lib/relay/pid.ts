/**
 * Per-issue PID tracking for relay liveness checks (AC-20/21/22).
 *
 * Reuses `defaultIsPidAlive` from `LockManager` — no duplicate `kill(pid, 0)`
 * implementations (AC-21).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { defaultIsPidAlive } from "../locks/lock-manager.js";
import { pidPathFor } from "./paths.js";

/** Re-export so callers don't need to import from `locks` directly. */
export { defaultIsPidAlive as isPidAlive } from "../locks/lock-manager.js";

/** Write `<cwd>/.sequant/pids/<issue>.pid` containing the current PID. */
export function writePidFile(
  issue: number,
  pid: number = process.pid,
  cwd: string = process.cwd(),
): string {
  const path = pidPathFor(issue, cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(pid), "utf-8");
  return path;
}

/** Read the PID stored in the pidfile. Returns `null` if missing/unparseable. */
export function readPidFile(
  issue: number,
  cwd: string = process.cwd(),
): number | null {
  const path = pidPathFor(issue, cwd);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

/** Remove the pidfile for an issue if it exists. */
export function removePidFile(
  issue: number,
  cwd: string = process.cwd(),
): boolean {
  const path = pidPathFor(issue, cwd);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

export interface StaleCleanupResult {
  /** Was a stale pidfile removed? */
  cleaned: boolean;
  /** Is the run still alive? */
  alive: boolean;
  /** PID we observed, if any. */
  pid: number | null;
  /** Human warning when a stale entry was cleared. */
  warning: string | null;
}

/**
 * Inspect the pidfile and clean it up if the PID is dead.
 *
 * Returns a structured result so callers can decide what to do (e.g.
 * `sequant prompt` refuses to send to a dead run; warn the user).
 */
export function cleanupStalePid(
  issue: number,
  options: {
    cwd?: string;
    isAlive?: (pid: number) => boolean;
  } = {},
): StaleCleanupResult {
  const cwd = options.cwd ?? process.cwd();
  const alive = options.isAlive ?? defaultIsPidAlive;

  const pid = readPidFile(issue, cwd);
  if (pid === null) {
    return { cleaned: false, alive: false, pid: null, warning: null };
  }

  if (alive(pid)) {
    return { cleaned: false, alive: true, pid, warning: null };
  }

  removePidFile(issue, cwd);
  return {
    cleaned: true,
    alive: false,
    pid,
    warning: `Run for #${issue} is no longer active (process exited). Message not sent.`,
  };
}
