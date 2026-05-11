/**
 * Types for the issue-level concurrency lock (#625).
 */

import { z } from "zod";

/** Default age cutoff (ms) for cross-host / unknown-PID stale locks. */
export const DEFAULT_STALE_AGE_MS = 2 * 60 * 60 * 1000; // 2h

/** Default lock directory relative to the project root. */
export const DEFAULT_LOCKS_DIR = ".sequant/locks";

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
      staleReason?: "pid-dead" | "age-exceeded" | null;
    };

/** Listing entry from `LockManager.list()`. */
export interface LockListing {
  issue: number;
  holder: LockFile;
  ageMs: number;
  stale: boolean;
  staleReason: "pid-dead" | "age-exceeded" | null;
  lockPath: string;
}
