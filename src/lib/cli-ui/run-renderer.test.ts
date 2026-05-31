/**
 * RunRenderer unit + snapshot tests (#618).
 *
 * Covers:
 *   - AC-1: single owner — no PhaseSpinner output, only renderer events
 *   - AC-2: no duplicate phase-completion lines (single-issue run lifecycle)
 *   - AC-3: no overwritten / appended-inline lines (events end with \n)
 *   - AC-4: live zone redraws on event; ≤1Hz throttling on timer ticks
 *   - AC-5/6/7: active vs done status cells + rollup line
 *   - AC-8: heartbeat tick updates elapsed counter without an event
 *   - AC-9/16/17: non-TTY append-only with [HH:MM:SS] + 60s heartbeat
 *   - AC-11: single-issue key:value layout
 *   - AC-12-15: summary grid passed/failed rows + rollup
 *   - AC-18: SEQUANT_ORCHESTRATOR → no-op renderer (no stdout)
 *   - AC-22: qa loop iteration in status header
 *   - AC-25: <80 col fallback (no box drawing)
 *   - AC-32: width handling at 60/80/120 cols
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NonTTYRenderer,
  OrchestratorRenderer,
  TTYRenderer,
  createRunRenderer,
  renderRunSummary,
} from "./run-renderer.js";
import { formatElapsedTime, formatTimestamp } from "./format.js";

const FIXED_NOW = 1_700_000_000_000;
// Construct via local-time components so `getHours()` returns 11 in any timezone
// (CI runs in UTC, dev may be in any TZ — using `new Date("…Z")` would render
// differently and cause snapshot mismatches).
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
  // Minimal ANSI stripper for snapshot stability.
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("formatElapsedTime", () => {
  it("formats sub-minute durations as Ns", () => {
    expect(formatElapsedTime(0)).toBe("0s");
    expect(formatElapsedTime(45)).toBe("45s");
  });

  it("formats sub-hour durations as Nm Ms", () => {
    expect(formatElapsedTime(75)).toBe("1m 15s");
    expect(formatElapsedTime(120)).toBe("2m");
  });

  it("formats hour-plus durations as Nh Mm", () => {
    expect(formatElapsedTime(3725)).toBe("1h 2m");
    expect(formatElapsedTime(7200)).toBe("2h");
  });

  it("clamps negatives to 0", () => {
    expect(formatElapsedTime(-10)).toBe("0s");
  });
});

describe("formatTimestamp", () => {
  it("zero-pads HH:MM:SS", () => {
    const d = new Date(2026, 4, 9, 9, 5, 3);
    expect(formatTimestamp(d)).toBe("09:05:03");
  });
});

describe("OrchestratorRenderer (AC-18)", () => {
  it("does not write to stdout when SEQUANT_ORCHESTRATOR is set", () => {
    const buf = buffer();
    const errBuf = buffer();
    const r = new OrchestratorRenderer({
      stdoutWrite: buf.write,
      stderrWrite: errBuf.write,
      noColor: true,
      now: () => FIXED_NOW,
    });
    r.registerIssue({ issueNumber: 614 });
    r.onEvent({ issue: 614, phase: "spec", event: "start" });
    r.onEvent({
      issue: 614,
      phase: "spec",
      event: "complete",
      durationSeconds: 60,
    });
    r.renderSummary({
      issues: [
        {
          issueNumber: 614,
          success: true,
          durationSeconds: 60,
          phases: [{ name: "spec", success: true }],
        },
      ],
      totalDurationSeconds: 60,
    });
    r.dispose();
    expect(buf.joined()).toBe("");
    expect(errBuf.joined()).toBe("");
  });
});

describe("createRunRenderer auto-detection", () => {
  let originalOrchestrator: string | undefined;

  beforeEach(() => {
    originalOrchestrator = process.env.SEQUANT_ORCHESTRATOR;
  });
  afterEach(() => {
    if (originalOrchestrator === undefined) {
      delete process.env.SEQUANT_ORCHESTRATOR;
    } else {
      process.env.SEQUANT_ORCHESTRATOR = originalOrchestrator;
    }
  });

  it("returns OrchestratorRenderer when SEQUANT_ORCHESTRATOR is set", () => {
    process.env.SEQUANT_ORCHESTRATOR = "1";
    const r = createRunRenderer({
      stdoutWrite: () => {},
      noSignalListeners: true,
    });
    expect(r).toBeInstanceOf(OrchestratorRenderer);
    r.dispose();
  });

  it("returns TTYRenderer when isTTY is true and orchestrator unset", () => {
    delete process.env.SEQUANT_ORCHESTRATOR;
    const r = createRunRenderer({
      stdoutWrite: () => {},
      isTTY: true,
      noSignalListeners: true,
      liveTickMs: 0,
    });
    expect(r).toBeInstanceOf(TTYRenderer);
    r.dispose();
  });

  it("returns NonTTYRenderer when isTTY is false", () => {
    delete process.env.SEQUANT_ORCHESTRATOR;
    const r = createRunRenderer({
      stdoutWrite: () => {},
      isTTY: false,
      nonTtyHeartbeatMs: 0,
    });
    expect(r).toBeInstanceOf(NonTTYRenderer);
    r.dispose();
  });

  it("respects explicit mode override", () => {
    const r = createRunRenderer({
      mode: "non-tty",
      stdoutWrite: () => {},
      nonTtyHeartbeatMs: 0,
    });
    expect(r).toBeInstanceOf(NonTTYRenderer);
    r.dispose();
  });
});

describe("NonTTYRenderer", () => {
  it("emits one [HH:MM:SS]-prefixed line per phase event (AC-9/16)", () => {
    const buf = buffer();
    const r = new NonTTYRenderer({
      stdoutWrite: buf.write,
      noColor: true,
      now: () => FIXED_NOW,
      wallClock: () => FIXED_DATE,
      nonTtyHeartbeatMs: 0,
    });
    r.registerIssue({ issueNumber: 614 });
    r.onEvent({ issue: 614, phase: "spec", event: "start" });
    r.onEvent({
      issue: 614,
      phase: "spec",
      event: "complete",
      durationSeconds: 60,
    });
    r.dispose();

    const stripped = stripAnsi(buf.joined());
    const lines = stripped.split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\]/);
    }
    expect(lines[0]).toMatch(/▸ #614 spec/);
    expect(lines[1]).toMatch(/✔ #614 spec 1m/);
  });

  it("AC-2: produces no duplicate completion lines for single-issue run", () => {
    const buf = buffer();
    const r = new NonTTYRenderer({
      stdoutWrite: buf.write,
      noColor: true,
      now: () => FIXED_NOW,
      wallClock: () => FIXED_DATE,
      nonTtyHeartbeatMs: 0,
    });
    r.registerIssue({ issueNumber: 614 });
    for (const phase of ["spec", "exec", "qa"]) {
      r.onEvent({ issue: 614, phase, event: "start" });
      r.onEvent({
        issue: 614,
        phase,
        event: "complete",
        durationSeconds: 30,
      });
    }
    r.dispose();

    const stripped = stripAnsi(buf.joined());
    const completionLines = stripped
      .split("\n")
      .filter((line) => line.includes("✔ #614"));
    // Exactly one completion line per phase, no duplicates.
    expect(completionLines.length).toBe(3);
    expect(completionLines[0]).toContain("spec");
    expect(completionLines[1]).toContain("exec");
    expect(completionLines[2]).toContain("qa");
  });

  it("AC-3: every emitted line ends with \\n (no inline appends)", () => {
    const buf = buffer();
    const r = new NonTTYRenderer({
      stdoutWrite: buf.write,
      noColor: true,
      now: () => FIXED_NOW,
      wallClock: () => FIXED_DATE,
      nonTtyHeartbeatMs: 0,
    });
    r.registerIssue({ issueNumber: 614 });
    // Fire two events back-to-back.
    r.onEvent({ issue: 614, phase: "spec", event: "start" });
    r.onEvent({
      issue: 614,
      phase: "spec",
      event: "complete",
      durationSeconds: 1,
    });
    r.onEvent({ issue: 614, phase: "exec", event: "start" });
    r.dispose();

    for (const chunk of buf.out) {
      expect(chunk.endsWith("\n")).toBe(true);
    }
  });

  it("AC-17: heartbeat fires when no event for >= heartbeatMs", () => {
    const buf = buffer();
    let now = FIXED_NOW;
    const r = new NonTTYRenderer({
      stdoutWrite: buf.write,
      noColor: true,
      now: () => now,
      wallClock: () => FIXED_DATE,
      nonTtyHeartbeatMs: 60_000,
    });
    r.registerIssue({ issueNumber: 614 });
    r.onEvent({ issue: 614, phase: "exec", event: "start" });

    // First tick at +59s — should NOT fire (under threshold).
    now = FIXED_NOW + 59_000;
    r.tickHeartbeatNow();
    let lines = stripAnsi(buf.joined()).split("\n").filter(Boolean);
    expect(lines.filter((l) => l.includes("still running"))).toHaveLength(0);

    // Second tick at +61s — SHOULD fire.
    now = FIXED_NOW + 61_000;
    r.tickHeartbeatNow();
    lines = stripAnsi(buf.joined()).split("\n").filter(Boolean);
    const heartbeats = lines.filter((l) => l.includes("still running"));
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]).toMatch(/#614 exec/);
    r.dispose();
  });

  it("AC-31: snapshot of full lifecycle (queued → running → done; passed run)", () => {
    const buf = buffer();
    const r = new NonTTYRenderer({
      stdoutWrite: buf.write,
      noColor: true,
      now: () => FIXED_NOW,
      wallClock: () => FIXED_DATE,
      nonTtyHeartbeatMs: 0,
    });
    r.registerIssue({ issueNumber: 614 });
    r.onEvent({ issue: 614, phase: "spec", event: "start" });
    r.onEvent({
      issue: 614,
      phase: "spec",
      event: "complete",
      durationSeconds: 313,
    });
    r.onEvent({ issue: 614, phase: "exec", event: "start" });
    r.onEvent({
      issue: 614,
      phase: "exec",
      event: "complete",
      durationSeconds: 600,
    });
    r.onEvent({ issue: 614, phase: "qa", event: "start" });
    r.onEvent({
      issue: 614,
      phase: "qa",
      event: "complete",
      durationSeconds: 177,
    });
    r.setPullRequest(614, 615, "https://github.com/x/y/pull/615");
    r.renderSummary({
      issues: [
        {
          issueNumber: 614,
          success: true,
          durationSeconds: 1090,
          phases: [
            { name: "spec", success: true },
            { name: "exec", success: true },
            { name: "qa", success: true },
          ],
          prNumber: 615,
          prUrl: "https://github.com/x/y/pull/615",
        },
      ],
      totalDurationSeconds: 1090,
    });
    r.dispose();

    expect(stripAnsi(buf.joined())).toMatchSnapshot();
  });

  it("AC-31: snapshot of failed run", () => {
    const buf = buffer();
    const r = new NonTTYRenderer({
      stdoutWrite: buf.write,
      noColor: true,
      now: () => FIXED_NOW,
      wallClock: () => FIXED_DATE,
      nonTtyHeartbeatMs: 0,
    });
    r.registerIssue({ issueNumber: 606 });
    r.onEvent({ issue: 606, phase: "qa", event: "start" });
    r.onEvent({
      issue: 606,
      phase: "qa",
      event: "failed",
      error: "AC_NOT_MET",
    });
    r.renderSummary({
      issues: [
        {
          issueNumber: 606,
          success: false,
          durationSeconds: 528,
          phases: [{ name: "qa", success: false }],
          failureReason: "qa max-iters",
          qaVerdict: "AC_NOT_MET",
          unmetCount: 3,
        },
      ],
      totalDurationSeconds: 528,
    });
    r.dispose();

    expect(stripAnsi(buf.joined())).toMatchSnapshot();
  });
});

describe("TTYRenderer", () => {
  function makeTTY(
    opts: {
      columns?: number;
      liveTickMs?: number;
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
      liveTickMs: opts.liveTickMs ?? 0,
      noSignalListeners: true,
    });
    return { r, buf };
  }

  it("AC-1/3 (post-#672): appends one event line per `complete`/`failed`; `start` no longer appends", () => {
    // #672 AC-1: TTYRenderer drops the permanent `▸ start` scrollback line —
    // the live zone already shows the phase as running, so the journal only
    // records terminal transitions (`✔ complete` / `✘ failed`).
    const { r, buf } = makeTTY();
    r.registerIssue({ issueNumber: 614 });
    r.onEvent({ issue: 614, phase: "spec", event: "start" });
    r.onEvent({
      issue: 614,
      phase: "spec",
      event: "complete",
      durationSeconds: 313,
    });
    r.onEvent({ issue: 614, phase: "exec", event: "start" });
    r.dispose();

    const stripped = stripAnsi(buf.joined());
    const eventLines = stripped.split("\n").filter(
      (l) =>
        /▸ #614/.test(l) || // ▸
        /✔ #614/.test(l), // ✔
    );
    expect(eventLines).toEqual(["  ✔ #614 spec  5m 13s"]);
  });

  it("AC-2: lifecycle produces NO duplicate phase-completion lines", () => {
    const { r, buf } = makeTTY();
    r.registerIssue({ issueNumber: 614 });
    for (const phase of ["spec", "exec", "qa"]) {
      r.onEvent({ issue: 614, phase, event: "start" });
      r.onEvent({
        issue: 614,
        phase,
        event: "complete",
        durationSeconds: 30,
      });
    }
    r.dispose();
    const stripped = stripAnsi(buf.joined());
    const completionLines = stripped
      .split("\n")
      .filter((l) => /✔ #614/.test(l));
    expect(completionLines).toHaveLength(3);
  });

  it("AC-11: single-issue frame uses key:value layout with Issue/Worktree/Branch/Status", () => {
    const { r } = makeTTY({ columns: 100 });
    r.registerIssue({
      issueNumber: 614,
      title: "resolve-npm-audit-findings",
      worktreePath: "../worktrees/feature/614-resolve-npm-audit-findings",
      branch: "feature/614-resolve-npm-audit-findings",
    });
    const frame = stripAnsi(r.renderLiveFrame(100));
    expect(frame).toContain("Issue");
    expect(frame).toContain("#614 — resolve-npm-audit-findings");
    expect(frame).toContain("Worktree");
    expect(frame).toContain("Branch");
    expect(frame).toContain("Status");
    // Box drawing present.
    expect(frame).toContain("┌");
    expect(frame).toContain("└");
    r.dispose();
  });

  it("AC-5/6/7: multi-issue frame collapses done rows + shows rollup", () => {
    const { r } = makeTTY({ columns: 100 });
    r.registerIssue({ issueNumber: 614 });
    r.registerIssue({ issueNumber: 610 });
    r.registerIssue({ issueNumber: 606 });

    // 614 done.
    r.onEvent({ issue: 614, phase: "spec", event: "start" });
    r.onEvent({
      issue: 614,
      phase: "spec",
      event: "complete",
      durationSeconds: 60,
    });
    r.onEvent({ issue: 614, phase: "exec", event: "start" });
    r.onEvent({
      issue: 614,
      phase: "exec",
      event: "complete",
      durationSeconds: 60,
    });
    r.onEvent({ issue: 614, phase: "qa", event: "start" });
    r.onEvent({
      issue: 614,
      phase: "qa",
      event: "complete",
      durationSeconds: 60,
    });
    r.setPullRequest(614, 615, "https://github.com/x/y/pull/615");

    // 610 running exec.
    r.onEvent({ issue: 610, phase: "spec", event: "start" });
    r.onEvent({
      issue: 610,
      phase: "spec",
      event: "complete",
      durationSeconds: 60,
    });
    r.onEvent({ issue: 610, phase: "exec", event: "start" });

    const frame = stripAnsi(r.renderLiveFrame(100));
    expect(frame).toMatch(/✔ done · .+ · spec→exec→qa · PR #615/);
    expect(frame).toMatch(/exec/);
    expect(frame).toMatch(/queued/);
    // Rollup line.
    expect(frame).toMatch(/1 done · 1 running · 1 queued · 0 failed/);
    r.dispose();
  });

  it("AC-22: qa loop iteration appears in status header", () => {
    const { r } = makeTTY({ columns: 100 });
    r.registerIssue({ issueNumber: 606 });
    r.onEvent({ issue: 606, phase: "spec", event: "start" });
    r.onEvent({
      issue: 606,
      phase: "spec",
      event: "complete",
      durationSeconds: 30,
    });
    r.onEvent({ issue: 606, phase: "exec", event: "start" });
    r.onEvent({
      issue: 606,
      phase: "exec",
      event: "complete",
      durationSeconds: 30,
    });
    r.onEvent({
      issue: 606,
      phase: "qa",
      event: "start",
      iteration: 2,
    });

    const frame = stripAnsi(r.renderLiveFrame(100));
    expect(frame).toMatch(/qa loop 2\/3/);
    r.dispose();
  });

  it("AC-25: <80 col falls back to indented key:value (no box drawing)", () => {
    const { r } = makeTTY({ columns: 60 });
    r.registerIssue({ issueNumber: 614 });
    r.onEvent({ issue: 614, phase: "spec", event: "start" });
    const frame = stripAnsi(r.renderLiveFrame(60));
    expect(frame).not.toContain("┌");
    expect(frame).not.toContain("│");
    expect(frame).toContain("#614");
    r.dispose();
  });

  it("AC-32: width handling — 60/80/120 col frames are non-empty", () => {
    const { r } = makeTTY();
    r.registerIssue({ issueNumber: 614 });
    r.onEvent({ issue: 614, phase: "exec", event: "start" });
    for (const cols of [60, 80, 120]) {
      const frame = stripAnsi(r.renderLiveFrame(cols));
      expect(frame.length).toBeGreaterThan(0);
      // 80+ col uses box drawing; 60 col does not.
      if (cols >= 80) expect(frame).toContain("┌");
      else expect(frame).not.toContain("┌");
    }
    r.dispose();
  });

  it("AC-23: auto-detect mode renders `Phase: detecting…` until spec finishes", () => {
    const { r } = makeTTY({ columns: 100 });
    r.registerIssue({ issueNumber: 614, autoDetect: true });
    r.onEvent({ issue: 614, phase: "spec", event: "start" });

    // While spec is running and no other phase is known, header should show
    // the detecting placeholder.
    const detectingFrame = stripAnsi(r.renderLiveFrame(100));
    expect(detectingFrame).toMatch(/Phase: detecting…/);
    expect(detectingFrame).not.toMatch(/⠋ spec/);

    // Once spec completes and exec begins, the resolved plan takes over.
    r.onEvent({
      issue: 614,
      phase: "spec",
      event: "complete",
      durationSeconds: 30,
    });
    r.onEvent({ issue: 614, phase: "exec", event: "start" });
    const resolvedFrame = stripAnsi(r.renderLiveFrame(100));
    expect(resolvedFrame).not.toMatch(/Phase: detecting…/);
    expect(resolvedFrame).toMatch(/exec/);
    r.dispose();
  });

  it("AC-23: non-auto-detect runs never render the detecting placeholder", () => {
    const { r } = makeTTY({ columns: 100 });
    r.registerIssue({ issueNumber: 614 }); // autoDetect omitted
    r.onEvent({ issue: 614, phase: "spec", event: "start" });
    const frame = stripAnsi(r.renderLiveFrame(100));
    expect(frame).not.toMatch(/Phase: detecting…/);
    expect(frame).toMatch(/spec/);
    r.dispose();
  });

  it("AC-26: phase running past stallThresholdMs flips to `⚠ stalled`", () => {
    const buf = buffer();
    let nowMs = FIXED_NOW;
    const r = new TTYRenderer({
      stdoutWrite: buf.write,
      noColor: true,
      now: () => nowMs,
      wallClock: () => FIXED_DATE,
      isTTY: true,
      columns: 100,
      liveTickMs: 0,
      noSignalListeners: true,
      stallThresholdMs: 60_000, // 60s threshold
    });
    r.registerIssue({ issueNumber: 614 });
    r.onEvent({ issue: 614, phase: "exec", event: "start" });

    // Just under threshold — normal status.
    nowMs = FIXED_NOW + 30_000;
    const okFrame = stripAnsi(r.renderLiveFrame(100));
    expect(okFrame).not.toMatch(/⚠ stalled/);
    expect(okFrame).toMatch(/exec/);

    // Past threshold — stalled marker.
    nowMs = FIXED_NOW + 90_000;
    const stalledFrame = stripAnsi(r.renderLiveFrame(100));
    expect(stalledFrame).toMatch(/⚠ stalled · exec/);
    r.dispose();
  });

  it("AC-26: stallThresholdMs defaults to disabled (no false stalls)", () => {
    const buf = buffer();
    let nowMs = FIXED_NOW;
    const r = new TTYRenderer({
      stdoutWrite: buf.write,
      noColor: true,
      now: () => nowMs,
      wallClock: () => FIXED_DATE,
      isTTY: true,
      columns: 100,
      liveTickMs: 0,
      noSignalListeners: true,
      // stallThresholdMs omitted → defaults to Infinity
    });
    r.registerIssue({ issueNumber: 614 });
    r.onEvent({ issue: 614, phase: "exec", event: "start" });
    nowMs = FIXED_NOW + 60 * 60 * 1000; // +1h
    const frame = stripAnsi(r.renderLiveFrame(100));
    expect(frame).not.toMatch(/⚠ stalled/);
    r.dispose();
  });

  it("AC-28: >row-cap multi-issue grid rolls up oldest done rows", () => {
    const buf = buffer();
    let nowMs = FIXED_NOW;
    const r = new TTYRenderer({
      stdoutWrite: buf.write,
      noColor: true,
      now: () => nowMs,
      wallClock: () => FIXED_DATE,
      isTTY: true,
      columns: 120,
      liveTickMs: 0,
      noSignalListeners: true,
      multiIssueRowCap: 5, // small cap to make assertions easy
    });

    // Register 8 issues; complete 6 of them at increasing wall-clock times so
    // oldest-vs-newest can be distinguished. Leave 2 still running.
    for (let i = 1; i <= 8; i++) {
      r.registerIssue({ issueNumber: 600 + i });
    }
    for (let i = 1; i <= 6; i++) {
      nowMs = FIXED_NOW + i * 1000;
      r.onEvent({ issue: 600 + i, phase: "spec", event: "start" });
      r.onEvent({
        issue: 600 + i,
        phase: "spec",
        event: "complete",
        durationSeconds: 1,
      });
    }
    // Two still running.
    r.onEvent({ issue: 607, phase: "exec", event: "start" });
    r.onEvent({ issue: 608, phase: "exec", event: "start" });

    const frame = stripAnsi(r.renderLiveFrame(120));

    // Rollup row should mention the oldest-done count.
    // 6 done total - (cap 5 - 1 rollup row - 2 active) = 6 - 2 = 4 rolled up.
    expect(frame).toMatch(/✔ 4 done · rolled up|4 done/);
    // Both running issues should still be visible.
    expect(frame).toMatch(/#607/);
    expect(frame).toMatch(/#608/);
    // "M of N shown" indicator present.
    expect(frame).toMatch(/of 8 shown/);
    r.dispose();
  });

  it("AC-28: at-or-under cap, no rollup or `(M of N)` indicator", () => {
    const { r } = makeTTY({ columns: 100 });
    for (let i = 1; i <= 5; i++) {
      r.registerIssue({ issueNumber: 600 + i });
    }
    const frame = stripAnsi(r.renderLiveFrame(100));
    expect(frame).not.toMatch(/rolled up/);
    expect(frame).not.toMatch(/of \d+ shown/);
    r.dispose();
  });

  it("AC-4/8: tick advances spinner + redraws without an event", () => {
    const buf = buffer();
    const r = new TTYRenderer({
      stdoutWrite: buf.write,
      noColor: true,
      now: () => FIXED_NOW,
      wallClock: () => FIXED_DATE,
      isTTY: true,
      columns: 100,
      liveTickMs: 1000,
      noSignalListeners: true,
    });
    r.registerIssue({ issueNumber: 614 });
    r.onEvent({ issue: 614, phase: "exec", event: "start" });
    const before = buf.out.length;
    r.tickNow();
    expect(buf.out.length).toBeGreaterThan(before);
    r.dispose();
  });

  it("pause clears live zone; resume redraws", () => {
    const { r, buf } = makeTTY();
    r.registerIssue({ issueNumber: 614 });
    r.onEvent({ issue: 614, phase: "exec", event: "start" });
    const beforePause = buf.out.length;
    r.pause();
    // While paused, ticks are no-ops.
    r.tickNow();
    expect(buf.out.length).toBe(beforePause + 0); // pause itself doesn't write
    r.resume();
    expect(buf.out.length).toBeGreaterThan(beforePause);
    r.dispose();
  });
});

describe("renderRunSummary (AC-12-15)", () => {
  it("renders passed + failed issues in a grid + rollup", () => {
    const buf = buffer();
    renderRunSummary(
      {
        issues: [
          {
            issueNumber: 614,
            success: true,
            durationSeconds: 447,
            phases: [
              { name: "spec", success: true },
              { name: "exec", success: true },
              { name: "qa", success: true },
            ],
            prNumber: 615,
          },
          {
            issueNumber: 606,
            success: false,
            durationSeconds: 528,
            phases: [{ name: "qa", success: false }],
            failureReason: "qa max-iters",
            qaVerdict: "AC_NOT_MET",
            unmetCount: 3,
          },
        ],
        totalDurationSeconds: 975,
        logPath: ".sequant/logs/run-2026-05-09T16-14-29.json",
      },
      { stdoutWrite: buf.write, noColor: true, columns: 100 },
    );
    const out = stripAnsi(buf.joined());
    expect(out).toMatch(/SUMMARY · 2 issues/);
    expect(out).toMatch(/1 passed/);
    expect(out).toMatch(/1 failed/);
    expect(out).toMatch(/#614/);
    expect(out).toMatch(/PR #615/);
    expect(out).toMatch(/#606/);
    expect(out).toMatch(/AC_NOT_MET/);
    expect(out).toMatch(/Log: \.sequant\/logs\/run-/);
  });

  it("AC-25: narrow terminal falls back to indented key:value (no box)", () => {
    const buf = buffer();
    renderRunSummary(
      {
        issues: [
          {
            issueNumber: 614,
            success: true,
            durationSeconds: 60,
            phases: [{ name: "qa", success: true }],
          },
        ],
      },
      { stdoutWrite: buf.write, noColor: true, columns: 60 },
    );
    const out = stripAnsi(buf.joined());
    expect(out).not.toContain("┌");
    expect(out).toContain("#614");
  });
});

// Sanity: importing the module shouldn't pull in process.exit or other
// top-level side effects. Using vi.spyOn here is the cheapest way to assert.
describe("module load is side-effect free", () => {
  it("does not call process.exit on import", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => undefined as never) as never);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
