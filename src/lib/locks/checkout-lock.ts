/**
 * CheckoutLock — working-tree-scoped lock (#901).
 *
 * The per-issue lock from #625 keys on issue number, so two sessions working
 * different issues take different lock files and never contend. But
 * `git checkout`, `switch`, `reset`, `rebase`, `merge` and `cherry-pick` are
 * global to a working tree: the contended resource is the *checkout*, not the
 * issue. This lock represents the checkout.
 *
 * Relationship to `LockManager`:
 *   - Stale semantics are *shared code*, not a parallel implementation — this
 *     class calls the same exported `classifyStaleness`, so the same-host
 *     dead-PID rule, the age ceiling and `SEQUANT_MAX_LOCK_AGE_MS` behave
 *     identically by construction (AC-4).
 *   - `LockManager`'s numeric key is left alone. Widening `lockPathFor` /
 *     `acquire` / `release` / `list` / `held` from `number` to `string` would
 *     ripple through `status.ts`, `merge.ts`, `resume.ts` and
 *     `run-orchestrator.ts`, all of which pass real issue numbers, for the
 *     benefit of exactly one new key. The cost of not widening is the
 *     duplicated `O_CREAT|O_EXCL` write below (~30 lines).
 *
 * Orchestrator / MCP mode: every public method is a no-op, mirroring
 * `LockManager` (AC-5).
 */

