/**
 * #804 AC-7 — liveness plumbing for auto-wait.
 *
 * Separate file from `auto-wait.test.ts` because the heartbeat suite needs a
 * module-level `fs` mock, which would leak into the decision/ladder tests.
 *
 * These cover the surface AC-7 actually depends on and that nothing else
 * exercises: the renderer's `waiting` state transition, and the heartbeat's
 * stall-warning suppression. Both are cases where a silent regression looks
 * exactly like "the feature works" — a stranded `waiting` cell, or a false
 * "no log activity" alarm during a wait the user deliberately asked for.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import { LivenessHeartbeat } from "./heartbeat.js";
import { TTYRenderer } from "../cli-ui/run-renderer.js";
import { formatResetTime } from "../errors.js";

vi.mock("fs", () => ({
  statSync: vi.fn(),
  existsSync: vi.fn(),
}));

const FIXED_NOW = 1_700_000_000_000;

function mockMtime(mtimeMs: number): void {
  vi.mocked(fs.statSync).mockImplementation(
    () => ({ mtimeMs }) as unknown as fs.Stats,
  );
}

describe("#804 AC-7 renderer — auto-wait is a paused phase, not a finished one", () => {
  // Assertions read the rendered live zone rather than renderer internals:
  // what matters is what the user sees during a multi-hour pause.
  function makeRenderer() {
    const out: string[] = [];
    const r = new TTYRenderer({
      stdoutWrite: (s: string) => out.push(s),
      noColor: true,
      now: () => FIXED_NOW,
      wallClock: () => new Date(2026, 6, 26, 11, 0, 0, 0),
      isTTY: true,
      columns: 100,
      liveTickMs: 0,
      noSignalListeners: true,
    });
    r.registerIssue({ issueNumber: 804 });
    r.onEvent({ issue: 804, phase: "qa", event: "start" });
    return { r, frame: () => out.join("") };
  }

  const WAKE = FIXED_NOW + 2 * 60 * 60 * 1000;

  it("a waiting event renders the phase as waiting with its wake time", () => {
    const { r, frame } = makeRenderer();
    r.onEvent({
      issue: 804,
      phase: "qa",
      event: "waiting",
      text: "Rate limited · auto-wait 1/2",
      wakeAtMs: WAKE,
    });

    const out = frame();
    // The wake time must be on the PHASE CELL — AC-7 requires the wake, not
    // just the word "waiting". Derived via formatResetTime rather than a
    // hardcoded clock string so the assertion is timezone-independent, and
    // read off the cell rather than the sub-status (which would only be
    // echoing this test's own `text` input back at it).
    expect(out).toContain(`qa waiting ${formatResetTime(WAKE)}`);
    expect(out).toContain("auto-wait 1/2");
    r.dispose();
  });

  it("the terminal notice (no wakeAtMs) returns the phase to running", () => {
    const { r, frame } = makeRenderer();
    r.onEvent({
      issue: 804,
      phase: "qa",
      event: "waiting",
      text: "waiting…",
      wakeAtMs: WAKE,
    });
    expect(frame()).toContain("qa waiting");

    // The wake notice deliberately omits wakeAtMs — its absence is the signal.
    r.onEvent({ issue: 804, phase: "qa", event: "waiting", text: "done" });

    // Without this, a completed wait leaves a `waiting` cell on screen forever.
    const out = frame();
    expect(out.slice(out.lastIndexOf("qa "))).toContain("qa running");
    r.dispose();
  });

  it("a waiting event never marks the issue failed", () => {
    const { r, frame } = makeRenderer();
    r.onEvent({
      issue: 804,
      phase: "qa",
      event: "waiting",
      text: "waiting…",
      wakeAtMs: WAKE,
    });

    // Regression guard: `waiting` must be handled BEFORE the complete/failed
    // fall-through, which would close out a phase that is merely paused.
    expect(frame()).not.toContain("qa ✘");
    r.dispose();
  });

  it("a phase still completes normally after a wait", () => {
    const { r, frame } = makeRenderer();
    r.onEvent({
      issue: 804,
      phase: "qa",
      event: "waiting",
      text: "waiting…",
      wakeAtMs: WAKE,
    });
    r.onEvent({ issue: 804, phase: "qa", event: "waiting", text: "done" });
    r.onEvent({
      issue: 804,
      phase: "qa",
      event: "complete",
      durationSeconds: 12,
    });

    // The issue reaches a normal terminal state — a prior wait does not strand
    // it in `waiting` or leave the pipeline unfinished.
    const out = frame();
    expect(out).toContain("✔ #804 qa");
    expect(out).toContain("✔ done");
    r.dispose();
  });
});

describe("#804 AC-7 heartbeat — a wait is not a stall", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(fs.statSync).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeHb(now: () => number) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const hb = new LivenessHeartbeat({
      isTTY: true,
      enabled: true,
      pollIntervalMs: 30_000,
      stallThresholdMs: 5 * 60_000,
      now,
      stdoutWrite: (s) => stdout.push(s),
      stderrWrite: (s) => stderr.push(s),
    });
    return { hb, stdout, stderr };
  }

  it("suppresses the false stall warning while auto-waiting", () => {
    let clock = FIXED_NOW;
    const { hb, stdout, stderr } = makeHb(() => clock);
    // An auto-wait writes nothing, so state.json's mtime freezes at the start.
    mockMtime(FIXED_NOW);
    hb.start({ issueNumber: 804, phase: "qa", startedAt: FIXED_NOW });

    hb.pauseForWait({ issueNumber: 804, phase: "qa" }, FIXED_NOW + 3_600_000);

    // Well past the 5-minute stall threshold — without pauseForWait this is
    // exactly when the "no log activity" alarm would fire on a wait the user
    // explicitly asked for.
    clock = FIXED_NOW + 20 * 60_000;
    hb.tickNow();

    expect(stderr.join("")).not.toContain("no log activity");
    const line = stdout.join("");
    expect(line).toContain("rate-limit window");
    expect(line).toContain("resuming at");
    hb.dispose();
  });

  it("restores normal stall detection after the wait ends", () => {
    let clock = FIXED_NOW;
    const { hb, stderr } = makeHb(() => clock);
    mockMtime(FIXED_NOW);
    hb.start({ issueNumber: 804, phase: "qa", startedAt: FIXED_NOW });

    hb.pauseForWait({ issueNumber: 804, phase: "qa" }, FIXED_NOW + 60_000);
    clock = FIXED_NOW + 20 * 60_000;
    hb.tickNow();
    expect(stderr.join("")).not.toContain("no log activity");

    // After resuming, a genuine stall must still be reported — suppression
    // must not be sticky, or auto-wait would permanently disable the #574 alarm.
    hb.resumeFromWait({ issueNumber: 804, phase: "qa" });
    clock = FIXED_NOW + 40 * 60_000;
    hb.tickNow();
    expect(stderr.join("")).toContain("no log activity");
    hb.dispose();
  });

  it("pauseForWait on an untracked phase is a no-op", () => {
    const { hb } = makeHb(() => FIXED_NOW);
    // A late notice arriving after stop() must not resurrect the entry.
    expect(() =>
      hb.pauseForWait({ issueNumber: 999, phase: "qa" }, FIXED_NOW + 1000),
    ).not.toThrow();
    expect(() =>
      hb.resumeFromWait({ issueNumber: 999, phase: "qa" }),
    ).not.toThrow();
    hb.dispose();
  });
});
