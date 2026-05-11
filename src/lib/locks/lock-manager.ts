/**
 * LockManager — per-issue filesystem lock to prevent concurrent sequant
 * sessions from targeting the same issue (#625).
 *
 * Each lock is a single file at `<locksDir>/<issue>.lock`, claimed via
 * `open(O_CREAT|O_EXCL)`. A separate file (rather than a field inside
 * `state.json`) keeps acquisition atomic — no read-modify-write race.
 *
 * Stale detection (in order):
 *   1. `hostname === os.hostname()`: check `process.kill(pid, 0)`.
 *      Not alive → cleared.
 *   2. Cross-host: PID check is meaningless. Use age only.
 *   3. Age fallback (any host): `startedAt > staleAgeMs ago` → cleared.
 *
 * MCP / orchestrator mode: when `SEQUANT_ORCHESTRATOR` is set, every public
 * method is a no-op (no fs touches, no warnings). Mirrors the
 * `OrchestratorRenderer` pattern at `src/lib/cli-ui/run-renderer.ts:244`.
 */

import {
  openSync,
  closeSync,
  writeSync,
  readFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "fs";
import { join, resolve } from "path";
import * as os from "os";

import {
  DEFAULT_LOCKS_DIR,
  DEFAULT_SKILL_LOCK_TTL_MS,
  DEFAULT_STALE_AGE_MS,
  LockFileSchema,
  type AcquireResult,
  type LockFile,
  type LockListing,
} from "./types.js";

export interface LockManagerOptions {
  /** Directory holding `<issue>.lock` files (default: `.sequant/locks`). */
  locksDir?: string;
  /**
   * Age cutoff (ms) before a cross-host lock is considered stale by time.
   * Default 2h. Does NOT apply to skill-shell locks — see `skillLockTtlMs`.
   */
  staleAgeMs?: number;
  /**
   * Age cutoff (ms) for skill-shell locks (`skipPidCheck: true`). Default 6h.
   * Longer than `staleAgeMs` because skill shells can't refresh PID liveness;
   * the lock has to bridge long /fullsolve runs with multi-iteration QA loops.
   */
  skillLockTtlMs?: number;
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

/** Detect orchestrator mode purely from env (no caching) so tests can mutate. */
export function isOrchestratorMode(): boolean {
  return Boolean(process.env.SEQUANT_ORCHESTRATOR);
}

/** Resolve the locks directory honoring `SEQUANT_LOCKS_DIR` for test isolation. */
export function resolveLocksDir(explicit?: string): string {
  const fromEnv = process.env.SEQUANT_LOCKS_DIR;
  return resolve(explicit ?? fromEnv ?? DEFAULT_LOCKS_DIR);
}

/**
 * Resolve `SEQUANT_SKILL_LOCK_TTL_MS` (milliseconds) — env override for the
 * skill-shell lock TTL. Returns `null` when unset or unparseable so the
 * caller can fall back to the constructor option / default.
 */
export function resolveSkillLockTtlMs(): number | null {
  const raw = process.env.SEQUANT_SKILL_LOCK_TTL_MS;
  if (raw === undefined || raw === "") return null;
  const ms = Number.parseInt(raw, 10);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms;
}

/** Default same-host PID check. `process.kill(pid, 0)` throws if not alive. */
export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM = exists but signal not permitted → alive.
    if (code === "EPERM") return true;
    return false;
  }
}

/** Build the canonical "issue is in use" error message (AC: error format). */
export function formatLockedMessage(issue: number, holder: LockFile): string {
  return (
    `Issue #${issue} is being worked on by PID ${holder.pid} since ` +
    `${holder.startedAt} (${holder.command}). ` +
    `Use --force to take over, or wait for the other session.`
  );
}

/**
 * Decide whether a lock should be treated as stale.
 * Pure function: no I/O. Returns `null` if the lock is fresh.
 */
export function classifyStaleness(args: {
  holder: LockFile;
  myHostname: string;
  now: number;
  staleAgeMs: number;
  /** TTL for skill-shell (skipPidCheck) locks; falls back to staleAgeMs. */
  skillLockTtlMs?: number;
  isPidAlive: (pid: number) => boolean;
}): "pid-dead" | "age-exceeded" | null {
  const { holder, myHostname, now, staleAgeMs, isPidAlive } = args;
  const skillTtl = args.skillLockTtlMs ?? staleAgeMs;

  // 1. Same-host PID check is authoritative — except when the holder asked
  //    us to skip it (skill shells exit before the lock is released; their
  //    PID is dead but the skill is still running in Claude Code).
  if (holder.hostname === myHostname && !holder.skipPidCheck) {
    if (!isPidAlive(holder.pid)) return "pid-dead";
    return null;
  }

  // 2. Cross-host or skipPidCheck: PID is meaningless. Fall through to age.
  //    skipPidCheck uses its own TTL (default 6h) so long /fullsolve runs
  //    with multi-iteration QA loops don't lose their own lock; cross-host
  //    uses the stricter staleAgeMs (default 2h).
  const ttl = holder.skipPidCheck ? skillTtl : staleAgeMs;
  const ageMs = now - Date.parse(holder.startedAt);
  if (!Number.isFinite(ageMs)) return null;
  if (ageMs > ttl) return "age-exceeded";
  return null;
}

