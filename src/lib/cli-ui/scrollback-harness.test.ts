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
 * Coverage in this file:
 *   - Mechanism #4-adjacent (width misreporting): `streamColumns > vt.cols`
 *     simulates the case where `process.stdout.columns` (read by both the
 *     renderer and `log-update`) is wider than the physical terminal. The
 *     renderer's `min(cols, 78)` cap is the fix; without it, the test fails
 *     on master because the grid rendered at the reported width gets wrapped
 *     by the VT, log-update's `previousLineCount` under-counts, and each
 *     subsequent redraw leaves a stale header in scrollback.
 *   - Mechanism #1 (scrollback erasure from event-line scrolling) is NOT
 *     covered here — capturing it deterministically requires AC-1
 *     instrumentation evidence from a real run. The `it.skip(...)` scaffold
 *     below is the placeholder.
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

  // AC-2 Mechanism #1 reproduction scaffold (deferred — AC-1 evidence gated):
  // event-only flood without pause/resume, in a viewport short enough that
  // consecutive renders should scroll the original frame top into scrollback.
  // The harness models cursor-up clamping at row 0, so Mechanism #1 IS
  // reachable in principle — but tightening the scenario to fire deterministically
  // requires AC-1 evidence from a real run (event-count, viewport size, frame
  // height combinations that production actually exhibits).
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

  // AC-2 (Mechanism #4-adjacent): width misreporting. The renderer + log-update
  // both read `stream.columns = 100`, but the physical terminal is 80 cols.
  // Without the `min(cols, 78)` cap, the renderer produces 100-col-wide grid
  // rows that log-update tracks as 1 line each (no internal wrap), the VT
  // physically wraps each row to 2 lines, and `eraseLines(previousLineCount)`
  // under-counts. The previous frame's header survives in scrollback on every
  // redraw — the #647 duplicate-header symptom.
  //
  // This scenario is RED on master (`Math.min(cols, 110)` produces a 100-char
  // grid that the 80-col VT wraps) and GREEN with the `min(cols, 78)` cap.
  // The grid stays at 78 cols, fits in the VT without wrap, log-update's
  // line tracking matches the actual rendered height, and only one header
  // ever lives in (visible + scrollback).
  it("AC-2: width-misreporting (stream wider than terminal) keeps the header out of scrollback", () => {
    const { renderer, harness } = makeHarnessRenderer({
      rows: 30,
      cols: 80,
      streamColumns: 100,
      rendererColumns: 100,
    });

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

    const headerCount = harness.vt.countOccurrences(/SEQUANT WORKFLOW · /);
    if (headerCount > 1) {
      const visible = harness.vt
        .getVisibleLines()
        .map((l, i) => `  v${i.toString().padStart(2, "0")} | ${l}`)
        .join("\n");
      const scrollback = harness.vt.scrollback
        .map((l, i) => `  s${i.toString().padStart(2, "0")} | ${l}`)
        .join("\n");
      throw new Error(
        `Expected at most 1 \`SEQUANT WORKFLOW · \` header but found ${headerCount}.\n\n` +
          `Scrollback (${harness.vt.scrollback.length} rows):\n${scrollback}\n\n` +
          `Visible (${harness.vt.rows} rows):\n${visible}`,
      );
    }
    expect(headerCount).toBeLessThanOrEqual(1);
    renderer.dispose();
  });

  // AC-3 derived: lock the grid-width arithmetic so future drift (changing
  // colW, padding, or the cap) can't silently reintroduce the overflow that
  // started this whole regression. Asserts on the actual rendered string
  // length of grid border rows at practical widths (≥80 cols, below which the
  // `Math.max(50, ...)` floor takes over).
  it("AC-3 (grid-width invariant): rendered grid total width is min(cols, 78) at cols ≥ 80", () => {
    const widths = [80, 100, 200];
    for (const cols of widths) {
      const harness = createTerminalHarness({ rows: 40, cols: 250 });
      const renderer = new TTYRenderer({
        stdoutWrite: harness.stdoutWrite,
        logUpdateInstance: harness.logUpdate,
        isTTY: true,
        noColor: true,
        columns: cols,
        rows: 40,
        liveTickMs: 0,
        noSignalListeners: true,
        now: () => FIXED_NOW,
        wallClock: () => FIXED_DATE,
      });
      renderer.registerIssue({ issueNumber: 504 });
      renderer.registerIssue({ issueNumber: 505 });
      renderer.onEvent({ issue: 504, phase: "spec", event: "start" });

      const allText = harness.vt.getAllText();
      // Box-drawing border rows are the canonical width indicator. Match
      // characters used by `drawSimpleTable` / `drawKeyValueTable`.
      const borderRow = allText.split("\n").find((l) => /[┌┬┐├┼┤└┴┘─]/.test(l));
      expect(borderRow, `border row not found at cols=${cols}`).toBeTruthy();
      // The VT preserves the 2-char leading indent. Total visible width
      // including the indent should equal `min(cols, 78)`.
      const expected = Math.min(cols, 78);
      // The VT pads visible rows to its physical width (cols=250 here) and
      // our trim strips trailing whitespace, so the meaningful content ends
      // at the closing border char. Re-trim and assert.
      const trimmed = borderRow!.replace(/\s+$/, "");
      expect(trimmed.length, `border width mismatch at cols=${cols}`).toBe(
        expected,
      );
      renderer.dispose();
    }
  });
});
