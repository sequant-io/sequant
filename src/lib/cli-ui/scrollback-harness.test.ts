/**
 * Regression tests for #647 — duplicate `SEQUANT WORKFLOW · ` header bug.
 *
 * Why this file exists separately from `run-renderer.test.ts` /
 * `run-renderer-624.test.ts`: those suites use the renderer's `getTestStub()`
 * which mocks `log-update`. The mock does not model `log-update`'s ANSI
 * cursor/erase semantics, so it cannot detect the scrollback corruption that
 * #647 is about (#624's tests passed despite the bug for exactly this
 * reason). The harness here drives a *real* `createLogUpdate` instance into
 * a {@link VirtualTerminal} that tracks both the visible viewport AND
 * scrollback, so any header that gets pushed off the top of the screen still
 * shows up in `(visible + scrollback)` for assertion.
 *
 * STATUS (AC-2 partial): the assertions below currently pass on `main` *and*
 * with the AC-3 grid-width fix in this PR. That means these scenarios do NOT
 * yet reproduce the dominant production-bug mechanism (#1 from the issue body:
 * scrollback erasure when event-line writes push the live frame above the
 * visible viewport so `eraseLines` clamps at row 0 and leaves the prior
 * frame's header stranded).
 *
 * The harness models cursor-up clamping at row 0 (see `VirtualTerminal`),
 * so Mechanism #1 IS reachable from this harness — it just requires a
 * scenario whose total content > viewport rows. The two scenarios below
 * stay within the viewport for the basic test and use pause/resume for the
 * stress test (which resets log-update's previousLineCount, defusing the
 * very bug we want to catch).
 *
 * Reproducing Mechanism #1 requires an event-only flood (no pause/resume)
 * tall enough to push the frame top into scrollback. The AC-1 production
 * instrumentation (`SEQUANT_DEBUG_RENDERER=1`) is the intended next step
 * to capture the exact event-count / row-count / viewport size that fires
 * the bug in real `npx sequant run` runs, so the harness scenario can be
 * tightened from a known good fixture rather than guessed.
 */

import { describe, expect, it } from "vitest";
import { TTYRenderer } from "./run-renderer.js";
import { createTerminalHarness } from "./scrollback-harness.js";
import type { ProgressEvent } from "./run-renderer-types.js";

const FIXED_NOW = 1_700_000_000_000;
const FIXED_DATE = new Date(2026, 4, 14, 0, 0, 0, 0);

/**
 * Wire a TTYRenderer through real log-update + a VirtualTerminal so we can
 * inspect (visible + scrollback) as if a user were watching the run.
 */
function makeHarnessRenderer(opts: {
  rows: number;
  cols: number;
  streamColumns?: number;
  rendererColumns?: number;
}) {
  const harness = createTerminalHarness(opts);
  const renderer = new TTYRenderer({
    stdoutWrite: harness.stdoutWrite,
    logUpdateInstance: harness.logUpdate,
    isTTY: true,
    noColor: true,
    columns: opts.rendererColumns ?? opts.cols,
    rows: opts.rows,
    liveTickMs: 0,
    noSignalListeners: true,
    now: () => FIXED_NOW,
    wallClock: () => FIXED_DATE,
  });
  return { renderer, harness };
}

