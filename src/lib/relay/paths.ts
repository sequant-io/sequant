/**
 * Path resolution for relay directories.
 *
 * The relay lives inside a per-issue worktree at `<worktree>/.sequant/relay/`.
 * During the `spec` phase the worktree doesn't exist yet, so we fall back to
 * the main repo at `.sequant/relay/<issue>/`. The phase-executor sets
 * `SEQUANT_WORKTREE` whenever an isolated worktree is active.
 */

import { join, resolve } from "path";

export const RELAY_INBOX = "inbox.jsonl";
export const RELAY_OUTBOX = "outbox.jsonl";
export const RELAY_CURSOR = ".cursor";
export const RELAY_PIDS_DIR = ".sequant/pids";

export interface RelayPathOptions {
  /** Optional override; if omitted, reads SEQUANT_WORKTREE then falls back. */
  worktreePath?: string;
  /** Optional override for the main repo cwd (test seam). */
  cwd?: string;
}

/**
 * Resolve the absolute relay directory for an issue.
 *
 * - With a worktree: `<worktree>/.sequant/relay/`
 * - Without (spec phase or CLI from main repo): `<cwd>/.sequant/relay/<issue>/`
 */
export function relayDirFor(
  issue: number,
  options: RelayPathOptions = {},
): string {
  const worktree = options.worktreePath ?? process.env.SEQUANT_WORKTREE;
  const cwd = options.cwd ?? process.cwd();
  if (worktree && worktree.trim() !== "") {
    return resolve(worktree, ".sequant", "relay");
  }
  return resolve(cwd, ".sequant", "relay", String(issue));
}

/** Path to the inbox JSONL file. */
export function inboxPathFor(
  issue: number,
  options: RelayPathOptions = {},
): string {
  return join(relayDirFor(issue, options), RELAY_INBOX);
}

/** Path to the outbox JSONL file. */
export function outboxPathFor(
  issue: number,
  options: RelayPathOptions = {},
): string {
  return join(relayDirFor(issue, options), RELAY_OUTBOX);
}

/** Path to the reader cursor file. */
export function cursorPathFor(
  issue: number,
  options: RelayPathOptions = {},
): string {
  return join(relayDirFor(issue, options), RELAY_CURSOR);
}

/** Path to the per-issue PID file. */
export function pidPathFor(issue: number, cwd: string = process.cwd()): string {
  return resolve(cwd, RELAY_PIDS_DIR, `${issue}.pid`);
}

/**
 * Resolve the archive root directory for the relay logs:
 * `<cwd>/.sequant/logs/relay/`.
 */
export function archiveRootDir(cwd: string = process.cwd()): string {
  return resolve(cwd, ".sequant", "logs", "relay");
}

/**
 * Resolve the archive directory for a particular phase end:
 * `<archiveRoot>/<issue>-<phase>-<timestamp>/`.
 */
export function archiveDirFor(
  issue: number,
  phase: string,
  timestamp: string,
  cwd: string = process.cwd(),
): string {
  // Sanitize timestamp for filesystem use (colons are illegal on Windows).
  const safeTs = timestamp.replace(/[:.]/g, "-");
  return join(archiveRootDir(cwd), `${issue}-${phase}-${safeTs}`);
}
