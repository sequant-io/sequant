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
  | "kill-failed";

/** Outcome of `LockManager.signalOther()`. */
export interface SignalOtherResult {
  sent: boolean;
  reason: SignalReason;
}
