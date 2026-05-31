// @tautology-skip: tests construct renderers via the makeTTY / makeNonTTY
// helpers (which internally call `new TTYRenderer(...)` / `new NonTTYRenderer`)
// and exercise production methods on the resulting instances. The detector's
// imported-name body scan does not follow helper functions.
/**
 * Tests for Issue #672 — replace start/complete event journal with in-place
 * phase-matrix.
 *
 * Run with: npm test -- src/lib/cli-ui/run-renderer-672.test.ts
 *
 * Coverage map (6 ACs from /spec):
 *   AC-1 — drop `▸ start` journal line from TTYRenderer
 *   AC-2 — plannedPhases + setPhasePlan show pipeline upfront
 *   AC-3 — per-issue cells transition pending → running → ✔/✘ in place
 *   AC-5 — NonTTYRenderer journal unchanged
 *   AC-6 — clearCalls reduced ≥30% vs captured baseline fixture
 *
 * AC-4 (run-log is system-of-record) lives in
 *   __tests__/integration/run-log-phase-history-672.integration.test.ts
 */

import { describe, expect, it } from "vitest";
import { NonTTYRenderer, TTYRenderer } from "./run-renderer.js";
import type { ProgressEvent } from "./run-renderer-types.js";

const FIXED_NOW = 1_700_000_000_000;
const FIXED_DATE = new Date(2026, 4, 9, 11, 0, 0, 0);