describe("#647 scrollback harness — duplicate-header regression", () => {
  it("reproduces the production scenario without ever producing a second `SEQUANT WORKFLOW · ` line in (visible + scrollback)", () => {
    // Simulates the motivating transcript: 2 issues, parallel mode, ~12
    // events. Terminal is intentionally short (24 rows) so the live frame
    // gets pushed up by event-line writes into territory `log-update.clear()`
    // cannot reach via `eraseLines(previousLineCount)`.
    const { renderer, harness } = makeHarnessRenderer({ rows: 24, cols: 100 });

    // Two issues, like `npx sequant run 504 505 -q`.
    renderer.registerIssue({ issueNumber: 504 });
    renderer.registerIssue({ issueNumber: 505 });

    const events: ProgressEvent[] = [
      { issue: 504, phase: "spec", event: "start" },
      { issue: 505, phase: "spec", event: "start" },
      { issue: 504, phase: "spec", event: "complete", durationSeconds: 232 },
      { issue: 504, phase: "exec", event: "start" },
      { issue: 505, phase: "spec", event: "complete", durationSeconds: 262 },
      { issue: 505, phase: "exec", event: "start" },
      { issue: 504, phase: "exec", event: "complete", durationSeconds: 820 },
      { issue: 504, phase: "qa", event: "start" },
      { issue: 505, phase: "exec", event: "complete", durationSeconds: 1005 },
      { issue: 505, phase: "qa", event: "start" },
      { issue: 504, phase: "qa", event: "complete", durationSeconds: 293 },
      {
        issue: 505,
        phase: "qa",
        event: "failed",
        error: "QA verdict: AC_MET_BUT_NOT_A_PLUS",
      },
    ];
    for (const ev of events) renderer.onEvent(ev);
    renderer.setPullRequest(
      504,
      643,
      "https://github.com/sequant-io/sequant/pull/643",
    );
    // Note: do NOT call dispose() before counting — dispose() clears the live
    // frame, which would erase the (single, expected) header from the visible
    // buffer. We assert on the state a real user sees mid-run.

    // The exact AC-2 invariant from the issue body: total occurrences of
    // `SEQUANT WORKFLOW · ` across visible + scrollback must be exactly 1.
    const headerCount = harness.vt.countOccurrences(/SEQUANT WORKFLOW · /);
    if (headerCount !== 1) {
      // Surface raw terminal state on failure — without it, the failure is
      // opaque ("expected 0 to be 1"). With it, you can see exactly which
      // duplicate header rows ended up where.
      const visible = harness.vt
        .getVisibleLines()
        .map((l, i) => `  v${i.toString().padStart(2, "0")} | ${l}`)
        .join("\n");
      const scrollback = harness.vt.scrollback
        .map((l, i) => `  s${i.toString().padStart(2, "0")} | ${l}`)
        .join("\n");
      throw new Error(
        `Expected exactly 1 \`SEQUANT WORKFLOW · \` header but found ${headerCount}.\n\n` +
          `Scrollback (${harness.vt.scrollback.length} rows):\n${scrollback}\n\n` +
          `Visible (${harness.vt.rows} rows):\n${visible}`,
      );
    }
    expect(headerCount).toBe(1);
    renderer.dispose();
  });

  it("survives ≥3 scroll cycles (extended event flood) with single header in scrollback+visible", () => {
    // Stress version: many event flips in a tight terminal forces many scroll
    // cycles. If clear() ever leaves a header row stranded above row 0, this
    // is where it shows up.
    const { renderer, harness } = makeHarnessRenderer({ rows: 24, cols: 100 });

    renderer.registerIssue({ issueNumber: 600 });
    renderer.registerIssue({ issueNumber: 601 });

    const verboseStream = (lineCount: number) => {
      // Direct stdoutWrite bypasses log-update entirely, the same way real
      // `claude` subprocess streaming does once the renderer is paused.
      for (let i = 0; i < lineCount; i++) {
        harness.stdoutWrite(`  [verbose] streaming line ${i}\n`);
      }
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
      for (const issue of [600, 601]) {
        renderer.onEvent({
          issue,
          phase: "spec",
          event: "start",
          iteration: attempt,
        });
        renderer.pause();
        verboseStream(30);
        renderer.resume();
        renderer.onEvent({
          issue,
          phase: "spec",
          event: "complete",
          durationSeconds: 30,
          iteration: attempt,
        });
        renderer.onEvent({
          issue,
          phase: "exec",
          event: "start",
          iteration: attempt,
        });
        renderer.pause();
        verboseStream(50);
        renderer.resume();
        renderer.onEvent({
          issue,
          phase: "exec",
          event: "complete",
          durationSeconds: 60,
          iteration: attempt,
        });
      }
    }
    const headerCount = harness.vt.countOccurrences(/SEQUANT WORKFLOW · /);
    if (headerCount !== 1) {
      const visible = harness.vt
        .getVisibleLines()
        .map((l, i) => `  v${i.toString().padStart(2, "0")} | ${l}`)
        .join("\n");
      const scrollback = harness.vt.scrollback
        .map((l, i) => `  s${i.toString().padStart(2, "0")} | ${l}`)
        .join("\n");
      throw new Error(
        `Expected exactly 1 \`SEQUANT WORKFLOW · \` header but found ${headerCount}.\n\n` +
          `Scrollback (${harness.vt.scrollback.length} rows):\n${scrollback}\n\n` +
          `Visible (${harness.vt.rows} rows):\n${visible}`,
      );
    }
    expect(headerCount).toBe(1);
    renderer.dispose();
  });

  // AC-2 Mechanism #1 reproduction attempt: event-only flood (no pause/resume)
  // in a viewport tall enough that consecutive events scroll the original
  // frame top into scrollback. If log-update's `eraseLines(previousLineCount)`
  // clamps at row 0 (the harness models this), the previous frame's header
  // row should remain stranded in scrollback. This is the dominant production
  // mechanism per the #647 issue body.
  //
  // STATUS: marked `.skip` because it does not currently fire on either
  // master or this PR — the harness's cursor-up clamp + log-update's
  // pre-clear-each-frame flow keep the math in agreement. Captured here as
  // a regression scaffold; AC-1 instrumentation evidence is the prerequisite
  // for tightening it into a reliable repro (see file header for context).
  it.skip("AC-2 (mechanism #1, deferred): event-only flood pushes the live frame into scrollback", () => {
    const { renderer, harness } = makeHarnessRenderer({ rows: 12, cols: 100 });
    renderer.registerIssue({ issueNumber: 700 });
    renderer.registerIssue({ issueNumber: 701 });

    for (let i = 0; i < 30; i++) {
      const phase = i % 3 === 0 ? "spec" : i % 3 === 1 ? "exec" : "qa";
      const issue = i % 2 === 0 ? 700 : 701;
      renderer.onEvent({ issue, phase, event: "start", iteration: i });
      renderer.onEvent({
        issue,
        phase,
        event: "complete",
        durationSeconds: 60 + i,
        iteration: i,
      });
    }

    const headerCount = harness.vt.countOccurrences(/SEQUANT WORKFLOW · /);
    expect(headerCount).toBeLessThanOrEqual(1);
    renderer.dispose();
  });
});

