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
import {
  LivenessHeartbeat,
  NON_TTY_WAIT_NOTICE_INTERVAL_MS,
} from "./heartbeat.js";
import { NonTTYRenderer, TTYRenderer } from "../cli-ui/run-renderer.js";
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

describe("#860 AC-6 heartbeat — a non-TTY wait emits periodic progress naming the wake time", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(fs.statSync).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const WAKE = FIXED_NOW + 3 * 60 * 60_000;

  function makeNonTtyHb(now: () => number) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const hb = new LivenessHeartbeat({
      isTTY: false,
      enabled: true,
      pollIntervalMs: 30_000,
      now,
      stdoutWrite: (s) => stdout.push(s),
      stderrWrite: (s) => stderr.push(s),
    });
    mockMtime(FIXED_NOW);
    hb.start({ issueNumber: 860, phase: "exec", startedAt: FIXED_NOW });
    hb.pauseForWait({ issueNumber: 860, phase: "exec" }, WAKE);
    return { hb, stdout, stderr };
  }

  it("announces the wait on the first tick with wake time and remaining, as a plain line", () => {
    const { hb, stdout } = makeNonTtyHb(() => FIXED_NOW);
    hb.tickNow();

    expect(stdout).toHaveLength(1);
    const line = stdout[0];
    expect(line).toContain("#860");
    expect(line).toContain("rate-limit window");
    expect(line).toContain(`resuming at ${formatResetTime(WAKE)}`);
    expect(line).toContain("left");
    // Append-only log line: newline-terminated, no cursor control.
    expect(line.endsWith("\n")).toBe(true);
    expect(line).not.toContain("\r");
    expect(line).not.toContain(String.fromCharCode(27));
    hb.dispose();
  });

  it("throttles to the notice interval instead of one line per poll tick", () => {
    let clock = FIXED_NOW;
    const { hb, stdout } = makeNonTtyHb(() => clock);
    hb.tickNow(); // announce

    // Poll ticks inside the throttle window stay silent.
    clock = FIXED_NOW + 30_000;
    hb.tickNow();
    clock = FIXED_NOW + 4 * 60_000;
    hb.tickNow();
    expect(stdout).toHaveLength(1);

    // Once the interval elapses, the next tick re-notices with updated time.
    clock = FIXED_NOW + NON_TTY_WAIT_NOTICE_INTERVAL_MS;
    hb.tickNow();
    expect(stdout).toHaveLength(2);
    expect(stdout[1]).toContain(`resuming at ${formatResetTime(WAKE)}`);
    hb.dispose();
  });

  it("a wait after a resume announces itself immediately again", () => {
    let clock = FIXED_NOW;
    const { hb, stdout } = makeNonTtyHb(() => clock);
    hb.tickNow();
    expect(stdout).toHaveLength(1);

    hb.resumeFromWait({ issueNumber: 860, phase: "exec" });
    // Fresh mtime so the resumed tick doesn't fire an unrelated stall warning.
    mockMtime(FIXED_NOW + 60_000);
    clock = FIXED_NOW + 60_000;
    hb.tickNow();
    expect(stdout).toHaveLength(1); // no wait line while not waiting

    hb.pauseForWait({ issueNumber: 860, phase: "exec" }, WAKE);
    clock = FIXED_NOW + 90_000;
    hb.tickNow();
    expect(stdout).toHaveLength(2); // announced immediately, throttle reset
    hb.dispose();
  });

  it("stall warnings stay suppressed for the whole non-TTY wait", () => {
    let clock = FIXED_NOW;
    const { hb, stderr } = makeNonTtyHb(() => clock);
    clock = FIXED_NOW + 60 * 60_000; // an hour of no state.json writes
    hb.tickNow();
    expect(stderr.join("")).not.toContain("no log activity");
    hb.dispose();
  });
});

describe("#860 AC-6 NonTTYRenderer — waiting events in a background (default-mode) run", () => {
  const WAKE = FIXED_NOW + 3 * 60 * 60_000;

  function makeRenderer(nowRef: { now: number }) {
    const out: string[] = [];
    const r = new NonTTYRenderer({
      stdoutWrite: (s: string) => out.push(s),
      noColor: true,
      now: () => nowRef.now,
      wallClock: () => new Date(2026, 6, 26, 11, 0, 0, 0),
      isTTY: false,
      columns: 100,
      noSignalListeners: true,
    });
    r.registerIssue({ issueNumber: 860 });
    r.onEvent({ issue: 860, phase: "exec", event: "start" });
    return { r, out };
  }

  function waitTick(r: NonTTYRenderer, text: string) {
    r.onEvent({
      issue: 860,
      phase: "exec",
      event: "waiting",
      text,
      wakeAtMs: WAKE,
    });
  }

  it("a waiting tick never prints the failure glyph", () => {
    const nowRef = { now: FIXED_NOW };
    const { r, out } = makeRenderer(nowRef);
    waitTick(r, "Rate limited · auto-wait 1/2");

    // Regression guard: waiting events used to fall through emitEventLine's
    // start/complete/else chain into the failure branch — one spurious
    // `✘ #860 exec` per 15-second tick for the whole multi-hour wait.
    expect(out.join("")).not.toContain("✘");
    r.dispose();
  });

  it("announces the wait once, absorbing the per-tick notices", () => {
    const nowRef = { now: FIXED_NOW };
    const { r, out } = makeRenderer(nowRef);
    waitTick(r, "Rate limited · auto-wait 1/2 — resuming at 14:30");
    const afterFirst = out.length;
    expect(out.join("")).toContain("⏸ #860 exec");
    expect(out.join("")).toContain("resuming at 14:30");

    // The ~15s ticks that follow must not add a line each.
    waitTick(r, "Rate limited · auto-wait 1/2 — resuming at 14:30 · 2h left");
    waitTick(r, "Rate limited · auto-wait 1/2 — resuming at 14:30 · 1h left");
    expect(out.length).toBe(afterFirst);
    r.dispose();
  });

  it("the terminal notice emits a resume line and re-arms the announcement", () => {
    const nowRef = { now: FIXED_NOW };
    const { r, out } = makeRenderer(nowRef);
    waitTick(r, "waiting…");
    r.onEvent({
      issue: 860,
      phase: "exec",
      event: "waiting",
      text: "auto-wait complete",
    });
    expect(out.join("")).toContain("auto-wait complete");

    const before = out.length;
    waitTick(r, "second wait");
    expect(out.length).toBe(before + 1); // announced again for a second wait
    r.dispose();
  });

  it("the 60s heartbeat keeps firing during a wait and names the wake time", () => {
    const nowRef = { now: FIXED_NOW };
    const { r, out } = makeRenderer(nowRef);
    waitTick(r, "waiting…");

    // Waiting ticks are liveness, not progress — they must not hold
    // `lastEventAt` fresh and silence the heartbeat for the whole wait.
    nowRef.now = FIXED_NOW + 61_000;
    r.tickHeartbeatNow();

    const line = out.join("");
    expect(line).toContain("still running");
    expect(line).toContain(`resuming at ${formatResetTime(WAKE)}`);
    expect(line).toContain("left");
    r.dispose();
  });

  it("a normal run's heartbeat is unchanged when nothing waits", () => {
    const nowRef = { now: FIXED_NOW };
    const { r, out } = makeRenderer(nowRef);
    nowRef.now = FIXED_NOW + 61_000;
    r.tickHeartbeatNow();
    const line = out.join("");
    expect(line).toContain("still running: #860 exec");
    expect(line).not.toContain("resuming at");
    r.dispose();
  });
});