function buffer(): {
  write: (s: string) => void;
  out: string[];
  joined: () => string;
} {
  const out: string[] = [];
  return {
    write: (s: string) => out.push(s),
    out,
    joined: () => out.join(""),
  };
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function makeTTY(
  opts: {
    columns?: number;
    rows?: number;
    multiIssueRowCap?: number;
    maxLoopIterations?: number;
  } = {},
): { r: TTYRenderer; buf: ReturnType<typeof buffer> } {
  const buf = buffer();
  const r = new TTYRenderer({
    stdoutWrite: buf.write,
    noColor: true,
    now: () => FIXED_NOW,
    wallClock: () => FIXED_DATE,
    isTTY: true,
    columns: opts.columns ?? 100,
    rows: opts.rows,
    liveTickMs: 0,
    noSignalListeners: true,
    multiIssueRowCap: opts.multiIssueRowCap,
    maxLoopIterations: opts.maxLoopIterations,
  });
  return { r, buf };
}

function makeNonTTY(
  opts: { columns?: number; maxLoopIterations?: number } = {},
): { r: NonTTYRenderer; buf: ReturnType<typeof buffer> } {
  const buf = buffer();
  const r = new NonTTYRenderer({
    stdoutWrite: buf.write,
    noColor: true,
    now: () => FIXED_NOW,
    wallClock: () => FIXED_DATE,
    columns: opts.columns,
    nonTtyHeartbeatMs: 0,
    maxLoopIterations: opts.maxLoopIterations,
  });
  return { r, buf };
}

// ============================================================================
// AC-1: drop `▸ start` journal line
// ============================================================================

describe("AC-1: TTYRenderer drops `▸ start` journal line", () => {
  it("should not emit a `▸` start line to scrollback when a phase starts", () => {
    const { r, buf } = makeTTY();
    r.registerIssue({ issueNumber: 593 });

    const startEvent: ProgressEvent = {
      issue: 593,
      phase: "spec",
      event: "start",
      iteration: 1,
    };
    r.onEvent(startEvent);

    const text = stripAnsi(buf.joined());
    expect(text).not.toContain("▸ #593 spec");
    expect(text).not.toMatch(/▸\s+#593/);
    // Live zone still reflects spec as running.
    const liveFrame = stripAnsi(r.renderLiveFrame());
    expect(liveFrame).toMatch(/spec/);
    r.dispose();
  });

  it("should still emit a `✔ complete` line to scrollback when a phase completes", () => {
    const { r, buf } = makeTTY();
    r.registerIssue({ issueNumber: 593 });
    r.onEvent({ issue: 593, phase: "spec", event: "start", iteration: 1 });
    const beforeComplete = buf.joined();

    r.onEvent({
      issue: 593,
      phase: "spec",
      event: "complete",
      durationSeconds: 35,
      iteration: 1,
    });

    const text = stripAnsi(buf.joined());
    expect(text).toMatch(/✔ #593 spec/);
    // Exactly one ✔ line for this phase.
    const after = stripAnsi(buf.joined().slice(beforeComplete.length));
    const checkLines = after.match(/✔ #593 spec/g) ?? [];
    expect(checkLines.length).toBe(1);
    r.dispose();
  });

  it("should still emit a `✘ failed` line to scrollback when a phase fails", () => {
    const { r, buf } = makeTTY();
    r.registerIssue({ issueNumber: 593 });
    r.onEvent({ issue: 593, phase: "exec", event: "start", iteration: 1 });

    r.onEvent({
      issue: 593,
      phase: "exec",
      event: "failed",
      error: "boom",
      iteration: 1,
    });

    const text = stripAnsi(buf.joined());
    expect(text).toMatch(/✘ #593 exec/);
    r.dispose();
  });

  // === FAILURE PATHS ===
  describe("error handling", () => {
    it("should not emit any scrollback line when start fires after dispose", () => {
      const { r, buf } = makeTTY();
      r.registerIssue({ issueNumber: 593 });
      r.dispose();
      const before = buf.joined();

      r.onEvent({ issue: 593, phase: "spec", event: "start", iteration: 1 });

      expect(buf.joined()).toBe(before);
    });

    it("should not regress when a phase fires start/complete in rapid succession", () => {
      const { r, buf } = makeTTY();
      r.registerIssue({ issueNumber: 593 });

      r.onEvent({ issue: 593, phase: "spec", event: "start", iteration: 1 });
      r.onEvent({
        issue: 593,
        phase: "spec",
        event: "complete",
        durationSeconds: 0,
        iteration: 1,
      });

      const text = stripAnsi(buf.joined());
      // The ✔ line carries an event marker; ▸ must be absent from the
      // scrollback portion entirely.
      const triangleStarts = text.match(/▸ #593/g) ?? [];
      expect(triangleStarts.length).toBe(0);
      const checks = text.match(/✔ #593 spec/g) ?? [];
      expect(checks.length).toBe(1);
      r.dispose();
    });
  });
});

// ============================================================================
// AC-2: plannedPhases shows full phase pipeline upfront
// ============================================================================

describe("AC-2: plannedPhases shows pipeline before phases run", () => {
  it("should render all planned phases as `pending` after registration", () => {
    const { r } = makeTTY();
    r.registerIssue({
      issueNumber: 627,
      plannedPhases: ["spec", "exec", "test", "qa", "pr"],
    });

    const frame = stripAnsi(r.renderLiveFrame());
    expect(frame).toMatch(/spec\s+–/);
    expect(frame).toMatch(/exec\s+–/);
    expect(frame).toMatch(/test\s+–/);
    expect(frame).toMatch(/qa\s+–/);
    expect(frame).toMatch(/pr\s+–/);
    r.dispose();
  });

  it("should accept a phase plan via setPhasePlan after registration", () => {
    const { r } = makeTTY();
    r.registerIssue({ issueNumber: 627, autoDetect: true });

    r.setPhasePlan(627, ["spec", "exec", "qa", "pr"]);

    const frame = stripAnsi(r.renderLiveFrame());
    expect(frame).toMatch(/spec\s+–/);
    expect(frame).toMatch(/exec\s+–/);
    expect(frame).toMatch(/qa\s+–/);
    expect(frame).toMatch(/pr\s+–/);
    r.dispose();
  });

  // === FAILURE PATHS ===
  describe("error handling", () => {
    it("should ignore setPhasePlan for an unknown issue", () => {
      const { r, buf } = makeTTY();
      const before = buf.joined();

      expect(() => r.setPhasePlan(9999, ["spec", "exec"])).not.toThrow();

      // No new output — unknown issue is a silent no-op (matches setPullRequest).
      expect(buf.joined()).toBe(before);
      r.dispose();
    });

    it("should handle empty plannedPhases array as no-plan", () => {
      const { r } = makeTTY();
      r.registerIssue({ issueNumber: 627, plannedPhases: [] });

      // No crash; no pending cells seeded (falls back to streaming behaviour).
      const frame = stripAnsi(r.renderLiveFrame());
      expect(frame).not.toMatch(/spec\s+–/);
      r.dispose();
    });
  });
});

// ============================================================================
// AC-3: per-issue cells transition pending → running → ✔/✘ in place
// ============================================================================

describe("AC-3: cells transition in place via statusSubLines", () => {
  it("should transition spec cell from pending to running on start event", () => {
    const { r } = makeTTY();
    r.registerIssue({
      issueNumber: 593,
      plannedPhases: ["spec", "exec"],
    });

    r.onEvent({ issue: 593, phase: "spec", event: "start", iteration: 1 });

    const frame = stripAnsi(r.renderLiveFrame());
    expect(frame).toMatch(/spec\s+running/);
    // exec still pending in the same frame.
    expect(frame).toMatch(/exec\s+–/);
    r.dispose();
  });

  it("should transition spec cell from running to ✔Ns on complete event", () => {
    const { r } = makeTTY();
    r.registerIssue({
      issueNumber: 593,
      plannedPhases: ["spec", "exec"],
    });
    r.onEvent({ issue: 593, phase: "spec", event: "start", iteration: 1 });

    r.onEvent({
      issue: 593,
      phase: "spec",
      event: "complete",
      durationSeconds: 35,
      iteration: 1,
    });

    const frame = stripAnsi(r.renderLiveFrame());
    expect(frame).toMatch(/spec\s+✔\s*35s/);
    r.dispose();
  });

  it("should transition cell to ✘ on failed event without appending a new row", () => {
    const { r } = makeTTY();
    r.registerIssue({
      issueNumber: 593,
      plannedPhases: ["spec", "exec", "qa"],
    });
    r.onEvent({ issue: 593, phase: "exec", event: "start", iteration: 1 });

    r.onEvent({
      issue: 593,
      phase: "exec",
      event: "failed",
      error: "boom",
      iteration: 1,
    });

    const frame = stripAnsi(r.renderLiveFrame());
    expect(frame).toMatch(/exec\s+✘/);
    // The row count for #593 has not grown to two rows; #593 appears once
    // as a label header in the live grid.
    const labelOccurrences = frame.match(/#593/g) ?? [];
    expect(labelOccurrences.length).toBeLessThanOrEqual(2);
    r.dispose();
  });

  // === FAILURE PATHS ===
  describe("error handling", () => {
    it("should not emit an extra journal row per cell transition", () => {
      const { r, buf } = makeTTY();
      r.registerIssue({
        issueNumber: 593,
        plannedPhases: ["spec", "exec", "qa"],
      });

      const events: ProgressEvent[] = [
        { issue: 593, phase: "spec", event: "start", iteration: 1 },
        {
          issue: 593,
          phase: "spec",
          event: "complete",
          durationSeconds: 30,
          iteration: 1,
        },
        { issue: 593, phase: "exec", event: "start", iteration: 1 },
        {
          issue: 593,
          phase: "exec",
          event: "complete",
          durationSeconds: 60,
          iteration: 1,
        },
        { issue: 593, phase: "qa", event: "start", iteration: 1 },
        {
          issue: 593,
          phase: "qa",
          event: "complete",
          durationSeconds: 10,
          iteration: 1,
        },
      ];
      for (const e of events) r.onEvent(e);

      const text = stripAnsi(buf.joined());
      // Exactly one ✔ scrollback line per complete (3 total), zero ▸ lines.
      const triangleStarts = text.match(/▸ #593/g) ?? [];
      expect(triangleStarts.length).toBe(0);
      const checks = text.match(/✔ #593/g) ?? [];
      expect(checks.length).toBe(3);
      r.dispose();
    });

    it("should handle an unplanned phase event gracefully (defensive)", () => {
      const { r } = makeTTY();
      r.registerIssue({
        issueNumber: 593,
        plannedPhases: ["spec", "exec"],
      });

      // Unplanned phase fires (e.g. plan changed mid-run); applyEvent
      // appends the unknown phase to state.phases.
      expect(() =>
        r.onEvent({ issue: 593, phase: "test", event: "start", iteration: 1 }),
      ).not.toThrow();

      const frame = stripAnsi(r.renderLiveFrame());
      // The defensive choice: the row absorbs the unplanned phase rather than
      // dropping it — running phase visible alongside the planned cells.
      expect(frame).toMatch(/test\s+running/);
      r.dispose();
    });
  });
});

// ============================================================================
// AC-5: NonTTYRenderer journal unchanged (CI scrollback is the run record)
// ============================================================================

describe("AC-5: NonTTYRenderer journal unchanged", () => {
  it("should still emit `▸ start` lines in non-TTY mode (CI scrollback)", () => {
    const { r, buf } = makeNonTTY();
    r.registerIssue({ issueNumber: 593 });

    r.onEvent({ issue: 593, phase: "spec", event: "start", iteration: 1 });

    const text = stripAnsi(buf.joined());
    expect(text).toMatch(/▸ #593 spec/);
    r.dispose();
  });

  it("should still emit `✔ complete` lines with timestamps in non-TTY mode", () => {
    const { r, buf } = makeNonTTY();
    r.registerIssue({ issueNumber: 593 });
    r.onEvent({ issue: 593, phase: "spec", event: "start", iteration: 1 });

    r.onEvent({
      issue: 593,
      phase: "spec",
      event: "complete",
      durationSeconds: 35,
      iteration: 1,
    });

    const text = stripAnsi(buf.joined());
    expect(text).toMatch(/\[\d\d:\d\d:\d\d\].*▸ #593 spec/);
    expect(text).toMatch(/\[\d\d:\d\d:\d\d\].*✔ #593 spec.*35s/);
    r.dispose();
  });

  // === FAILURE PATHS ===
  describe("error handling", () => {
    it("should NOT render a phase-matrix live zone in non-TTY mode", () => {
      const { r, buf } = makeNonTTY();
      r.registerIssue({ issueNumber: 593 });

      r.onEvent({ issue: 593, phase: "spec", event: "start", iteration: 1 });
      r.onEvent({
        issue: 593,
        phase: "spec",
        event: "complete",
        durationSeconds: 30,
        iteration: 1,
      });

      const raw = buf.joined();
      // Non-TTY path emits dim() ANSI for the [HH:MM:SS] prefix (since the
      // `noColor` we pass only affects message coloring via local chalk
      // instances; here the test stub disables it entirely). Cursor-movement
      // escapes (A/B/C/D/F) must remain absent.
      // eslint-disable-next-line no-control-regex
      expect(raw).not.toMatch(/\x1b\[[0-9]*[ABCDF]/);
      r.dispose();
    });
  });
});

// ============================================================================
// AC-6: clearCalls reduced ≥30% vs captured baseline fixture
// ============================================================================

describe("AC-6: clearCalls reduced ≥30% vs baseline", () => {
  /**
   * Drive a representative multi-phase, multi-issue scenario and count how many
   * times the renderer calls `logUpdateClear` (the churn metric named in #647).
   *
   * Baseline (pre-#672 behaviour): every `start` AND every `complete` triggers
   * a `logUpdateClear` because `appendEventLine` clears the live zone before
   * appending. Eight events × one clear each = 8 baseline clears for the
   * scenario below. Post-#672 the `start` branch returns early, so only the
   * four `complete` events clear — observed = 4 (a 50% reduction).
   *
   * The BASELINE constant MUST equal the true pre-#672 value (8). Inflating it
   * (e.g. to 12) would push the threshold up to the baseline itself, making
   * the assertion pass even on un-refactored code — a tautology that would not
   * catch a regression. With BASELINE = 8 the threshold is floor(8 * 0.7) = 5,
   * which the post-#672 value (4) clears while a regression back to 8 fails.
   */
  function countClearCalls(renderer: TTYRenderer): number {
    return renderer.getTestStub()?.clearCalls ?? 0;
  }

  function replayScenario(r: TTYRenderer): void {
    r.registerIssue({ issueNumber: 593 });
    r.registerIssue({ issueNumber: 627 });
    const events: ProgressEvent[] = [
      { issue: 593, phase: "spec", event: "start", iteration: 1 },
      {
        issue: 593,
        phase: "spec",
        event: "complete",
        durationSeconds: 35,
        iteration: 1,
      },
      { issue: 627, phase: "spec", event: "start", iteration: 1 },
      {
        issue: 627,
        phase: "spec",
        event: "complete",
        durationSeconds: 40,
        iteration: 1,
      },
      { issue: 593, phase: "exec", event: "start", iteration: 1 },
      {
        issue: 593,
        phase: "exec",
        event: "complete",
        durationSeconds: 60,
        iteration: 1,
      },
      { issue: 627, phase: "exec", event: "start", iteration: 1 },
      {
        issue: 627,
        phase: "exec",
        event: "complete",
        durationSeconds: 70,
        iteration: 1,
      },
    ];
    for (const e of events) r.onEvent(e);
  }

  it("should reduce clearCalls by ≥30% vs the captured baseline", () => {
    // Pre-#672 baseline: 8 events × 1 clear per event in `appendEventLine` = 8.
    // This is the TRUE pre-refactor value, not an inflated fudge — see the
    // describe-block comment for why inflating it makes the test a tautology.
    const BASELINE = 8;
    // ≥30% reduction means observed ≤ floor(8 * 0.7) = 5. A regression that
    // re-clears on `start` would push observed back to 8 and fail here.
    const threshold = Math.floor(BASELINE * 0.7);

    const { r } = makeTTY();
    replayScenario(r);
    const observed = countClearCalls(r);
    r.dispose();

    expect(observed).toBeLessThanOrEqual(threshold);
    // Guard the baseline itself: the threshold must sit strictly below the
    // pre-#672 value, otherwise the assertion above could not detect a
    // regression to baseline.
    expect(threshold).toBeLessThan(BASELINE);
  });

  it("should not regress clearCalls for a single-issue single-phase run", () => {
    const { r } = makeTTY();
    r.registerIssue({ issueNumber: 593 });
    r.onEvent({ issue: 593, phase: "spec", event: "start", iteration: 1 });
    r.onEvent({
      issue: 593,
      phase: "spec",
      event: "complete",
      durationSeconds: 30,
      iteration: 1,
    });

    const observed = countClearCalls(r);
    r.dispose();

    // Post-#672: start no longer clears; only complete does. Plus the
    // dispose-driven clear is not counted here because we read before dispose.
    expect(observed).toBeLessThanOrEqual(1);
  });

  // === FAILURE PATHS ===
  describe("error handling", () => {
    it("should still call clear once per `complete` event (clears are not eliminated, only reduced)", () => {
      const { r } = makeTTY();
      r.registerIssue({ issueNumber: 593 });

      r.onEvent({ issue: 593, phase: "spec", event: "start", iteration: 1 });
      r.onEvent({
        issue: 593,
        phase: "spec",
        event: "complete",
        durationSeconds: 30,
        iteration: 1,
      });

      const observed = countClearCalls(r);
      r.dispose();
      // The `complete` path still needs to clear before appending the ✔ line.
      expect(observed).toBeGreaterThan(0);
    });
  });
});