// ============================================================================
// #652 — renderer bottom-output corruption regression
//
// Two symptoms (per the issue body) that are NOT explained by #647's
// duplicate-header mechanisms:
//
//   Symptom A — characters vanish mid-event-line ("✔ #5loop" instead of
//     "✔ #505 loop"). Cause: the `loop` phase event-line writes the same
//     issue+phase tuple as the immediately-prior `start` event, so when the
//     live-frame redraw (via log-update.clear) under-erases a wrapped row,
//     the new line is rendered atop the old one at a row offset that drops
//     characters from the middle.
//
//   Symptom B — U+FFFD appears in the summary table separator
//     ("├───────�     │ 33m 41s    │"). Cause: `renderSummary` writes the
//     entire table in one `stdoutWrite(out.join("\n"))` call, but the live
//     timer is still running when the very first `logUpdateClear()` lands.
//     If the timer fires between `logUpdateClear` and the `clearInterval`
//     two statements later, log-update redraws WITHIN the summary table
//     output stream, splitting a multibyte box-drawing char at a byte
//     boundary so the terminal renders U+FFFD.
//
// Both tests assert on `harness.vt.getAllText()` so corruption shows up in
// (visible + scrollback) regardless of which side of the viewport the
// affected row landed in.
// ============================================================================

