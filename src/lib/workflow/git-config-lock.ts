/**
 * Retry for git commands that lose the shared `.git/config` lock (#1469).
 *
 * `git worktree add -b` writes the new branch's upstream into `.git/config`,
 * and so does `recordWorktreeBaseRef`. Two `sequant run` CLIs provisioning in
 * one repo at the same moment race on `.git/config.lock`; the loser exits
 * non-zero with `could not lock config file`. The lock is held for
 * milliseconds, so a short bounded retry is enough — no cross-CLI lock.
 */

/** Stderr git prints when another process holds `.git/config.lock`. */
export const CONFIG_LOCK_ERROR = /could not lock config file/i;

/** Waits between attempts: 5 attempts, about 1.5 s worst case. */
export const CONFIG_LOCK_BACKOFF_MS: readonly number[] = [100, 200, 400, 800];

export interface ConfigLockRetryOptions {
  /** One wait per retry; its length bounds the attempts (default above). */
  backoffMs?: readonly number[];
  /** Blocking wait; injectable so a test can release the lock in it. */
  sleep?: (ms: number) => void;
}

/** Block the thread for `ms` (every caller here is spawnSync-based). */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `attempt` until it succeeds, fails with something other than a config
 * lock error, or the backoff runs out. `stderrOf` returns the failure's stderr,
 * or `null` when the attempt succeeded. Returns the last attempt's result.
 */
export function retryOnConfigLock<T>(
  attempt: (n: number) => T,
  stderrOf: (result: T) => string | null,
  options: ConfigLockRetryOptions = {},
): T {
  const backoff = options.backoffMs ?? CONFIG_LOCK_BACKOFF_MS;
  const sleep = options.sleep ?? sleepSync;
  let result = attempt(0);
  for (let i = 0; i < backoff.length; i++) {
    const stderr = stderrOf(result);
    if (stderr === null || !CONFIG_LOCK_ERROR.test(stderr)) return result;
    sleep(backoff[i]);
    result = attempt(i + 1);
  }
  return result;
}
