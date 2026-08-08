/**
 * LockManager — per-issue filesystem lock to prevent concurrent sequant
 * sessions from targeting the same issue (#625).
 *
 * Each lock is a single file at `<locksDir>/<issue>.lock`, claimed via
 * `open(O_CREAT|O_EXCL)`. A separate file (rather than a field inside
 * `state.json`) keeps acquisition atomic — no read-modify-write race.
 *
 * Stale detection (in order):
 *   0. Absolute ceiling (any host, any PID state): `startedAt > maxLockAgeMs
 *      ago` → cleared. Guards against recycled PIDs and SIGKILL leaks (#856).
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
  renameSync,
  linkSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "fs";
import { basename, dirname, join, resolve } from "path";
import { execFileSync } from "child_process";
import * as os from "os";

import {
  DEFAULT_LOCKS_DIR,
  DEFAULT_MAX_LOCK_AGE_MS,
  DEFAULT_SKILL_LOCK_TTL_MS,
  DEFAULT_STALE_AGE_MS,
  LockFileSchema,
  type AcquireResult,
  type LockFile,
  type LockListing,
  type SignalOtherResult,
  type StaleReason,
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
  /**
   * Absolute age ceiling (ms). A lock older than this is stale regardless of
   * host, PID liveness, or `skipPidCheck`. Default 24h. See
   * `DEFAULT_MAX_LOCK_AGE_MS` (#856).
   */
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

/** Detect orchestrator mode purely from env (no caching) so tests can mutate. */
export function isOrchestratorMode(): boolean {
  return Boolean(process.env.SEQUANT_ORCHESTRATOR);
}

/**
 * Resolve the checkout root shared by the main worktree and every linked
 * worktree of the same repository (#909). `--git-common-dir` (unlike
 * `--show-toplevel`) points at the same physical `.git` for all of them, so
 * a linked worktree lands on the main checkout's `.sequant/locks` instead of
 * growing its own — matching what `pre-tool.sh`'s checkout guard reads.
 * Returns `null` outside a git repository (or if `git` is unavailable).
 */
