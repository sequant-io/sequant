/**
 * LivenessHeartbeat — `-q` mode liveness signal + stall warning.
 *
 * Surfaces a per-phase liveness line (TTY only) and a one-shot stall warning
 * (TTY and non-TTY) so users can distinguish "agent working" from "process hung"
 * without inspecting `state.json` or `ps`/`lsof`.
 *
 * Liveness source: mtime of `.sequant/state.json` — written 3-10x per phase by
 * `StateManager.saveState()`. Zero new infrastructure.
 *
 * @see Issue #574
 */
import * as fs from "fs";
import { formatElapsedTime } from "../phase-spinner.js";
import type { ShutdownManager } from "../shutdown.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_STALL_THRESHOLD_MS = 5 * 60_000;
const DEFAULT_LIVENESS_FILE = ".sequant/state.json";
const CLEANUP_NAME = "liveness-heartbeat";

export interface LivenessHeartbeatOptions {
  /** Polling cadence for heartbeat ticks. Default: 30_000ms */
  pollIntervalMs?: number;
  /** Stall threshold (mtime gap) before warning fires. Default: 5min */
  stallThresholdMs?: number;
  /** Liveness file whose mtime is the activity proxy. Default: .sequant/state.json */
  livenessFile?: string;
  /** When false, no timer is started (heartbeat fully suppressed). Default: true */
  enabled?: boolean;
  /**
   * Per-phase timeout in seconds, used for the "phase timeout in N" suffix
   * on stall warnings. When omitted, suffix is dropped.
   */
  phaseTimeoutSeconds?: number;
  /** Optional ShutdownManager for graceful cleanup */
  shutdownManager?: ShutdownManager;
  /** Override TTY detection (testing). Default: process.stdout.isTTY */
  isTTY?: boolean;
  /** Override clock (testing). Default: Date.now */
  now?: () => number;
  /** Override stdout writer (testing). Default: process.stdout.write */
  stdoutWrite?: (s: string) => void;
  /** Override stderr writer (testing). Default: process.stderr.write */
  stderrWrite?: (s: string) => void;
}

interface PhaseEntry {
  issueNumber: number;
  phase: string;
  startedAt: number;
  /** Set once a stall warning has fired; cleared when activity resumes. */
  warningFired: boolean;
}

interface PhaseKey {
  issueNumber: number;
  phase: string;
}

function keyFor(k: PhaseKey): string {
  return `${k.issueNumber}:${k.phase}`;
}

/**
 * Format the stall window's elapsed seconds. Floors to whole seconds.
 */
function formatStall(seconds: number): string {
  return formatElapsedTime(Math.floor(seconds));
}

export class LivenessHeartbeat {
  private readonly pollIntervalMs: number;
  private readonly stallThresholdMs: number;
  private readonly livenessFile: string;
  private readonly enabled: boolean;
  private readonly phaseTimeoutSeconds?: number;
  private readonly shutdownManager?: ShutdownManager;
  private readonly tty: boolean;
  private readonly now: () => number;
  private readonly stdoutWrite: (s: string) => void;
  private readonly stderrWrite: (s: string) => void;

  private readonly phases = new Map<string, PhaseEntry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private cleanupRegistered = false;

  constructor(options: LivenessHeartbeatOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.stallThresholdMs =
      options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    this.livenessFile = options.livenessFile ?? DEFAULT_LIVENESS_FILE;
    this.enabled = options.enabled ?? true;
    this.phaseTimeoutSeconds = options.phaseTimeoutSeconds;
    this.shutdownManager = options.shutdownManager;
    this.tty = options.isTTY ?? Boolean(process.stdout.isTTY);
    this.now = options.now ?? Date.now;
    this.stdoutWrite =
      options.stdoutWrite ?? ((s: string) => void process.stdout.write(s));
    this.stderrWrite =
      options.stderrWrite ?? ((s: string) => void process.stderr.write(s));
  }

  /**
   * Begin tracking a phase. Starts the shared poll timer on first call.
   * No-op if `enabled === false`.
   */
  start(entry: PhaseKey & { startedAt: number }): void {
    if (!this.enabled || this.stopped) return;

    const key = keyFor(entry);
    this.phases.set(key, {
      issueNumber: entry.issueNumber,
      phase: entry.phase,
      startedAt: entry.startedAt,
      warningFired: false,
    });

    if (this.timer === null) {
      this.timer = setInterval(() => this.tick(), this.pollIntervalMs);
      // Don't keep the event loop alive solely for the heartbeat.
      if (typeof this.timer.unref === "function") this.timer.unref();
    }

    if (this.shutdownManager && !this.cleanupRegistered) {
      this.shutdownManager.registerCleanup(CLEANUP_NAME, async () => {
        this.dispose();
      });
      this.cleanupRegistered = true;
    }
  }

