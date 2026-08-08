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
  stealStaleLock,
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

/**
 * Reserved holder id for `/release`, which mutates the main checkout but has
 * no issue of its own (#911). The lock file and the `pre-tool.sh` guard both
 * key on a positive integer, so the skill claims the tree under this sentinel
 * rather than a symbolic label (which would require schema + CLI + hook
 * changes — tracked in #911 as a follow-up).
 */
export const RELEASE_SENTINEL_ISSUE = 999999999;

/**
 * Render a checkout-lock holder's issue for CLI display. The sentinel is not
 * a real issue, and printing it as `#999999999` invites readers to go looking
 * for one.
 */
export function describeCheckoutHolderIssue(issue: number): string {
  return issue === RELEASE_SENTINEL_ISSUE ? "/release (sentinel)" : `#${issue}`;
}

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
 * Does `identity` own the checkout `holder` claimed? (#906)
 *
 * One predicate for both `acquire`'s reentrancy check and `release`'s
 * permission check, so the two cannot disagree about who the holder is: a
 * session able to release by a given identity is exactly the one able to
 * re-acquire by it. Exported for the hook-parity tests.
 *
 * The rules are ordered, and the order is load-bearing:
 *
 *  1. Cross-host callers never own the lock. Checked first — no weaker rule
 *     below may overturn it.
 *  2. When *both* sides carry a `sessionId`, equality decides and nothing
 *     falls through: a mismatch is positive proof of non-ownership, so
 *     consulting a weaker signal afterwards could only overturn a stronger
 *     one. (Dormant in the shipped flow — no env var carries Claude Code's
 *     session id into a skill shell, so `acquire` never passes one. Kept
 *     because leaking a lock for its TTL is the safer failure.)
 *  3. Same PID on the same host: a live process releasing its own lock.
 *  4. `skipPidCheck` locks only: the holder's issue number. A skill shell's
 *     PID is dead by the time the next block runs — that is what
 *     `skipPidCheck` marks — so the issue is the only identity left, and the
 *     hook's blocking side (`pre-tool.sh`) already decides holder-ness the
 *     same way. Deliberately a *courtesy* check, not a security boundary:
 *     the issue number is readable from the lock file and `clear --force`
 *     exists. It defends against the accident this rule was written for — a
 *     *blocked* session running its release contract, which by construction
 *     carries a different issue.
 *  5. Anything else is refused.
 */
export function isCheckoutOwner(
  holder: CheckoutLockFile,
  identity: CheckoutHolderIdentity,
): boolean {
  if (holder.hostname !== identity.hostname) return false;
  if (holder.sessionId && identity.sessionId) {
    return holder.sessionId === identity.sessionId;
  }
  if (holder.pid === identity.pid) return true;
  if (
    holder.skipPidCheck === true &&
    identity.issue !== undefined &&
    identity.issue === holder.issue
  ) {
    return true;
  }
  return false;
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
    // `--force` is not optional advice (#906). Plain `clear` refuses a holder
    // that still reads fresh, and a leaked skill-shell lock reads fresh for
    // the full 6h TTL — so the un-forced form fails in exactly the situation
    // that sends someone here.
    "      sequant locks checkout clear --force",
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

  /**
   * This process's identity, for callers that don't have a session id.
   *
   * Deliberately carries no `issue` (#906): a bare `release()` losing the
   * power to remove a *skill-shell* lock is the fix working, not an omission.
   * A caller that legitimately owns such a lock knows its issue and must say
   * so — `release({ ...lock.selfIdentity, issue })`.
   */
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
      // `issue` belongs in the identity for the same reason `release` needs
      // it (#906): without it a session could release its own skill-shell
      // lock by issue but not re-acquire it, and acquire would refuse the
      // holder against its own lock part-way through a run.
      const identity: CheckoutHolderIdentity = {
        sessionId: options.sessionId,
        pid: this.pid,
        hostname: this.hostname,
        issue,
      };
      if (isCheckoutOwner(existing, identity)) {
        return { acquired: true, lockPath, reentrant: true };
      }

      const staleReason = this.staleness(existing);
      if (staleReason) {
        // Compare-and-swap steal, not a blind unlink (#908): shared with
        // `LockManager` via `stealStaleLock` so the two lock classes cannot
        // drift. Only the classified stale inode is removed — never a fresh
        // lock a racing winner created at this path. Fall through to
        // `writeAtomic` regardless; its `O_CREAT|O_EXCL` picks the real holder.
        stealStaleLock(
          lockPath,
          {
            pid: existing.pid,
            hostname: existing.hostname,
            startedAt: existing.startedAt,
          },
          { pid: this.pid, now: this.now() },
        );
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
   * Release the checkout if `identity` owns it. Returns true when a lock was
   * removed — `false` covers both "nothing held" and "held, but not yours".
   *
   * Ownership is `isCheckoutOwner`, the same predicate `acquire` uses. Before
   * #906 this method took any same-host caller's word for a `skipPidCheck`
   * lock, which made acquire and release asymmetric in the one scenario the
   * lock exists for: a second session's *acquire* was correctly refused while
   * the holder was fresh, but its *release* — which every `/fullsolve` halt
   * branch runs — succeeded and handed the tree away mid-run.
   *
   * `LockManager.releaseExternal` keeps the looser same-host rule safely
   * because its lock *file* is issue-keyed: naming the file already proves the
   * caller knows the issue. `checkout.lock` has a constant filename, so that
   * proof has to move into the identity — which is exactly what rule 4 of
   * `isCheckoutOwner` asks for.
   */
  release(identity?: CheckoutHolderIdentity): boolean {
    if (this.orchestratorMode) return false;

    const lockPath = this.lockPath;
    const current = this.readSafe(lockPath);
    if (!current) return false;

    if (!isCheckoutOwner(current, identity ?? this.selfIdentity)) return false;

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
   *
   * A file that exists but does not parse is removed unconditionally (#906).
   * That state is reachable: `writeAtomic` creates the file with `openSync`
   * and writes to it as a second step, so a process killed in between leaves a
   * zero-byte `checkout.lock` (#856 documents the group-SIGKILL that does it).
   * Before this branch existed such a file was unclearable by any command —
   * `clear` read it, saw `null`, and reported `no-lock` without unlinking
   * (`--force` only ever reached the *staleness* check, never the read), while
   * `acquire` threw raw `EEXIST` and the hook, unable to parse any field,
   * blocked on it forever. `safetyCheck` is not consulted because there is no
   * holder to protect: unparseable bytes name no session.
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
    if (!holder) {
      if (existsSync(lockPath)) {
        this.unlinkSafe(lockPath);
        return { cleared: true, reason: "cleared-corrupt" };
      }
      return { cleared: false, reason: "no-lock" };
    }

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