// ============================================================================
// #652 — renderer bottom-output corruption regression
//
// Two symptoms (per the issue body) that are NOT explained by #647's
// duplicate-header mechanisms:
//
//   Symptom A — characters vanish mid-event-line ("✔ #5loop" instead of
//     "✔ #505 loop").
//
//   Symptom B — U+FFFD appears in the summary table separator
//     ("├───────�     │ 33m 41s    │").
//
// **Harness limitation acknowledged up-front.** The synchronous VirtualTerminal
// model cannot reproduce either visible symptom — they depend on real OS-level
// pipe buffering, SIGWINCH races, or subprocess stdout interleaving that the
// harness fundamentally doesn't model. Earlier drafts of this file shipped
// scaffolding tests that *appeared* to exercise these scenarios but actually
// ran through the `logUpdateInstance` constructor branch, bypassing the
// production fix path entirely. Those were removed (PR #654 follow-up review).
//
// What remains: two invariant tests that pin *properties* the production
// fixes enforce. They go RED on pre-fix code and GREEN on post-fix code,
// verified by reverting each fix locally. They do NOT prove the visible
// symptoms cannot occur via some other mechanism (SIGWINCH, subprocess
// interleaving) — that requires a PTY-based harness or production replay.
// ============================================================================

describe("#652 Symptom A — log-update column binding", () => {
  it("binds log-update to the renderer's columns even when process.stdout.columns is undefined (RED→GREEN)", () => {
    // Pins the property the column-binding fix enforces: log-update reads
    // its wrap width from the renderer's `getColumns()`, NOT from
    // `process.stdout.columns` (which is undefined under `npx`).
    //
    // Verification method: construct a production-path TTYRenderer (no
    // `logUpdateInstance` override) and read its `_boundStream.columns`
    // getter directly. The getter delegates to `renderer.getColumns()`.
    // If the production code is reverted to use the singleton `logUpdate`
    // import, `_boundStream` is null and this test goes RED.
    const originalColumns = process.stdout.columns;
    const originalIsTTY = process.stdout.isTTY;
    try {
      // Simulate `npx` stripping the TTY signals (no columns, no isTTY).
      Object.defineProperty(process.stdout, "columns", {
        value: undefined,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });

      const r = new TTYRenderer({
        isTTY: true,
        noColor: true,
        columns: 200, // Renderer's view: 200 cols
        rows: 24,
        liveTickMs: 0,
        noSignalListeners: true,
        now: () => FIXED_NOW,
        wallClock: () => FIXED_DATE,
      });

      // Read the bound stream directly (private field exposed for tests).
      const boundStream = (r as unknown as {
        _boundStream: {
          readonly columns: number;
          readonly rows: number;
          readonly isTTY: boolean;
        } | null;
      })._boundStream;

      // Invariant 1: the renderer takes the production path → bound stream exists.
      expect(boundStream).not.toBeNull();
      if (boundStream === null) return;

      // Invariant 2: bound stream's columns getter returns the renderer's
      // view (200), not log-update's 80-col fallback or process.stdout's
      // undefined.
      expect(boundStream.columns).toBe(200);

      // Invariant 3: bound stream's `isTTY` is derived from `process.stdout`,
      // not hardcoded. Setting process.stdout.isTTY = true above → bound
      // stream sees true. (Guards against the synchronized-output ANSI
      // pollution regression flagged in PR #654 review.)
      expect(boundStream.isTTY).toBe(true);

      r.dispose();

      // Invariant 4: when process.stdout.isTTY is false (piped/redirected),
      // bound stream also reports false → log-update won't emit
      // synchronized-output escapes (`ESC[?2026h`) into the pipe.
      Object.defineProperty(process.stdout, "isTTY", {
        value: false,
        writable: true,
        configurable: true,
      });
      const r2 = new TTYRenderer({
        isTTY: true,
        noColor: true,
        columns: 100,
        rows: 24,
        liveTickMs: 0,
        noSignalListeners: true,
        now: () => FIXED_NOW,
        wallClock: () => FIXED_DATE,
      });
      const bs2 = (r2 as unknown as {
        _boundStream: { readonly isTTY: boolean } | null;
      })._boundStream;
      expect(bs2).not.toBeNull();
      expect(bs2?.isTTY).toBe(false);
      r2.dispose();
    } finally {
      Object.defineProperty(process.stdout, "columns", {
        value: originalColumns,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: originalIsTTY,
        writable: true,
        configurable: true,
      });
    }
  });
});

