/**
 * Types for the issue-level concurrency lock (#625).
 */

import { z } from "zod";

/** Default age cutoff (ms) for cross-host stale locks. */
export const DEFAULT_STALE_AGE_MS = 2 * 60 * 60 * 1000; // 2h

/**
 * Default age cutoff (ms) for skill-shell locks (`skipPidCheck: true`).
 * Longer than `DEFAULT_STALE_AGE_MS` because skill shells can't refresh
 * their own PID liveness — the lock has to outlive long /fullsolve runs
 * with multi-iteration QA loops. 6h covers virtually every run while
 * still bounding the orphan window on crash/abort.
 *
 * Override per-process via `SEQUANT_SKILL_LOCK_TTL_MS` (milliseconds).
 */
export const DEFAULT_SKILL_LOCK_TTL_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Absolute age ceiling (ms) beyond which a lock is stale no matter what
 * (#856). Unlike the two TTLs above this one is NOT conditional on host or
 * PID liveness: the same-host branch of `classifyStaleness` treats a live PID
 * as authoritative proof of freshness, so before this ceiling existed a lock
 * whose PID had been recycled by the OS read as fresh forever and blocked its
 * issue permanently (observed: `505.lock` from 2026-05-14, `708.lock`,
 * `803.lock`). It is also the recovery path for locks leaked by a SIGKILLed
 * run, where no in-process release handler can ever fire.
 *
 * 24h is ~48x the 30-minute default phase timeout and 4x
 * `DEFAULT_SKILL_LOCK_TTL_MS`, so no real run can reach it.
 *
 * Override per-process via `SEQUANT_MAX_LOCK_AGE_MS` (milliseconds).
 */
export const DEFAULT_MAX_LOCK_AGE_MS = 24 * 60 * 60 * 1000; // 24h

/** Default lock directory relative to the project root. */
export const DEFAULT_LOCKS_DIR = ".sequant/locks";

/**
 * Why a lock is considered stale, or `null` when it is fresh.
 *
 * - `pid-dead` — same-host holder PID is gone.
 * - `age-exceeded` — cross-host / skill-shell lock past its TTL.
 * - `max-age-exceeded` — past the absolute ceiling; applies unconditionally.
 */
export type StaleReason = "pid-dead" | "age-exceeded" | "max-age-exceeded";

/** On-disk lock payload. */
export const LockFileSchema = z.object({
  pid: z.number().int().positive(),
  hostname: z.string(),
  startedAt: z.string(), // ISO-8601 UTC
  command: z.string(),
  /**
   * True when the holder cannot vouch for its PID staying alive (e.g. a skill
   * shell that exits immediately after acquire). Stale detection falls back
   * to age-only on the holder's host, same path as cross-host locks.
   */
  skipPidCheck: z.boolean().optional(),
});

export type LockFile = z.infer<typeof LockFileSchema>;

/**
 * Filename of the checkout-scoped lock (#901), stored alongside the numeric
 * `<issue>.lock` files. Deliberately non-numeric so `LockManager.list()` —
 * which parses each filename as an issue number and skips anything else —
 * ignores it rather than surfacing a bogus `NaN` issue.
 */
export const CHECKOUT_LOCK_FILENAME = "checkout.lock";

/**
 * On-disk payload for the checkout-scoped lock (#901).
 *
 * The per-issue lock from #625 is keyed on issue number, so two sessions
 * working *different* issues take different lock files and never contend —
 * yet `git checkout`, `reset`, `rebase` and `merge` are global to a working
 * tree. This lock represents the tree itself.
 *
 * Extends `LockFileSchema` with:
 *  - `issue` — which issue the holder is working on, so a refusal can name it
 *    (AC-2) and point the loser at the right worktree (AC-3).
 *  - `sessionId` — Claude Code's per-session id, read from the PreToolUse
 *    stdin envelope. Optional: it is the *preferred* holder identity because a
 *    skill shell's PID dies immediately after acquire, but the hook falls back
 *    to `pid`+`hostname` when the envelope does not carry one, so nothing
 *    depends on it being present.
 */
export const CheckoutLockFileSchema = LockFileSchema.extend({
  issue: z.number().int().positive(),
  sessionId: z.string().optional(),
});

export type CheckoutLockFile = z.infer<typeof CheckoutLockFileSchema>;

/** Identity of the session asking for the checkout lock. */
export interface CheckoutHolderIdentity {
  /** Claude Code session id, when the caller knows it. */
  sessionId?: string;
  /** Falls back to these when `sessionId` is absent on either side. */
  pid: number;
  hostname: string;
  /**
   * The issue this session is working on (#906).
   *
   * Last-resort ownership proxy for `skipPidCheck` locks, whose PID is dead
   * by the time anything checks it. Optional because a live process releasing
   * its own lock identifies itself by PID and needs none of this — but a
   * skill shell that omits it can no longer release, which is deliberate.
   */
  issue?: number;
}

/** Outcome of `CheckoutLock.acquire()`. */
export type CheckoutAcquireResult =
  | {
      acquired: true;
      lockPath: string;
      /** True when the caller already held it — re-acquire is idempotent. */
      reentrant: boolean;
    }
  | {
      acquired: false;
      holder: CheckoutLockFile;
      lockPath: string;
      stale: false;
      staleReason: null;
    };

/** Listing entry for the checkout lock, mirroring `LockListing`. */
export interface CheckoutLockListing {
  holder: CheckoutLockFile;
  ageMs: number;
  stale: boolean;
  staleReason: StaleReason | null;
  lockPath: string;
}

/** Outcome of `LockManager.acquire()`. */
export type AcquireResult =
  | { acquired: true; lockPath: string }
  | {
      acquired: false;
      holder: LockFile;
      lockPath: string;
      /** True when the holder appears stale and could be cleared with `--force`. */
      stale: boolean;
      staleReason?: StaleReason | null;
    };

/** Listing entry from `LockManager.list()`. */
export interface LockListing {
  issue: number;
  holder: LockFile;
  ageMs: number;
  stale: boolean;
  staleReason: StaleReason | null;
  lockPath: string;
}

/**
 * Discriminator for `LockManager.signalOther()`. Distinguishes the branches
 * that previously all collapsed to `false`, so callers can produce accurate
 * log lines (#637).
 */
export type SignalReason =
  | "sent"
  | "orchestrator"
  | "cross-host"
  | "self-or-parent"
  | "pid-dead"
  /**
   * Holder is past the absolute age ceiling, so its PID is not trustworthy
   * identity (#856). Signalling it would target whatever process the OS has
   * since recycled that PID onto — an unrelated program, killed by a
   * `--force --signal-other` aimed at a lock abandoned weeks ago.
   */
  | "stale-pid-untrusted"
  | "kill-failed";

/** Outcome of `LockManager.signalOther()`. */
export interface SignalOtherResult {
  sent: boolean;
  reason: SignalReason;
}