export class LockManager {
  private readonly locksDir: string;
  private readonly staleAgeMs: number;
  private readonly skillLockTtlMs: number;
  private readonly orchestratorMode: boolean;
  private readonly hostname: string;
  private readonly pid: number;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly now: () => number;

  /** Issues this instance has claimed and not yet released. */
  private readonly held = new Set<number>();

  constructor(options: LockManagerOptions = {}) {
    this.locksDir = resolveLocksDir(options.locksDir);
    this.staleAgeMs = options.staleAgeMs ?? DEFAULT_STALE_AGE_MS;
    this.skillLockTtlMs =
      options.skillLockTtlMs ??
      resolveSkillLockTtlMs() ??
      DEFAULT_SKILL_LOCK_TTL_MS;
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

  /** Absolute path to the locks directory. */
  getLocksDir(): string {
    return this.locksDir;
  }

  /** Path to the lock file for a given issue. */
  lockPathFor(issue: number): string {
    return join(this.locksDir, `${issue}.lock`);
  }

  /**
   * Try to acquire the lock for `issue`. Returns a discriminated union.
   *
   * Behavior:
   *   - Same-host stale (PID dead): silently cleared, then acquired.
   *   - Cross-host within age window: blocked.
   *   - Cross-host beyond `staleAgeMs`: silently cleared, then acquired.
   *   - Orchestrator mode: returns `{ acquired: true, lockPath: '' }` no-op.
   *
   * `options.skipPidCheck` marks the lock so future stale checks skip the
   * same-host PID probe and fall back to age-only — used for skill shells
   * whose Node PID dies between acquire and release.
   */
  acquire(
    issue: number,
    command: string,
    options: { skipPidCheck?: boolean } = {},
  ): AcquireResult {
    if (this.orchestratorMode) {
      return { acquired: true, lockPath: "" };
    }

    const lockPath = this.lockPathFor(issue);
    this.ensureLocksDir();

    // Auto-clear stale holder, then retry.
    const existing = this.readLockSafe(lockPath);
    if (existing) {
      const staleReason = classifyStaleness({
        holder: existing,
        myHostname: this.hostname,
        now: this.now(),
        staleAgeMs: this.staleAgeMs,
        skillLockTtlMs: this.skillLockTtlMs,
        isPidAlive: this.isPidAlive,
      });
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

    return this.writeAtomic(issue, lockPath, command, options.skipPidCheck);
  }

  /**
   * Take over the lock unconditionally (writes a new lock). Used by --force.
   * Does NOT signal the prior PID — caller invokes `signal()` separately
   * to opt in to that behavior (AC: --force does NOT signal).
   */
  forceAcquire(
    issue: number,
    command: string,
    options: { skipPidCheck?: boolean } = {},
  ): { lockPath: string; previous: LockFile | null } {
    if (this.orchestratorMode) {
      return { lockPath: "", previous: null };
    }

    const lockPath = this.lockPathFor(issue);
    this.ensureLocksDir();

    const previous = this.readLockSafe(lockPath);
    if (previous) this.unlinkSafe(lockPath);

    const result = this.writeAtomic(
      issue,
      lockPath,
      command,
      options.skipPidCheck,
    );
    if (!result.acquired) {
      throw new Error(
        `forceAcquire raced and lost on issue #${issue}: ${formatLockedMessage(
          issue,
          result.holder,
        )}`,
      );
    }
    return { lockPath: result.lockPath, previous };
  }

  /**
   * SIGTERM the prior PID iff it is alive on this host. Returns whether a
   * signal was sent. No-op in orchestrator mode or for cross-host holders.
   */
  signalOther(holder: LockFile, signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.orchestratorMode) return false;
    if (holder.hostname !== this.hostname) return false;
    if (!this.isPidAlive(holder.pid)) return false;
    try {
      process.kill(holder.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Release the lock for `issue` if this process is its holder.
   * Safe to call repeatedly; safe to call when no lock exists.
   */
  release(issue: number): void {
    if (this.orchestratorMode) return;

    const lockPath = this.lockPathFor(issue);
    const current = this.readLockSafe(lockPath);
    if (
      current &&
      current.pid === this.pid &&
      current.hostname === this.hostname
    ) {
      this.unlinkSafe(lockPath);
    }
    this.held.delete(issue);
  }

  /**
   * Release a lock claimed by a previous, now-dead, short-lived process on
   * the same host — the skill-shell pattern (`skipPidCheck: true`). Used by
   * `sequant locks release` to let skills hand back ownership. Returns
   * `true` when a lock was removed.
   */
  releaseExternal(issue: number): boolean {
    if (this.orchestratorMode) return false;

    const lockPath = this.lockPathFor(issue);
    const current = this.readLockSafe(lockPath);
    if (!current) return false;

    // Only owner-host can release. The `skipPidCheck` flag is the explicit
    // signal that "the original PID won't be alive — match on host instead".
    if (current.hostname !== this.hostname) return false;
    if (!current.skipPidCheck && current.pid !== this.pid) return false;

    this.unlinkSafe(lockPath);
    this.held.delete(issue);
    return true;
  }

  /** Release every lock this instance holds. */
  releaseAll(): void {
    if (this.orchestratorMode) return;
    for (const issue of [...this.held]) {
      this.release(issue);
    }
  }

  /**
   * Read the holder for `issue` without acquiring. Returns null when missing
   * or unparseable. Used by read-only commands (`status`, `merge`, `assess`).
   */
  check(issue: number): LockFile | null {
    if (this.orchestratorMode) return null;
    return this.readLockSafe(this.lockPathFor(issue));
  }

  /** List every active lock with computed staleness metadata. */
  list(): LockListing[] {
    if (this.orchestratorMode) return [];
    if (!existsSync(this.locksDir)) return [];

    const out: LockListing[] = [];
    const entries = readdirSync(this.locksDir);
    for (const name of entries) {
      if (!name.endsWith(".lock")) continue;
      const issueStr = name.slice(0, -".lock".length);
      const issue = Number(issueStr);
      if (!Number.isInteger(issue)) continue;

      const lockPath = join(this.locksDir, name);
      const holder = this.readLockSafe(lockPath);
      if (!holder) continue;

      const now = this.now();
      const ageMs = now - Date.parse(holder.startedAt);
      const staleReason = classifyStaleness({
        holder,
        myHostname: this.hostname,
        now,
        staleAgeMs: this.staleAgeMs,
        skillLockTtlMs: this.skillLockTtlMs,
        isPidAlive: this.isPidAlive,
      });
      out.push({
        issue,
        holder,
        ageMs: Number.isFinite(ageMs) ? ageMs : 0,
        stale: staleReason !== null,
        staleReason,
        lockPath,
      });
    }
    return out.sort((a, b) => a.issue - b.issue);
  }

  /**
   * Manually clear a lock. Used by `sequant locks clear`. Returns true if a
   * lock was removed. With `safetyCheck` (default), refuses to clear a
   * fresh same-host lock whose PID is alive — the caller should use
   * `--force` semantics for that.
   */
  clearLock(
    issue: number,
    options: { safetyCheck?: boolean } = {},
  ): { cleared: boolean; reason: string } {
    if (this.orchestratorMode)
      return { cleared: false, reason: "orchestrator-mode" };
    const safetyCheck = options.safetyCheck ?? true;
    const lockPath = this.lockPathFor(issue);
    const holder = this.readLockSafe(lockPath);
    if (!holder) return { cleared: false, reason: "no-lock" };

    if (safetyCheck) {
      const staleReason = classifyStaleness({
        holder,
        myHostname: this.hostname,
        now: this.now(),
        staleAgeMs: this.staleAgeMs,
        skillLockTtlMs: this.skillLockTtlMs,
        isPidAlive: this.isPidAlive,
      });
      if (!staleReason) {
        return { cleared: false, reason: "fresh-same-host-alive" };
      }
    }

    this.unlinkSafe(lockPath);
    return { cleared: true, reason: "cleared" };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private ensureLocksDir(): void {
    mkdirSync(this.locksDir, { recursive: true });
  }

  /**
   * Write a new lock atomically using `O_CREAT | O_EXCL`. Races safely:
   * if another process wins, returns `{ acquired: false }` with the winner.
   */
  private writeAtomic(
    issue: number,
    lockPath: string,
    command: string,
    skipPidCheck?: boolean,
  ): AcquireResult {
    const payload: LockFile = {
      pid: this.pid,
      hostname: this.hostname,
      startedAt: new Date(this.now()).toISOString(),
      command,
      ...(skipPidCheck ? { skipPidCheck: true } : {}),
    };
    const body = JSON.stringify(payload, null, 2);

    let fd: number;
    try {
      // 0o644: world-readable, owner-writable (matches other .sequant files).
      fd = openSync(lockPath, "wx", 0o644);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        const winner = this.readLockSafe(lockPath);
        if (winner) {
          return {
            acquired: false,
            holder: winner,
            lockPath,
            stale: false,
            staleReason: null,
          };
        }
        // File appeared then vanished — fall through to throw below.
      }
      throw err;
    }

    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }

    this.held.add(issue);
    return { acquired: true, lockPath };
  }

  private readLockSafe(lockPath: string): LockFile | null {
    if (!existsSync(lockPath)) return null;
    try {
      const text = readFileSync(lockPath, "utf-8");
      const parsed = LockFileSchema.safeParse(JSON.parse(text));
      if (!parsed.success) return null;
      return parsed.data;
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

  /** True iff the lock file at `path` is missing (test helper). */
  static missing(path: string): boolean {
    return !existsSync(path);
  }

  /** Stat helper for tests — returns mtime or null. */
  static mtime(path: string): Date | null {
    try {
      return statSync(path).mtime;
    } catch {
      return null;
    }
  }
}