function resolveGitCheckoutRoot(cwd: string): string | null {
  try {
    const commonDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return commonDir ? dirname(commonDir) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the locks directory. Priority: explicit option > `SEQUANT_LOCKS_DIR`
 * > the shared git checkout root (#909) > plain cwd-relative (non-git
 * fallback, preserves pre-#909 behavior).
 */
export function resolveLocksDir(explicit?: string): string {
  const fromEnv = process.env.SEQUANT_LOCKS_DIR;
  if (explicit !== undefined || fromEnv !== undefined) {
    return resolve(explicit ?? fromEnv ?? DEFAULT_LOCKS_DIR);
  }
  const gitRoot = resolveGitCheckoutRoot(process.cwd());
  return resolve(gitRoot ?? process.cwd(), DEFAULT_LOCKS_DIR);
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

/**
 * Resolve `SEQUANT_MAX_LOCK_AGE_MS` (milliseconds) — env override for the
 * absolute lock-age ceiling (#856). Returns `null` when unset or unparseable
 * so the caller can fall back to the constructor option / default. Mirrors
 * `resolveSkillLockTtlMs`.
 */
export function resolveMaxLockAgeMs(): number | null {
  const raw = process.env.SEQUANT_MAX_LOCK_AGE_MS;
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
  /** Absolute ceiling; falls back to `DEFAULT_MAX_LOCK_AGE_MS`. */
  maxLockAgeMs?: number;
  isPidAlive: (pid: number) => boolean;
}): StaleReason | null {
  const { holder, myHostname, now, staleAgeMs, isPidAlive } = args;
  const skillTtl = args.skillLockTtlMs ?? staleAgeMs;
  const maxAge = args.maxLockAgeMs ?? DEFAULT_MAX_LOCK_AGE_MS;
  const ageMs = now - Date.parse(holder.startedAt);
  const ageKnown = Number.isFinite(ageMs);

  // 0. Absolute ceiling, checked FIRST and unconditionally (#856). The
  //    same-host branch below treats a live PID as proof of freshness, but a
  //    PID is only a stable identity while its process lives — once the OS
  //    recycles it, an abandoned lock points at an unrelated process and
  //    reads as fresh forever. Nothing legitimate holds a lock this long
  //    (24h vs a 30-minute phase timeout), so age wins over PID liveness
  //    past the ceiling. Also the sole recovery path for locks leaked by a
  //    SIGKILLed run, whose release handlers never got to run.
  if (ageKnown && ageMs > maxAge) return "max-age-exceeded";

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
  if (!ageKnown) return null;
  if (ageMs > ttl) return "age-exceeded";
  return null;
}

/** The fields that uniquely identify a lock's holder (any lock class). */
export interface StaleLockIdentity {
  pid: number;
  hostname: string;
  startedAt: string;
}

/** Read just the identity fields of a lock file. Null if missing/unparseable. */
function readLockIdentity(lockPath: string): StaleLockIdentity | null {
  if (!existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf-8"));
    if (
      parsed &&
      typeof parsed.pid === "number" &&
      typeof parsed.hostname === "string" &&
      typeof parsed.startedAt === "string"
    ) {
      return {
        pid: parsed.pid,
        hostname: parsed.hostname,
        startedAt: parsed.startedAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Best-effort unlink for a steal's private `tmp` file. Failure to remove it is
 * never worth crashing `acquire` over — the orphan sweep below reclaims it.
 */
function unlinkBestEffort(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best-effort: swept later by sweepStealOrphans.
  }
}

/**
 * Age past which a `<lock>.steal.<pid>.<ts>` file cannot be an in-flight steal
 * (the live window is microseconds) and is reclaimed as an orphan.
 */
const STEAL_ORPHAN_TTL_MS = 10 * 60 * 1000;

/**
 * Reap aged `*.steal.*` orphans left behind by lost restore races (the
 * documented EEXIST branch below). Best-effort throughout: steals are the only
 * producer and the only consumer, `list()` never sees these files, and a
 * failure here must not affect the steal itself.
 */
function sweepStealOrphans(lockPath: string, now: number): void {
  const prefix = `${basename(lockPath)}.steal.`;
  try {
    const dir = dirname(lockPath);
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const orphan = join(dir, name);
      try {
        if (now - statSync(orphan).mtimeMs > STEAL_ORPHAN_TTL_MS) {
          unlinkSync(orphan);
        }
      } catch {
        // Raced away or unreadable — skip it.
      }
    }
  } catch {
    // Locks dir unreadable — nothing to sweep.
  }
}

/**
 * Atomically steal a stale lock (#908) — the compare-and-swap replacement for
 * the old unlink-then-create, shared by both lock classes so they cannot drift
 * (AC-1, AC-2).
 *
 * `unlink(lockPath)` removes whatever inode is at the path — including a fresh
 * lock a winner created microseconds earlier — so two sessions that both
 * classified the same lock stale could each destroy the other's fresh lock and
 * both "win" (two holders, the exact failure the lock exists to prevent). A
 * bare `rename(lockPath, …)` has the identical flaw: rename moves whatever is
 * at the path, fresh or not.
 *
 * So take possession atomically, THEN check identity:
 *
 *   1. `rename(lockPath → tmp)` — atomic on POSIX. Of two racing stealers,
 *      exactly one moves the current inode; the loser gets `ENOENT`.
 *   2. Read what we moved. If it is the stale holder we `classified`, discard
 *      it (`unlink tmp`) — the steal is legitimate and `lockPath` is now free
 *      for the caller's terminal `openSync(…, "wx")` to claim.
 *   3. If it is NOT that holder, a fresh lock appeared between our staleness
 *      read and our rename. We must not destroy it: `link` it back into place
 *      (never overwrites) and report the steal lost. A third session that
 *      claimed `lockPath` in the gap is left intact and our copy becomes a
 *      harmless `*.steal.*` orphan, which `list()` ignores (it matches only
 *      `.lock`).
 *
 * Returns `true` only when this caller legitimately removed the stale lock it
 * classified. `false` means "lost" — the caller falls through to `writeAtomic`,
 * whose `O_CREAT|O_EXCL` arbitrates the real holder (accepting the current
 * occupant on `EEXIST`).
 *
 * NOTE ON DEVIATION FROM THE #908 SPEC: the plan prescribed a *plain*
 * rename-away ("rename, unlink tmp, ENOENT = lost", then fall through). That is
 * behaviorally identical to the `unlink` it replaces — verified by a
 * hand-driven interleave: in the issue's own documented ordering
 * (`A.steal → A.create → B.steal → B.create`) B's rename succeeds on A's fresh
 * lock and destroys it, two holders, same as today. The identity check in
 * step 2/3 is what actually makes AC-1 ("loser cannot remove the winner's fresh
 * lock") hold and makes AC-4's mutation test possible.
 *
 * RESIDUAL: the sub-millisecond window at step 3 where a third session's
 * O_EXCL create races our `link`-back is not fully closed — plain lock files
 * admit no atomic compare-and-swap on content. It is far narrower than the
 * original (which failed on a *single* race, every time a stealer's removal
 * landed on a fresh lock) and never destroys a live lock. Fully closing it is a
 * larger protocol change (claim file / lease), flagged for follow-up.
 *
 * NEVER THROWS. A steal is an opportunistic optimization on the acquire path;
 * no filesystem error here is worth crashing `acquire` over. Errors degrade to
 * "lost" (`false`) and the caller's terminal create surfaces any real
 * environment problem (EACCES etc.) with the same errno the pre-#908 path did.
 * The one active recovery: if the `link`-back restore fails because the
 * filesystem refuses hard links (EPERM/ENOTSUP), fall back to renaming `tmp`
 * back into place — leaving a fresh lock renamed-away IS the two-holder bug,
 * so restoring it outweighs `link`'s no-overwrite guarantee on such a
 * filesystem.
 *
 * `ops` is a test seam for the link/rename syscalls — production callers omit
 * it. Injecting a failing `link` is the only way to drive the fallback branch
 * deterministically (capability errors like ENOTSUP cannot be provoked on a
 * normal tmpdir).
 */
export function stealStaleLock(
  lockPath: string,
  classified: StaleLockIdentity,
  self: { pid: number; now: number },
  ops: { link?: typeof linkSync; rename?: typeof renameSync } = {},
): boolean {
  const rename = ops.rename ?? renameSync;
  const link = ops.link ?? linkSync;
  const tmp = `${lockPath}.steal.${self.pid}.${self.now}`;

  sweepStealOrphans(lockPath, self.now);

  try {
    rename(lockPath, tmp);
  } catch {
    // ENOENT: another stealer moved it first — cleanly lost. Anything else
    // (EACCES, EROFS, …): nothing was moved, so there is nothing to restore;
    // report lost and let the terminal create surface the environment problem.
    return false;
  }

  const moved = readLockIdentity(tmp);
  if (
    moved &&
    moved.pid === classified.pid &&
    moved.hostname === classified.hostname &&
    moved.startedAt === classified.startedAt
  ) {
    unlinkBestEffort(tmp);
    return true;
  }

  // A fresh (or corrupt) holder slipped in between our read and our rename.
  // Put back exactly what we took, without overwriting a newer claim, then
  // lose the steal.
  try {
    link(tmp, lockPath);
    unlinkBestEffort(tmp);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOENT") {
      // Hard links refused (EPERM/ENOTSUP/…) — restore by rename instead.
      // The overwrite risk this reintroduces needs a third session's create
      // to land in this same sub-ms window ON a no-hardlink filesystem;
      // not restoring at all destroys the fresh lock every time.
      try {
        rename(tmp, lockPath);
      } catch {
        // Out of options — degrades to pre-#908 behavior on this filesystem.
      }
    }
    // EEXIST: `lockPath` was re-claimed in the gap → leave `tmp` as an orphan
    // (swept by sweepStealOrphans) rather than clobber the new holder.
    // ENOENT: `tmp` already gone.
  }
  return false;
}

export class LockManager {
  private readonly locksDir: string;
  private readonly staleAgeMs: number;
  private readonly skillLockTtlMs: number;
  private readonly maxLockAgeMs: number;
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
        maxLockAgeMs: this.maxLockAgeMs,
        isPidAlive: this.isPidAlive,
      });
      if (staleReason) {
        // Compare-and-swap steal, not a blind unlink (#908): only remove the
        // stale inode we classified, never a fresh lock a racing winner may
        // have created at this path in the meantime. Win or lose, fall through
        // to `writeAtomic` — its `O_CREAT|O_EXCL` arbitrates the real holder.
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
   * SIGTERM the prior PID iff it is alive on this host. The `reason` discriminator
   * lets callers produce accurate log lines for each refusal branch (#637).
   * No-op in orchestrator mode or for cross-host holders.
   */
  signalOther(
    holder: LockFile,
    signal: NodeJS.Signals = "SIGTERM",
  ): SignalOtherResult {
    if (this.orchestratorMode) return { sent: false, reason: "orchestrator" };
    if (holder.hostname !== this.hostname) {
      return { sent: false, reason: "cross-host" };
    }
    // Defense-in-depth: never signal ourselves or our parent. A real lock
    // file's pid should never match this process or its parent; a malformed
    // file or recycled PID could otherwise let us SIGTERM our own shell
    // (#637, defense follow-up to the #633 flake).
    if (holder.pid === this.pid || holder.pid === process.ppid) {
      return { sent: false, reason: "self-or-parent" };
    }
    // #856: past the absolute ceiling, the PID is no longer trustworthy
    // identity — the OS has almost certainly recycled it onto an unrelated
    // process. `acquire` already treats such a lock as abandoned; signalling
    // it would kill a stranger's program on behalf of a lock nobody holds.
    // The liveness probe below cannot catch this: a recycled PID *is* alive.
    const ageMs = this.now() - Date.parse(holder.startedAt);
    if (Number.isFinite(ageMs) && ageMs > this.maxLockAgeMs) {
      return { sent: false, reason: "stale-pid-untrusted" };
    }
    if (!this.isPidAlive(holder.pid))
      return { sent: false, reason: "pid-dead" };
    try {
      process.kill(holder.pid, signal);
      return { sent: true, reason: "sent" };
    } catch {
      return { sent: false, reason: "kill-failed" };
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
        maxLockAgeMs: this.maxLockAgeMs,
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
        maxLockAgeMs: this.maxLockAgeMs,
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