  /**
   * Stop tracking a specific phase. When the last phase is removed, the timer
   * is cleared so no orphaned polls remain.
   */
  stop(key?: PhaseKey): void {
    if (key) {
      this.phases.delete(keyFor(key));
    } else {
      this.phases.clear();
    }
    if (this.phases.size === 0) {
      this.dispose();
    }
  }

  /**
   * Dispose all tracked phases and clear the timer. Idempotent.
   */
  dispose(): void {
    this.stopped = true;
    this.phases.clear();
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.shutdownManager && this.cleanupRegistered) {
      this.shutdownManager.unregisterCleanup(CLEANUP_NAME);
      this.cleanupRegistered = false;
    }
  }

  /** Test hook: drive a poll synchronously without waiting on real timers. */
  tickNow(): void {
    this.tick();
  }

  private tick(): void {
    if (this.stopped || this.phases.size === 0) return;

    const now = this.now();

    for (const entry of this.phases.values()) {
      let mtimeMs: number | null;
      try {
        const stat = fs.statSync(this.livenessFile);
        mtimeMs = stat.mtimeMs;
      } catch {
        // ENOENT (state.json not yet written) or EACCES — treat as no signal.
        // Skip both heartbeat and stall logic this tick.
        mtimeMs = null;
      }

      if (mtimeMs === null) continue;

      const sinceActivityMs = Math.max(0, now - mtimeMs);
      const elapsedSinceStartMs = Math.max(0, now - entry.startedAt);

      // AC-1: TTY heartbeat line — rewrite via \r.
      if (this.tty) {
        this.writeHeartbeat(entry, elapsedSinceStartMs, sinceActivityMs);
      }

      // AC-2: One-shot stall warning (TTY and non-TTY).
      if (sinceActivityMs >= this.stallThresholdMs) {
        if (!entry.warningFired) {
          this.writeStallWarning(entry, sinceActivityMs, elapsedSinceStartMs);
          entry.warningFired = true;
        }
      } else if (entry.warningFired) {
        // Activity resumed — reset for the next stall window.
        entry.warningFired = false;
      }
    }
  }

  private writeHeartbeat(
    entry: PhaseEntry,
    elapsedSinceStartMs: number,
    sinceActivityMs: number,
  ): void {
    if (this.stopped) return;
    const elapsed = formatElapsedTime(Math.floor(elapsedSinceStartMs / 1000));
    const sinceActivity = formatElapsedTime(Math.floor(sinceActivityMs / 1000));
    // \r rewrites current line; \x1b[K clears the rest in case the new line is
    // shorter than the old one.
    const line = `\r  ▸ #${entry.issueNumber}  ${entry.phase}  (${elapsed} elapsed, last log update ${sinceActivity} ago)[K`;
    this.stdoutWrite(line);
  }

  private writeStallWarning(
    entry: PhaseEntry,
    sinceActivityMs: number,
    elapsedSinceStartMs: number,
  ): void {
    if (this.stopped) return;
    const stallStr = formatStall(sinceActivityMs / 1000);
    let suffix = "";
    if (this.phaseTimeoutSeconds !== undefined) {
      const remaining = this.phaseTimeoutSeconds - elapsedSinceStartMs / 1000;
      if (remaining > 0) {
        suffix = ` (phase timeout in ${formatElapsedTime(Math.floor(remaining))})`;
      }
    }
    // Prefix \r\x1b[K to clear any in-flight TTY heartbeat on this line, then
    // emit the warning on its own line. Non-TTY mode prints leading control
    // chars too — they are inert when not interpreted, and matter for TTY co-
    // existence with the heartbeat rewrite.
    const prefix = this.tty ? "\r[K" : "";
    const line = `${prefix}  ⚠ #${entry.issueNumber}  ${entry.phase}  no log activity for ${stallStr}${suffix}\n`;
    this.stderrWrite(line);
  }
}

/** Convenience factory mirroring `phaseSpinner()`. */
export function livenessHeartbeat(
  options?: LivenessHeartbeatOptions,
): LivenessHeartbeat {
  return new LivenessHeartbeat(options);
}