import {
  openSync,
  closeSync,
  writeSync,
  readFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import * as os from "os";

import {
  classifyStaleness,
  defaultIsPidAlive,
  isOrchestratorMode,
  resolveLocksDir,
  resolveMaxLockAgeMs,
  resolveSkillLockTtlMs,
} from "./lock-manager.js";
import {
  CHECKOUT_LOCK_FILENAME,
  CheckoutLockFileSchema,
  DEFAULT_MAX_LOCK_AGE_MS,
  DEFAULT_SKILL_LOCK_TTL_MS,
  DEFAULT_STALE_AGE_MS,
  type CheckoutAcquireResult,
  type CheckoutHolderIdentity,
  type CheckoutLockFile,
  type CheckoutLockListing,
} from "./types.js";

export interface CheckoutLockOptions {
  /** Directory holding lock files (default: `.sequant/locks`). */
  locksDir?: string;
  /** Age cutoff (ms) for cross-host locks. Default 2h. */
  staleAgeMs?: number;
  /** Age cutoff (ms) for skill-shell locks (`skipPidCheck`). Default 6h. */
  skillLockTtlMs?: number;
  /** Absolute age ceiling (ms). Default 24h (#856). */
  maxLockAgeMs?: number;
  /** Override for orchestrator detection (test seam). */
  orchestratorMode?: boolean;
  /** Override for `os.hostname()` (test seam). */
  hostname?: string;
  /** Override for current process PID (test seam). */
  pid?: number;
  /** Predicate: is PID alive on this host? (test seam) */
  isPidAlive?: (pid: number) => boolean;
  /** Clock (ms since epoch). Test seam. */
  now?: () => number;
}

/**
 * Do two identities refer to the same session?
 *
 * `sessionId` wins when *both* sides have one — it is the only identity that
 * survives a skill shell exiting between acquire and the next tool call.
 * Otherwise fall back to `pid` + `hostname`, which is what `LockManager`
 * already uses. Exported for the hook-parity tests.
 */
export function isSameHolder(
  holder: CheckoutLockFile,
  identity: CheckoutHolderIdentity,
): boolean {
  if (holder.sessionId && identity.sessionId) {
    return holder.sessionId === identity.sessionId;
  }
  return holder.pid === identity.pid && holder.hostname === identity.hostname;
}

/**
 * Build the refusal text for a blocked session (AC-2 + AC-3).
 *
 * AC-2 requires the message name the holding session and its issue; AC-3
 * requires it say how to proceed rather than only reporting the block. Both
 * halves are produced here, in one place, so the CLI and the hook cannot
 * drift on wording.
 *
 * @param holder    The session currently holding the checkout.
 * @param blocked   The issue the *refused* session is working on, when known —
 *                  used to name the worktree it should be using instead.
 * @param nowMs     Clock, for the human-readable age.
 */
export function formatCheckoutLockedMessage(
  holder: CheckoutLockFile,
  blocked: { issue?: number } = {},
  nowMs: number = Date.now(),
): string {
  const ageMs = nowMs - Date.parse(holder.startedAt);
  const ageText = Number.isFinite(ageMs)
    ? `${Math.max(0, Math.floor(ageMs / 60_000))}m ago`
    : "unknown age";

  const lines = [
    `The working tree is held by the session working #${holder.issue} ` +
      `(PID ${holder.pid} on ${holder.hostname}, started ${holder.startedAt}, ${ageText}).`,
    `Command: ${holder.command}`,
    "",
    "Branch-mutating git operations here would race with that session.",
    "",
    "To proceed:",
  ];

  if (blocked.issue !== undefined) {
    lines.push(
      `  • Work in your own worktree instead: ../worktrees/feature/${blocked.issue}-*/`,
      `    (create it with: ./scripts/new-feature.sh ${blocked.issue})`,
    );
  } else {
    lines.push(
      "  • Work in your issue's worktree instead: ../worktrees/feature/<issue>-*/",
      "    (create it with: ./scripts/new-feature.sh <issue>)",
    );
  }

  lines.push(
    "  • Or run the command with `git -C <worktree>` so it does not touch this tree.",
    "  • If that session is gone, clear the stale holder:",
    "      sequant locks checkout clear",
  );

  return lines.join("\n");
}

export class CheckoutLock {
  private readonly locksDir: string;
  private readonly staleAgeMs: number;
  private readonly skillLockTtlMs: number;
  private readonly maxLockAgeMs: number;
  private readonly orchestratorMode: boolean;
  private readonly hostname: string;
  private readonly pid: number;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly now: () => number;

  constructor(options: CheckoutLockOptions = {}) {
    this.locksDir = resolveLocksDir(options.locksDir);
    this.staleAgeMs = options.staleAgeMs ?? DEFAULT_STALE_AGE_MS;
    this.skillLockTtlMs =
      options.skillLockTtlMs ??
      resolveSkillLockTtlMs() ??
      DEFAULT_SKILL_LOCK_TTL_MS;
    this.maxLockAgeMs =
      options.maxLockAgeMs ?? resolveMaxLockAgeMs() ?? DEFAULT_MAX_LOCK_AGE_MS;
    this.orchestratorMode = options.orchestratorMode ?? isOrchestratorMode();
    this.hostname = options.hostname ?? os.hostname();
    this.pid = options.pid ?? process.pid;
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.now = options.now ?? Date.now;
  }

  /** True if all operations are no-ops (orchestrator/MCP mode). */
  get isNoop(): boolean {
    return this.orchestratorMode;
  }

  /** Absolute path to the checkout lock file. */
  get lockPath(): string {
    return join(this.locksDir, CHECKOUT_LOCK_FILENAME);
  }

  /** This process's identity, for callers that don't have a session id. */
  get selfIdentity(): CheckoutHolderIdentity {
    return { pid: this.pid, hostname: this.hostname };
  }

  /**
   * Claim the checkout for `issue`.
   *
   * Re-acquiring while already the holder succeeds idempotently
   * (`reentrant: true`) — a session must not be able to block itself part-way
   * through its own run.
   */
  acquire(
    issue: number,
    command: string,
    options: { sessionId?: string; skipPidCheck?: boolean } = {},
  ): CheckoutAcquireResult {
    if (this.orchestratorMode) {
      return { acquired: true, lockPath: "", reentrant: false };
    }

    const lockPath = this.lockPath;
    mkdirSync(this.locksDir, { recursive: true });

    const existing = this.readSafe(lockPath);
    if (existing) {
      const identity: CheckoutHolderIdentity = {
        sessionId: options.sessionId,
        pid: this.pid,
        hostname: this.hostname,
      };
      if (isSameHolder(existing, identity)) {
        return { acquired: true, lockPath, reentrant: true };
      }

      const staleReason = this.staleness(existing);
      if (staleReason) {
        this.unlinkSafe(lockPath);
      } else {
        return {
          acquired: false,
          holder: existing,
          lockPath,
          stale: false,
          staleReason: null,
        };
      }
    }

    return this.writeAtomic(lockPath, issue, command, options);
  }

  /**
   * Release the checkout if `identity` is its holder. Returns true when a lock
   * was removed. Safe to call when nothing is held.
   */
  release(identity?: CheckoutHolderIdentity): boolean {
    if (this.orchestratorMode) return false;

    const lockPath = this.lockPath;
    const current = this.readSafe(lockPath);
    if (!current) return false;

    const who = identity ?? this.selfIdentity;
    // A skill shell's PID is dead by the time release runs, which is exactly
    // what `skipPidCheck` marks. Same-host ownership is then the strongest
    // claim available — mirrors `LockManager.releaseExternal`.
    const ownerHost = current.hostname === who.hostname;
    if (!ownerHost) return false;
    if (!isSameHolder(current, who) && !current.skipPidCheck) return false;

    this.unlinkSafe(lockPath);
    return true;
  }

  /** Read the holder without acquiring. Null when free or unparseable. */
  check(): CheckoutLockFile | null {
    if (this.orchestratorMode) return null;
    return this.readSafe(this.lockPath);
  }

  /** Holder plus computed staleness metadata, for `locks list`. */
  listing(): CheckoutLockListing | null {
    if (this.orchestratorMode) return null;
    const holder = this.readSafe(this.lockPath);
    if (!holder) return null;

    const ageMs = this.now() - Date.parse(holder.startedAt);
    const staleReason = this.staleness(holder);
    return {
      holder,
      ageMs: Number.isFinite(ageMs) ? ageMs : 0,
      stale: staleReason !== null,
      staleReason,
      lockPath: this.lockPath,
    };
  }

  /**
   * Manually clear the checkout lock. With `safetyCheck` (default), refuses to
   * clear a holder that is still fresh — mirrors `LockManager.clearLock`.
   */
  clear(options: { safetyCheck?: boolean } = {}): {
    cleared: boolean;
    reason: string;
  } {
    if (this.orchestratorMode) {
      return { cleared: false, reason: "orchestrator-mode" };
    }
    const safetyCheck = options.safetyCheck ?? true;
    const lockPath = this.lockPath;
    const holder = this.readSafe(lockPath);
    if (!holder) return { cleared: false, reason: "no-lock" };

    if (safetyCheck && !this.staleness(holder)) {
      return { cleared: false, reason: "fresh-holder" };
    }

    this.unlinkSafe(lockPath);
    return { cleared: true, reason: "cleared" };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Delegates wholesale to the per-issue lock's classifier so the two locks
   * cannot drift on staleness (AC-4).
   */
  private staleness(holder: CheckoutLockFile) {
    return classifyStaleness({
      holder,
      myHostname: this.hostname,
      now: this.now(),
      staleAgeMs: this.staleAgeMs,
      skillLockTtlMs: this.skillLockTtlMs,
      maxLockAgeMs: this.maxLockAgeMs,
      isPidAlive: this.isPidAlive,
    });
  }

  private writeAtomic(
    lockPath: string,
    issue: number,
    command: string,
    options: { sessionId?: string; skipPidCheck?: boolean },
  ): CheckoutAcquireResult {
    const payload: CheckoutLockFile = {
      pid: this.pid,
      hostname: this.hostname,
      startedAt: new Date(this.now()).toISOString(),
      command,
      issue,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.skipPidCheck ? { skipPidCheck: true } : {}),
    };

    let fd: number;
    try {
      fd = openSync(lockPath, "wx", 0o644);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        const winner = this.readSafe(lockPath);
        if (winner) {
          return {
            acquired: false,
            holder: winner,
            lockPath,
            stale: false,
            staleReason: null,
          };
        }
      }
      throw err;
    }

    try {
      writeSync(fd, JSON.stringify(payload, null, 2));
    } finally {
      closeSync(fd);
    }
    return { acquired: true, lockPath, reentrant: false };
  }

  private readSafe(lockPath: string): CheckoutLockFile | null {
    if (!existsSync(lockPath)) return null;
    try {
      const parsed = CheckoutLockFileSchema.safeParse(
        JSON.parse(readFileSync(lockPath, "utf-8")),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private unlinkSafe(lockPath: string): void {
    try {
      unlinkSync(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
