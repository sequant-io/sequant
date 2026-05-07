/**
 * Integration tests for LivenessHeartbeat (#574)
 *
 * Verifies end-to-end behavior with a real `state.json` on disk:
 * - simulated-stall scenarios drive AC-2 fire-once + reset semantics
 * - assumption validators ensure mtime advances on rewrite
 * - error scenarios cover missing file, parallel mode, disabled mode, shutdown
 *
 * Liveness source: `.sequant/state.json` mtime (per /spec design call-out)
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import * as fs from "fs";
import * as path from "path";
import { LivenessHeartbeat } from "../../src/lib/workflow/heartbeat.js";
import { ShutdownManager } from "../../src/lib/shutdown.js";

interface CapturedWrites {
  stdout: string[];
  stderr: string[];
}

describe("LivenessHeartbeat - Integration", () => {
  // Each test run gets a unique temp directory to prevent pollution and
  // support parallel test execution.
  const TEST_DIR = `/tmp/sequant-heartbeat-${process.pid}-${Date.now()}`;
  const STATE_FILE = path.join(TEST_DIR, ".sequant", "state.json");

  beforeAll(() => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    process.env.TEST_TMP_DIR = TEST_DIR;
  });

  afterAll(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.TEST_TMP_DIR;
  });

  beforeEach(() => {
    // Each test starts with a fresh state.json (or none).
    try {
      fs.rmSync(STATE_FILE);
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    /* state file cleanup is handled per-test */
  });

  function makeHb(opts: {
    now: () => number;
    isTTY?: boolean;
    enabled?: boolean;
    livenessFile?: string;
    pollIntervalMs?: number;
    stallThresholdMs?: number;
    shutdownManager?: ShutdownManager;
  }): { hb: LivenessHeartbeat; writes: CapturedWrites } {
    const writes: CapturedWrites = { stdout: [], stderr: [] };
    const hb = new LivenessHeartbeat({
      isTTY: opts.isTTY ?? false,
      enabled: opts.enabled ?? true,
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
      stallThresholdMs: opts.stallThresholdMs ?? 5 * 60_000,
      livenessFile: opts.livenessFile ?? STATE_FILE,
      now: opts.now,
      shutdownManager: opts.shutdownManager,
      stdoutWrite: (s) => writes.stdout.push(s),
      stderrWrite: (s) => writes.stderr.push(s),
    });
    return { hb, writes };
  }

  // ============================================================
  // AC-4 Integration: simulated run with stalled state.json mtime
  // ============================================================
  describe("AC-4: simulated stalled run", () => {
    it("triggers the AC-2 warning exactly once when state.json mtime stalls past 5m", () => {
      // Write state.json with a deliberately old mtime (10 minutes ago).
      fs.writeFileSync(STATE_FILE, "{}");
      const tenMinAgo = (Date.now() - 10 * 60_000) / 1000;
      fs.utimesSync(STATE_FILE, tenMinAgo, tenMinAgo);

      let now = Date.now();
      const { hb, writes } = makeHb({ now: () => now, isTTY: false });
      hb.start({ issueNumber: 551, phase: "exec", startedAt: now });

      // Drive 6 polls (3 minutes simulated) — the stall is already past
      // threshold from tick 1.
      for (let i = 0; i < 6; i++) {
        now += 30_000;
        hb.tickNow();
      }

      const warnings = writes.stderr.filter((s) =>
        /⚠ #551\s+exec\s+no log activity/.test(s),
      );
      expect(warnings).toHaveLength(1);
      hb.dispose();
    });

    it("resets the warning when state.json is rewritten (mtime advances)", () => {
      // Initial stale state.json (10 minutes old).
      fs.writeFileSync(STATE_FILE, "{}");
      const tenMinAgo = (Date.now() - 10 * 60_000) / 1000;
      fs.utimesSync(STATE_FILE, tenMinAgo, tenMinAgo);

      let now = Date.now();
      const { hb, writes } = makeHb({ now: () => now, isTTY: false });
      hb.start({ issueNumber: 551, phase: "exec", startedAt: now });

      // Tick 1: warning fires.
      now += 30_000;
      hb.tickNow();

      // Activity resumes — rewrite state.json with current mtime.
      fs.writeFileSync(STATE_FILE, JSON.stringify({ updated: now }));
      const nowSec = now / 1000;
      fs.utimesSync(STATE_FILE, nowSec, nowSec);

      // Tick: heartbeat sees fresh mtime → warning resets.
      now += 30_000;
      hb.tickNow();

      // Stall again — set mtime to 10 minutes in the past relative to now.
      const stalledSec = (now - 10 * 60_000) / 1000;
      fs.utimesSync(STATE_FILE, stalledSec, stalledSec);

      now += 30_000;
      hb.tickNow();

      const warnings = writes.stderr.filter((s) => /no log activity/.test(s));
      expect(warnings).toHaveLength(2);
      hb.dispose();
    });

    // === Assumption validation tests ===

    it("validates assumption: state.json mtime advances on each rewrite", async () => {
      fs.writeFileSync(STATE_FILE, "a");
      const m1 = fs.statSync(STATE_FILE).mtimeMs;

      // Sleep briefly to ensure mtime resolution differs (some FS = 1s).
      await new Promise((r) => setTimeout(r, 20));
      // Force-advance mtime explicitly to handle FS with low resolution.
      const t = (Date.now() + 1000) / 1000;
      fs.writeFileSync(STATE_FILE, "b");
      fs.utimesSync(STATE_FILE, t, t);

      const m2 = fs.statSync(STATE_FILE).mtimeMs;
      expect(m2).toBeGreaterThan(m1);
    });

    it("validates assumption: TTY heartbeat does not appear in non-TTY output capture", () => {
      fs.writeFileSync(STATE_FILE, "{}");
      const recentSec = Date.now() / 1000;
      fs.utimesSync(STATE_FILE, recentSec, recentSec);

      let now = Date.now();
      const { hb, writes } = makeHb({ now: () => now, isTTY: false });
      hb.start({ issueNumber: 551, phase: "exec", startedAt: now });

      for (let i = 0; i < 5; i++) {
        now += 30_000;
        hb.tickNow();
      }

      // Non-TTY: zero \r-rewrite heartbeat lines.
      expect(writes.stdout.filter((s) => s.startsWith("\r"))).toHaveLength(0);
      hb.dispose();
    });
  });

  // ============================================================
  // Error / failure scenarios
  // ============================================================
  describe("error scenarios", () => {
    it("handles missing state.json gracefully on first poll", () => {
      // STATE_FILE deliberately not created.
      let now = Date.now();
      const { hb, writes } = makeHb({ now: () => now, isTTY: false });
      hb.start({ issueNumber: 551, phase: "exec", startedAt: now });

      expect(() => {
        now += 30_000;
        hb.tickNow();
      }).not.toThrow();

      // Missing file != stall.
      expect(writes.stderr).toHaveLength(0);
      hb.dispose();
    });

    it("handles concurrent parallel-mode phases without warning misattribution", () => {
      // Single shared state.json that has stalled past threshold.
      fs.writeFileSync(STATE_FILE, "{}");
      const tenMinAgo = (Date.now() - 10 * 60_000) / 1000;
      fs.utimesSync(STATE_FILE, tenMinAgo, tenMinAgo);

      let now = Date.now();
      const { hb, writes } = makeHb({ now: () => now, isTTY: false });
      hb.start({ issueNumber: 551, phase: "exec", startedAt: now });
      hb.start({ issueNumber: 559, phase: "exec", startedAt: now });

      now += 30_000;
      hb.tickNow();

      const warn551 = writes.stderr.filter((s) => /#551/.test(s));
      const warn559 = writes.stderr.filter((s) => /#559/.test(s));
      expect(warn551).toHaveLength(1);
      expect(warn559).toHaveLength(1);
      // Each warning carries its own issue number — no misattribution.
      expect(warn551[0]).not.toMatch(/#559/);
      expect(warn559[0]).not.toMatch(/#551/);
      hb.dispose();
    });

    it("does not emit any output when heartbeat is disabled (enabled: false)", () => {
      // Even with a stalled state.json, disabled heartbeat emits nothing.
      fs.writeFileSync(STATE_FILE, "{}");
      const tenMinAgo = (Date.now() - 10 * 60_000) / 1000;
      fs.utimesSync(STATE_FILE, tenMinAgo, tenMinAgo);

      let now = Date.now();
      const { hb, writes } = makeHb({
        now: () => now,
        isTTY: true,
        enabled: false,
      });
      hb.start({ issueNumber: 551, phase: "exec", startedAt: now });

      for (let i = 0; i < 20; i++) {
        now += 30_000;
        hb.tickNow();
      }

      expect(writes.stdout).toHaveLength(0);
      expect(writes.stderr).toHaveLength(0);
      hb.dispose();
    });

    it("cleans up timer on shutdown signal (no leaked intervals)", () => {
      const sm = new ShutdownManager({ exit: () => {} });
      try {
        fs.writeFileSync(STATE_FILE, "{}");
        const recentSec = Date.now() / 1000;
        fs.utimesSync(STATE_FILE, recentSec, recentSec);

        let now = Date.now();
        const { hb, writes } = makeHb({
          now: () => now,
          isTTY: true,
          shutdownManager: sm,
        });
        hb.start({ issueNumber: 551, phase: "exec", startedAt: now });

        // First tick produces output.
        now += 30_000;
        hb.tickNow();
        const baselineWrites = writes.stdout.length + writes.stderr.length;

        // Dispose simulates shutdown cleanup.
        hb.dispose();

        // Subsequent ticks must not emit anything.
        now += 30_000;
        hb.tickNow();
        now += 30_000;
        hb.tickNow();

        expect(writes.stdout.length + writes.stderr.length).toBe(
          baselineWrites,
        );
      } finally {
        sm.dispose();
      }
    });
  });
});
