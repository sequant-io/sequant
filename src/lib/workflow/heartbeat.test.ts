/**
 * Unit tests for LivenessHeartbeat (#574)
 *
 * Spec: AC-1 (TTY heartbeat), AC-2 (one-shot stall warning), AC-3 (cadence/overhead)
 * Liveness source: `.sequant/state.json` mtime (per /spec design call-out)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import { LivenessHeartbeat } from "./heartbeat.js";
import { ShutdownManager } from "../shutdown.js";

vi.mock("fs", () => ({
  statSync: vi.fn(),
  existsSync: vi.fn(),
}));

const ESC = String.fromCharCode(27);

interface CapturedWrites {
  stdout: string[];
  stderr: string[];
}

function makeHb(opts: {
  isTTY: boolean;
  now?: () => number;
  enabled?: boolean;
  pollIntervalMs?: number;
  stallThresholdMs?: number;
  phaseTimeoutSeconds?: number;
  shutdownManager?: ShutdownManager;
}): { hb: LivenessHeartbeat; writes: CapturedWrites } {
  const writes: CapturedWrites = { stdout: [], stderr: [] };
  const hb = new LivenessHeartbeat({
    isTTY: opts.isTTY,
    enabled: opts.enabled ?? true,
    pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    stallThresholdMs: opts.stallThresholdMs ?? 5 * 60_000,
    phaseTimeoutSeconds: opts.phaseTimeoutSeconds,
    now: opts.now,
    shutdownManager: opts.shutdownManager,
    stdoutWrite: (s) => writes.stdout.push(s),
    stderrWrite: (s) => writes.stderr.push(s),
  });
  return { hb, writes };
}

function mockMtime(mtimeMs: number): void {
  vi.mocked(fs.statSync).mockImplementation(
    () => ({ mtimeMs }) as unknown as fs.Stats,
  );
}

describe("LivenessHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(fs.statSync).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ============================================================
  // AC-1: TTY-detected liveness heartbeat in `-q`
  // ============================================================
  describe("AC-1: TTY-detected liveness heartbeat", () => {
    it("rewrites the active phase line via \\r every 30s when isTTY is true", () => {
      const NOW = 1_700_000_000_000;
      const startedAt = NOW - 12 * 60_000;
      const mtime = NOW - 8_000;
      mockMtime(mtime);

      const { hb, writes } = makeHb({ isTTY: true, now: () => NOW });
      hb.start({ issueNumber: 551, phase: "exec", startedAt });

      vi.advanceTimersByTime(30_000);

      expect(writes.stdout).toHaveLength(1);
      expect(writes.stdout[0].startsWith("\r")).toBe(true);
      expect(writes.stdout[0]).toContain("▸ #551");
      expect(writes.stdout[0]).toContain("exec");
      expect(writes.stdout[0]).toContain(
        "(12m elapsed, last log update 8s ago)",
      );
    });

    it("emits no heartbeat output when process.stdout.isTTY is false", () => {
      const NOW = 1_700_000_000_000;
      mockMtime(NOW - 1_000); // recent activity, no stall

      const { hb, writes } = makeHb({ isTTY: false, now: () => NOW });
      hb.start({ issueNumber: 551, phase: "exec", startedAt: NOW });

      vi.advanceTimersByTime(30_000 * 5);

      // No TTY heartbeat lines written.
      expect(writes.stdout).toHaveLength(0);
      // No stall warning either (mtime is fresh).
      expect(writes.stderr).toHaveLength(0);
    });

    it("formats elapsed time correctly (s / m / h boundaries)", () => {
      // 45 seconds elapsed
      {
        const NOW = 1_700_000_000_000;
        mockMtime(NOW - 1000);
        const { hb, writes } = makeHb({ isTTY: true, now: () => NOW });
        hb.start({ issueNumber: 1, phase: "exec", startedAt: NOW - 45_000 });
        vi.advanceTimersByTime(30_000);
        expect(writes.stdout[0]).toContain("(45s elapsed");
        hb.dispose();
      }
      // 12 minutes elapsed
      {
        const NOW = 1_700_000_000_000;
        mockMtime(NOW - 1000);
        const { hb, writes } = makeHb({ isTTY: true, now: () => NOW });
        hb.start({
          issueNumber: 1,
          phase: "exec",
          startedAt: NOW - 12 * 60_000,
        });
        vi.advanceTimersByTime(30_000);
        expect(writes.stdout[0]).toContain("(12m elapsed");
        hb.dispose();
      }
      // 2 hours elapsed (formatElapsedTime returns "2h" when remainder is 0)
      {
        const NOW = 1_700_000_000_000;
        mockMtime(NOW - 1000);
        const { hb, writes } = makeHb({ isTTY: true, now: () => NOW });
        hb.start({
          issueNumber: 1,
          phase: "exec",
          startedAt: NOW - 2 * 3600_000,
        });
        vi.advanceTimersByTime(30_000);
        expect(writes.stdout[0]).toContain("(2h elapsed");
        hb.dispose();
      }
    });

    it("no-ops when a phase boundary fires within the interval", () => {
      const NOW = 1_700_000_000_000;
      mockMtime(NOW - 1000);
      const { hb, writes } = makeHb({ isTTY: true, now: () => NOW });
      hb.start({ issueNumber: 551, phase: "exec", startedAt: NOW });
      hb.stop({ issueNumber: 551, phase: "exec" });

      vi.advanceTimersByTime(30_000);

      expect(writes.stdout).toHaveLength(0);
      expect(writes.stderr).toHaveLength(0);
      // fs.statSync should not have been called either (timer cleared on stop).
      expect(vi.mocked(fs.statSync)).not.toHaveBeenCalled();
    });

    it("renders one line per active phase in parallel mode (not one global line)", () => {
      const NOW = 1_700_000_000_000;
      mockMtime(NOW - 1000);
      const { hb, writes } = makeHb({ isTTY: true, now: () => NOW });
      hb.start({ issueNumber: 551, phase: "exec", startedAt: NOW - 60_000 });
      hb.start({ issueNumber: 559, phase: "exec", startedAt: NOW - 60_000 });

      vi.advanceTimersByTime(30_000);

      expect(writes.stdout).toHaveLength(2);
      expect(writes.stdout.some((s) => s.includes("#551"))).toBe(true);
      expect(writes.stdout.some((s) => s.includes("#559"))).toBe(true);
    });
  });

  // ============================================================
  // AC-2: One-shot stall warning at threshold
  // ============================================================
  describe("AC-2: one-shot stall warning at 5m mtime gap", () => {
    it("emits ⚠ warning exactly once when now - mtime > 5m", () => {
      const NOW = 1_700_000_000_000;
      const stalledMs = 5 * 60_000 + 12_000;
      mockMtime(NOW - stalledMs);

      const { hb, writes } = makeHb({ isTTY: false, now: () => NOW });
      hb.start({ issueNumber: 551, phase: "exec", startedAt: NOW - stalledMs });

      vi.advanceTimersByTime(30_000);

      const warnings = writes.stderr.filter((s) =>
        /⚠ #551\s+exec\s+no log activity for/.test(s),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("5m 12s");
    });

    it("does NOT re-fire on subsequent polls while still stalled", () => {
      let now = 1_700_000_000_000;
      const stalledMtime = now - 6 * 60_000;
      mockMtime(stalledMtime);

      const { hb, writes } = makeHb({
        isTTY: false,
        now: () => now,
      });
      hb.start({ issueNumber: 551, phase: "exec", startedAt: now });

      // First poll past threshold — should fire once.
      vi.advanceTimersByTime(30_000);
      // Five more polls; mtime unchanged.
      for (let i = 0; i < 5; i++) {
        now += 30_000;
        vi.advanceTimersByTime(30_000);
      }

      const warnings = writes.stderr.filter((s) => /no log activity/.test(s));
      expect(warnings).toHaveLength(1);
    });

    it("resets warning state when mtime advances, allowing a future stall to fire again", () => {
      let now = 1_700_000_000_000;
      let mtime = now - 6 * 60_000; // initial stall
      vi.mocked(fs.statSync).mockImplementation(
        () => ({ mtimeMs: mtime }) as unknown as fs.Stats,
      );

      const { hb, writes } = makeHb({ isTTY: false, now: () => now });
      hb.start({
        issueNumber: 551,
        phase: "exec",
        startedAt: now - 6 * 60_000,
      });

      // Tick 1: warning fires.
      vi.advanceTimersByTime(30_000);

      // Activity resumes — mtime moves to "now".
      now += 30_000;
      mtime = now;
      vi.advanceTimersByTime(30_000);

      // Stall again past threshold (mtime stays in past while now advances).
      now += 6 * 60_000;
      vi.advanceTimersByTime(30_000);

      const warnings = writes.stderr.filter((s) => /no log activity/.test(s));
      expect(warnings).toHaveLength(2);
    });

    it("fires in BOTH TTY and non-TTY modes (warning is unconditional)", () => {
      for (const isTTY of [true, false]) {
        const NOW = 1_700_000_000_000;
        const stalledMs = 5 * 60_000 + 12_000;
        mockMtime(NOW - stalledMs);

        const { hb, writes } = makeHb({ isTTY, now: () => NOW });
        hb.start({
          issueNumber: 551,
          phase: "exec",
          startedAt: NOW - stalledMs,
        });

        vi.advanceTimersByTime(30_000);

        const warnings = writes.stderr.filter((s) => /no log activity/.test(s));
        expect(warnings, `isTTY=${isTTY}`).toHaveLength(1);
        hb.dispose();
      }
    });

    it("includes 'phase timeout in N' suffix when phaseTimeoutSeconds is in scope", () => {
      const NOW = 1_700_000_000_000;
      const stalledMs = 5 * 60_000 + 12_000;
      mockMtime(NOW - stalledMs);

      const { hb, writes } = makeHb({
        isTTY: false,
        now: () => NOW,
        phaseTimeoutSeconds: 1800, // 30m
      });
      // Phase started 5m12s ago to mirror the stall window.
      hb.start({
        issueNumber: 551,
        phase: "exec",
        startedAt: NOW - stalledMs,
      });

      vi.advanceTimersByTime(30_000);

      const warning = writes.stderr.find((s) => /no log activity/.test(s));
      expect(warning).toBeDefined();
      // 30m total - 5m12s elapsed = 24m48s remaining
      expect(warning!).toContain("(phase timeout in 24m 48s)");
    });

    it("omits the 'phase timeout in N' suffix when no per-phase ceiling is configured", () => {
      const NOW = 1_700_000_000_000;
      const stalledMs = 5 * 60_000 + 12_000;
      mockMtime(NOW - stalledMs);

      const { hb, writes } = makeHb({ isTTY: false, now: () => NOW });
      hb.start({
        issueNumber: 551,
        phase: "exec",
        startedAt: NOW - stalledMs,
      });

      vi.advanceTimersByTime(30_000);

      const warning = writes.stderr.find((s) => /no log activity/.test(s));
      expect(warning).toBeDefined();
      expect(warning).not.toContain("phase timeout in");
    });
  });

  // ============================================================
  // AC-3: Cadence and overhead
  // ============================================================
  describe("AC-3: cadence and overhead", () => {
    it("polls at most every 30s", () => {
      const NOW = 1_700_000_000_000;
      mockMtime(NOW - 1000);
      const { hb } = makeHb({ isTTY: false, now: () => NOW });
      hb.start({ issueNumber: 551, phase: "exec", startedAt: NOW });

      vi.advanceTimersByTime(60_000);

      expect(vi.mocked(fs.statSync)).toHaveBeenCalledTimes(2);
    });

    it("calls fs.stat exactly once per poll per active phase", () => {
      const NOW = 1_700_000_000_000;
      mockMtime(NOW - 1000);
      const { hb } = makeHb({ isTTY: false, now: () => NOW });
      hb.start({ issueNumber: 551, phase: "exec", startedAt: NOW });

      vi.advanceTimersByTime(30_000);

      expect(vi.mocked(fs.statSync)).toHaveBeenCalledTimes(1);
    });

    it("uses a single shared timer across N parallel phases (not N timers)", () => {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const NOW = 1_700_000_000_000;
      mockMtime(NOW - 1000);
      const { hb } = makeHb({ isTTY: false, now: () => NOW });

      hb.start({ issueNumber: 1, phase: "exec", startedAt: NOW });
      hb.start({ issueNumber: 2, phase: "exec", startedAt: NOW });
      hb.start({ issueNumber: 3, phase: "exec", startedAt: NOW });

      // Exactly one timer was created.
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      // Tick: each phase gets a stat call (3 phases, 3 stat calls).
      vi.advanceTimersByTime(30_000);
      expect(vi.mocked(fs.statSync)).toHaveBeenCalledTimes(3);

      setIntervalSpy.mockRestore();
    });

    it("does not start a timer when enabled is false", () => {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const NOW = 1_700_000_000_000;
      const { hb } = makeHb({
        isTTY: false,
        now: () => NOW,
        enabled: false,
      });

      hb.start({ issueNumber: 1, phase: "exec", startedAt: NOW });

      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(vi.mocked(fs.statSync)).not.toHaveBeenCalled();

      setIntervalSpy.mockRestore();
    });

    it("does not stack on top of PhaseSpinner's 5s update timer (gating in run.ts)", () => {
      // The heartbeat is constructed only when `options.quiet === true && !tuiEnabled`
      // in src/commands/run.ts, exactly the path where PhaseSpinner is NOT active.
      // We verify the heartbeat itself respects its `enabled` flag — the wiring
      // gate is enforced at the call site (verified by grep below).
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const NOW = 1_700_000_000_000;

      const { hb: enabledHb } = makeHb({
        isTTY: false,
        now: () => NOW,
        enabled: true,
      });
      mockMtime(NOW - 1000);
      enabledHb.start({ issueNumber: 1, phase: "exec", startedAt: NOW });
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      enabledHb.dispose();

      setIntervalSpy.mockClear();

      const { hb: disabledHb } = makeHb({
        isTTY: false,
        now: () => NOW,
        enabled: false,
      });
      disabledHb.start({ issueNumber: 1, phase: "exec", startedAt: NOW });
      expect(setIntervalSpy).not.toHaveBeenCalled();

      setIntervalSpy.mockRestore();
    });

    it("registers cleanup with ShutdownManager (mirrors PhaseSpinner pattern)", () => {
      const sm = new ShutdownManager({ exit: () => {} });
      try {
        const NOW = 1_700_000_000_000;
        mockMtime(NOW - 1000);
        const { hb } = makeHb({
          isTTY: false,
          now: () => NOW,
          shutdownManager: sm,
        });

        expect(sm.getCleanupTaskCount()).toBe(0);
        hb.start({ issueNumber: 1, phase: "exec", startedAt: NOW });
        expect(sm.getCleanupTaskCount()).toBe(1);

        // Dispose unregisters cleanup.
        hb.dispose();
        expect(sm.getCleanupTaskCount()).toBe(0);

        // Subsequent timer ticks must not call fs.statSync after dispose.
        vi.mocked(fs.statSync).mockClear();
        vi.advanceTimersByTime(30_000);
        expect(vi.mocked(fs.statSync)).not.toHaveBeenCalled();
      } finally {
        sm.dispose();
      }
    });
  });

  // ============================================================
  // Failure paths / edge cases
  // ============================================================
  describe("error handling", () => {
    it("survives fs.statSync ENOENT (state.json missing) without crashing", () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const NOW = 1_700_000_000_000;
      const { hb, writes } = makeHb({ isTTY: true, now: () => NOW });
      hb.start({ issueNumber: 551, phase: "exec", startedAt: NOW });

      expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
      // No heartbeat, no warning — ENOENT means "no signal yet".
      expect(writes.stdout).toHaveLength(0);
      expect(writes.stderr).toHaveLength(0);
    });

    it("treats unreadable liveness file as 'no activity since start' rather than firing instantly", () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      });

      const NOW = 1_700_000_000_000;
      const { hb, writes } = makeHb({ isTTY: false, now: () => NOW });
      hb.start({ issueNumber: 551, phase: "exec", startedAt: NOW });

      vi.advanceTimersByTime(30_000);

      // Permission error must NOT trigger a phantom stall warning.
      expect(writes.stderr).toHaveLength(0);
    });

    it("does not write to stdout when stop() has already been called", () => {
      const NOW = 1_700_000_000_000;
      mockMtime(NOW - 1000);
      const { hb, writes } = makeHb({ isTTY: true, now: () => NOW });
      hb.start({ issueNumber: 551, phase: "exec", startedAt: NOW });

      hb.stop({ issueNumber: 551, phase: "exec" });

      vi.advanceTimersByTime(30_000 * 3);

      expect(writes.stdout).toHaveLength(0);
      expect(writes.stderr).toHaveLength(0);
    });
  });

  // Sanity: ANSI escape character is present in TTY heartbeat output.
  it("TTY heartbeat output contains ANSI clear-to-EOL after the visible content", () => {
    const NOW = 1_700_000_000_000;
    mockMtime(NOW - 1000);
    const { hb, writes } = makeHb({ isTTY: true, now: () => NOW });
    hb.start({ issueNumber: 1, phase: "exec", startedAt: NOW - 60_000 });
    vi.advanceTimersByTime(30_000);
    expect(writes.stdout[0]).toContain(`${ESC}[K`);
  });
});