describe("#652 Symptom B — renderSummary live-timer cancel ordering", () => {
  it("cancels the live timer BEFORE logUpdateClear (RED→GREEN call-order invariant)", () => {
    // Pins the property the renderSummary reorder enforces: by the time
    // `logUpdateClear` runs inside `renderSummary`, `liveTimer` is null.
    //
    // **Honesty note.** The original PR claimed this prevents a tick from
    // firing between `logUpdateClear` and the subsequent `clearInterval`.
    // JS is single-threaded so that race cannot occur. We keep the reorder
    // as structural cleanup (see the comment in renderSummary), and this
    // test pins the ordering so a future reverter can't silently restore
    // the misleading sequence.
    const { renderer } = makeHarnessRenderer({ rows: 30, cols: 100 });

    type RendererPrivate = {
      logUpdateClear: () => void;
      logUpdateDone: () => void;
      liveTimer: NodeJS.Timeout | null;
    };
    const r = renderer as unknown as RendererPrivate;

    // Set up a real interval so the `clearInterval` branch is exercised.
    // The harness path uses `liveTickMs: 0` which suppresses the constructor's
    // own `startLiveTimer()`, so we manually create one to model the
    // production case where the timer is live when renderSummary is called.
    r.liveTimer = setInterval(() => {}, 100_000);

    // Pre-condition: liveTimer must actually be non-null going into
    // renderSummary, otherwise the test is vacuous (it would pass with
    // the bug intact via the "liveTimer was already null" path).
    expect(r.liveTimer).not.toBeNull();

    // Spy on logUpdateClear: record whether liveTimer was still set when
    // it ran. The fix guarantees `clearInterval` ran first → liveTimer
    // is null at clear time.
    const observations: Array<{ op: string; liveTimerWasSet: boolean }> = [];
    const origClear = r.logUpdateClear.bind(renderer);
    const origDone = r.logUpdateDone.bind(renderer);
    r.logUpdateClear = () => {
      observations.push({
        op: "logUpdateClear",
        liveTimerWasSet: r.liveTimer !== null,
      });
      origClear();
    };
    r.logUpdateDone = () => {
      observations.push({
        op: "logUpdateDone",
        liveTimerWasSet: r.liveTimer !== null,
      });
      origDone();
    };

    renderer.registerIssue({ issueNumber: 504 });
    renderer.renderSummary({
      issues: [
        {
          issueNumber: 504,
          success: true,
          phases: [{ name: "spec", success: true }],
          durationSeconds: 30,
        },
      ],
      totalDurationSeconds: 30,
    });

    // Invariant 1: logUpdateClear was actually called (proves the
    // `clearInterval`-then-`clear` branch was taken, not a dispose
    // shortcut that bypasses both).
    const clearCall = observations.find((c) => c.op === "logUpdateClear");
    expect(clearCall).toBeDefined();

    // Invariant 2: at the moment logUpdateClear ran, liveTimer was null
    // (proves clearInterval ran first). Pre-condition above proves it
    // started non-null, so this transition can only have happened via
    // the renderSummary's clearInterval branch.
    expect(clearCall?.liveTimerWasSet).toBe(false);

    renderer.dispose();
  });
});
