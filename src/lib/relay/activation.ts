/**
 * Relay activation and deactivation lifecycle (#383).
 *
 * Activation creates the relay dir, writes the per-issue PID file, and updates
 * IssueState.relay. Deactivation archives the relay dir (preserving inbox /
 * outbox transcripts in `.sequant/logs/relay/`) and clears the runtime files.
 *
 * Both operations swallow errors when relay is disabled or filesystem is
 * read-only — relay must never block the underlying `sequant run` flow.
 */

import { existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import type { StateManager } from "../workflow/state-manager.js";
import { archiveRelayDir, tallyMessageCount } from "./archive.js";
import { relayDirFor } from "./paths.js";
import { writePidFile, removePidFile } from "./pid.js";

export interface ActivationOptions {
  /** Worktree path; falls back to `cwd` for spec-phase / main-repo relay. */
  worktreePath?: string;
  /** Main repo cwd (used for the PID file location). */
  cwd?: string;
  /** Optional state manager — updates IssueState.relay when provided. */
  stateManager?: StateManager | null;
  /** PID to record (defaults to current process). */
  pid?: number;
}

export interface ActivationResult {
  /** Was activation successful? */
  activated: boolean;
  /** Absolute path to the relay directory. */
  relayDir: string;
  /** Absolute path to the PID file. */
  pidPath: string | null;
  /** When activation occurred (ISO 8601). */
  startedAt: string;
  /** Error, if activation partially failed. Relay still considered active. */
  warning: string | null;
}

/**
 * Resolve the absolute path of `templates/relay/frame.txt` inside the
 * installed sequant package. Used by phase-executor to set the
 * SEQUANT_RELAY_FRAME env var so the bash hook can locate the template.
 */
export function resolveBundledFramePath(): string | null {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, "templates", "relay", "frame.txt");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return null;
}

/**
 * Activate the relay for `issue`. Creates `<worktree>/.sequant/relay/`,
 * writes `.sequant/pids/<issue>.pid` and (optionally) updates state.
 */
export async function activateRelay(
  issue: number,
  options: ActivationOptions = {},
): Promise<ActivationResult> {
  const startedAt = new Date().toISOString();
  const pid = options.pid ?? process.pid;
  const relayDir = relayDirFor(issue, {
    worktreePath: options.worktreePath,
    cwd: options.cwd,
  });

  let warning: string | null = null;

  try {
    mkdirSync(relayDir, { recursive: true });
  } catch (err) {
    warning = `Failed to create relay dir: ${err instanceof Error ? err.message : String(err)}`;
  }

  let pidPath: string | null = null;
  try {
    pidPath = writePidFile(issue, pid, options.cwd ?? process.cwd());
  } catch (err) {
    warning =
      (warning ? warning + "; " : "") +
      `Failed to write pid file: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (options.stateManager) {
    try {
      await options.stateManager.setRelayState(issue, {
        enabled: true,
        pid,
        startedAt,
        messageCount: 0,
      });
    } catch {
      // Issue may not be in state yet (race with initializeIssue) — non-fatal.
    }
  }

  return {
    activated: warning === null,
    relayDir,
    pidPath,
    startedAt,
    warning,
  };
}

export interface DeactivationOptions extends ActivationOptions {
  /** Phase whose work just ended — encoded in the archive dir name. */
  phase: string;
  /** When the relay was activated (echoed into archive meta.json). */
  startedAt: string;
}

export interface DeactivationResult {
  archived: boolean;
  archivePath: string | null;
  warning: string | null;
}

/**
 * Deactivate the relay for `issue`: archive inbox/outbox, remove the pidfile,
 * and clear IssueState.relay. Always returns — never throws.
 */
export async function deactivateRelay(
  issue: number,
  options: DeactivationOptions,
): Promise<DeactivationResult> {
  let warning: string | null = null;

  const cwd = options.cwd ?? process.cwd();
  const messageCount = tallyMessageCount(issue, {
    worktreePath: options.worktreePath,
    cwd,
  });

  const archive = archiveRelayDir(issue, {
    phase: options.phase,
    startedAt: options.startedAt,
    messageCount,
    worktreePath: options.worktreePath,
    cwd,
    archiveCwd: cwd,
  });
  if (archive.error) {
    warning = archive.error;
  }

  try {
    removePidFile(issue, cwd);
  } catch {
    /* swallow */
  }

  if (options.stateManager) {
    try {
      await options.stateManager.setRelayState(issue, null);
    } catch {
      /* swallow */
    }
  }

  return {
    archived: archive.archived,
    archivePath: archive.archivePath,
    warning,
  };
}
