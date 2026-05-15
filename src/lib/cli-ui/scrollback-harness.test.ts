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

describe("#652 Symptom A — event-line mid-string char loss", () => {
  it("preserves the full `#NNN <phase>` token in every event line under tick interleaving", () => {
    // The motivating transcript (`npx sequant run 504 505 -q`, v2.3.0):
    //   ✘ #505 qa  QA verdict: AC_MET_BUT_NOT_A_PLUS
    //   ▸ #505 loop
    //   ✔ #5loop  Claude Code returned an error result: ...
    //
    // `#505 loop` lost the `05 ` substring mid-string. We drive the same
    // sequence with a live tick interleaved between the `loop start` and
    // `loop complete` events so the redraw-then-clear-then-redraw cycle
    // exercises the same path the production transcript hit.
    const { renderer, harness } = makeHarnessRenderer({ rows: 24, cols: 100 });

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
      { issue: 505, phase: "loop", event: "start" },
    ];
    for (const ev of events) {
      renderer.onEvent(ev);
      // Interleave a live-frame tick between events to model the production
      // ~1Hz redraw firing between asynchronous event callbacks.
      renderer.tickNow();
    }
    renderer.onEvent({
      issue: 505,
      phase: "loop",
      event: "failed",
      error: "Claude Code returned an error result: ETIMEDOUT",
    });

    const text = harness.vt.getAllText();

    // The exact AC-1 invariant: each `#505 <phase>` token from the event log
    // must survive into (visible + scrollback) without any chars dropped.
    // We check for the specific token from the transcript first, and also
    // assert no corruption of any rendered "#NNN <phase>" pattern.
    const corruptionRegex = /#5(?!05 )(loop|exec|qa|spec)/;
    if (corruptionRegex.test(text)) {
      const visible = harness.vt
        .getVisibleLines()
        .map((l, i) => `  v${i.toString().padStart(2, "0")} | ${l}`)
        .join("\n");
      const scrollback = harness.vt.scrollback
        .map((l, i) => `  s${i.toString().padStart(2, "0")} | ${l}`)
        .join("\n");
      throw new Error(
        `Found corrupted #5<phase> token (e.g. "#5loop" instead of "#505 loop").\n\n` +
          `Scrollback (${harness.vt.scrollback.length} rows):\n${scrollback}\n\n` +
          `Visible (${harness.vt.rows} rows):\n${visible}`,
      );
    }
    expect(text).not.toMatch(corruptionRegex);
    // Positive: at least one fully-formed `#505 loop` token landed somewhere.
    expect(text).toMatch(/#505 loop/);
    renderer.dispose();
  });

  it("preserves event-line content when log-update reports a narrower stream than the terminal renders (npx column mismatch)", () => {
    // Production cause hypothesis: `process.stdout.columns` is sometimes
    // undefined under `npx`, so log-update falls back to defaultColumns (~80)
    // while the real terminal is wider. Wrap math diverges → eraseLines under-
    // or over-counts → previous event-line rows get overwritten mid-string.
    //
    // Harness models this by passing `streamColumns: 80` while keeping the VT
    // at `cols: 200`. The renderer is told `cols: 200` too, so it builds wide
    // frames; log-update wraps them at 80 (its view of the stream) which
    // shifts the cursor differently than the terminal does after each redraw.
    const { renderer, harness } = makeHarnessRenderer({
      rows: 24,
      cols: 200,
      streamColumns: 80,
      rendererColumns: 200,
    });

    renderer.registerIssue({ issueNumber: 504 });
    renderer.registerIssue({ issueNumber: 505 });

    const events: ProgressEvent[] = [
      { issue: 504, phase: "spec", event: "start" },
      { issue: 505, phase: "spec", event: "start" },
      { issue: 504, phase: "qa", event: "start" },
      {
        issue: 504,
        phase: "qa",
        event: "failed",
        error:
          "QA verdict: AC_MET_BUT_NOT_A_PLUS — long error string that exceeds 80 cols so log-update wraps it but terminal does not",
      },
      { issue: 504, phase: "loop", event: "start" },
      { issue: 504, phase: "loop", event: "complete", durationSeconds: 30 },
    ];
    for (const ev of events) {
      renderer.onEvent(ev);
      renderer.tickNow();
    }

    const text = harness.vt.getAllText();

    // No `#NNN <phase>` token may be mangled in (visible + scrollback). The
    // production symptom was `#5loop` for `#505 loop`; assert the inverse
    // across all rendered phase tokens.
    const mangledTokens = text.match(/#5(?!05 )(?:loop|qa|exec|spec)/g);
    if (mangledTokens && mangledTokens.length > 0) {
      const visible = harness.vt
        .getVisibleLines()
        .map((l, i) => `  v${i.toString().padStart(2, "0")} | ${l}`)
        .join("\n");
      const scrollback = harness.vt.scrollback
        .map((l, i) => `  s${i.toString().padStart(2, "0")} | ${l}`)
        .join("\n");
      throw new Error(
        `Found ${mangledTokens.length} mangled phase token(s): ${JSON.stringify(mangledTokens)}.\n\n` +
          `Scrollback (${harness.vt.scrollback.length} rows):\n${scrollback}\n\n` +
          `Visible (${harness.vt.rows} rows):\n${visible}`,
      );
    }
    expect(mangledTokens).toBeNull();
    renderer.dispose();
  });

  it("binds log-update to the renderer's column count even when process.stdout.columns is undefined (RED→GREEN column-mismatch invariant)", () => {
    // RED→GREEN gate for the Symptom A defensive fix. The harness cannot
    // reproduce the visible mid-string corruption deterministically (it
    // requires real OS-level cursor/erase interleaving the synchronous VT
    // model doesn't capture). This invariant test instead pins the
    // *underlying* property the fix enforces: log-update MUST wrap at the
    // renderer's `getColumns()` value, not at its own `defaultColumns`
    // fallback. If the production code path reverts to the unbound
    // `logUpdate` singleton, `process.stdout.columns = undefined` will leak
    // through and this test goes RED.
    //
    // Method: spy on the stream that log-update wraps. The bound stream has
    // `columns` as a getter that delegates to the renderer. If the renderer
    // changes its columns (via `columnsOverride`), the next log-update
    // write sees the new value. We assert that a write under
    // `process.stdout.columns = undefined` still wraps at the renderer's
    // configured 200-col width (not log-update's 80-col default).
    //
    // We use the production code path (not the harness path) by creating a
    // TTYRenderer without `logUpdateInstance`. That forces the constructor
    // into the `else` branch where the bound stream lives.
    const writes: string[] = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalColumns = process.stdout.columns;
    const originalRows = process.stdout.rows;
    const originalIsTTY = process.stdout.isTTY;
    try {
      // Simulate `npx` stripping the TTY signals.
      Object.defineProperty(process.stdout, "columns", {
        value: undefined,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, "rows", {
        value: undefined,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });
      // Capture writes that log-update's bound stream produces.
      process.stdout.write = ((chunk: string | Uint8Array) => {
        writes.push(
          typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
        );
        return true;
      }) as typeof process.stdout.write;

      // Production code path: no logUpdateInstance, no stdoutWrite override.
      // This forces the constructor's `else` branch (the patched path).
      const r = new TTYRenderer({
        isTTY: true,
        noColor: true,
        columns: 200, // Renderer view: 200 cols
        rows: 24,
        liveTickMs: 0,
        noSignalListeners: true,
        now: () => FIXED_NOW,
        wallClock: () => FIXED_DATE,
      });

      r.registerIssue({ issueNumber: 504 });
      r.onEvent({ issue: 504, phase: "spec", event: "start" });
      // A second event drives a log-update redraw — by which point the
      // bound stream's `columns` getter has been read by log-update for
      // its wrap math.
      r.onEvent({
        issue: 504,
        phase: "spec",
        event: "complete",
        durationSeconds: 30,
      });
      r.dispose();

      // Invariant: the renderer rendered frames sized to 200-cols, not
      // log-update's 80-col fallback. We check by looking at the longest
      // line in any of the captured writes: if log-update wrapped at 80,
      // no line would exceed 80 visible chars (stripping ANSI). If
      // log-update wrapped at 200 (or didn't wrap because the frame
      // already fit), lines can be longer than 80.
      // Strip ANSI escapes so we measure visible width.
      const stripAnsi = (s: string) => s.replace(/\[[0-9;]*[A-Za-z]/g, "");
      const allText = writes.join("");
      const lines = allText.split("\n");
      const longestVisible = Math.max(
        ...lines.map((line) => stripAnsi(line).length),
      );
      // The frame's box-drawing rows are sized to roughly the renderer's
      // columns (capped at 110 internally for SUMMARY_COLUMN_CAP, but the
      // single-issue grid uses up to `min(cols, 110)`). So we expect to
      // see at least one line wider than 80 visible chars — proving
      // log-update did NOT wrap at its 80-col fallback.
      expect(longestVisible).toBeGreaterThan(80);
    } finally {
      // Restore process.stdout state.
      process.stdout.write = originalStdoutWrite;
      Object.defineProperty(process.stdout, "columns", {
        value: originalColumns,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, "rows", {
        value: originalRows,
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

describe("#652 Symptom B — U+FFFD and row overlap in summary table", () => {
  it("emits a summary table with no U+FFFD and no digit/letter content inside separator rows", () => {
    // Production symptom: ├───────�     │ 33m 41s    │
    //
    // The U+FFFD is the smoking gun — a multibyte char split at a byte
    // boundary. The "33m 41s" is a data row's "Total" cell rendered ON TOP OF
    // a separator row, meaning the terminal cursor was positioned at the
    // wrong row when the data row was emitted.
    //
    // Both effects trace back to the same cause: `renderSummary` calls
    // `logUpdateClear()`, then `logUpdateDone()`, THEN `clearInterval` on
    // the live timer. If the timer fires between those calls, it redraws the
    // live frame INTO the summary's output stream.
    //
    // The harness can't fire setInterval mid-call (JS single-threaded), so
    // we simulate the same hazard by manually driving `tickNow()` between
    // events that lead into the summary, and by passing `liveTickMs: 0` to
    // disable the real interval (otherwise it would fire under real time).
    const { renderer, harness } = makeHarnessRenderer({
      rows: 30,
      cols: 100,
    });

    renderer.registerIssue({ issueNumber: 504 });
    renderer.registerIssue({ issueNumber: 505 });

    const events: ProgressEvent[] = [
      { issue: 504, phase: "spec", event: "start" },
      { issue: 504, phase: "spec", event: "complete", durationSeconds: 30 },
      { issue: 505, phase: "spec", event: "start" },
      { issue: 505, phase: "spec", event: "complete", durationSeconds: 45 },
      { issue: 504, phase: "exec", event: "start" },
      { issue: 504, phase: "exec", event: "complete", durationSeconds: 600 },
      { issue: 505, phase: "exec", event: "start" },
      { issue: 505, phase: "exec", event: "complete", durationSeconds: 720 },
      { issue: 504, phase: "qa", event: "start" },
      { issue: 504, phase: "qa", event: "complete", durationSeconds: 60 },
      { issue: 505, phase: "qa", event: "start" },
      {
        issue: 505,
        phase: "qa",
        event: "failed",
        error: "QA verdict: AC_MET_BUT_NOT_A_PLUS",
      },
    ];
    for (const ev of events) {
      renderer.onEvent(ev);
      renderer.tickNow();
    }
    renderer.renderSummary({
      issues: [
        {
          issueNumber: 504,
          success: true,
          phases: [
            { name: "spec", success: true },
            { name: "exec", success: true },
            { name: "qa", success: true },
          ],
          durationSeconds: 2021,
        },
        {
          issueNumber: 505,
          success: false,
          phases: [
            { name: "spec", success: true },
            { name: "exec", success: true },
            { name: "qa", success: false },
          ],
          durationSeconds: 765,
          failureReason: "qa failed",
          qaVerdict: "AC_MET_BUT_NOT_A_PLUS",
        },
      ],
      totalDurationSeconds: 2786,
    });

    const text = harness.vt.getAllText();

    // AC-2 invariant #1: no Unicode replacement chars anywhere.
    if (text.includes("�")) {
      throw new Error(`Found U+FFFD in rendered output. Full text:\n${text}`);
    }
    expect(text).not.toContain("�");

    // AC-2 invariant #2: every separator row (one that starts with `  ├` or
    // contains `├`/`┼`/`┤`/`┬`/`┴`) must consist of *only* box-drawing chars
    // and spaces — never digits or letters. A digit/letter in a separator row
    // means a data row was rendered atop the separator row.
    const allLines = text.split("\n");
    const separatorWithContent = allLines.find((line) => {
      const isSeparator = /[├┼┤┬┴]/.test(line);
      if (!isSeparator) return false;
      // Strip ANSI to inspect raw content (renderer emits SGR codes for dim).
      const stripped = line.replace(/\[[0-9;]*[A-Za-z]/g, "");
      return /[0-9A-Za-z]/.test(stripped);
    });
    if (separatorWithContent) {
      throw new Error(
        `Found separator row with digit/letter content (data row overlaid on separator):\n  ${separatorWithContent}\n\nFull text:\n${text}`,
      );
    }
    expect(separatorWithContent).toBeUndefined();
    renderer.dispose();
  });

  it("cancels the live timer before tearing down log-update (RED→GREEN call-order invariant)", () => {
    // RED→GREEN gate for the renderSummary fix. The harness cannot model OS
    // pipe buffering or real setInterval preemption, so the visible-output
    // assertion in the test above passes on both old and new code. This
    // invariant test instead captures the *underlying* mechanism: the live
    // timer MUST be `null` by the time `logUpdateClear` runs, otherwise a
    // pending tick (already queued in the event loop) can still fire between
    // the log-update teardown and the summary write.
    //
    // Before fix: renderSummary called logUpdateClear/Done first, then
    // clearInterval → liveTimer was still set at clear time. RED.
    // After fix: clearInterval runs first → liveTimer is null at clear time.
    // GREEN.
    const { renderer } = makeHarnessRenderer({ rows: 30, cols: 100 });

    type RendererPrivate = {
      logUpdateClear: () => void;
      logUpdateDone: () => void;
      liveTimer: NodeJS.Timeout | null;
    };
    const r = renderer as unknown as RendererPrivate;
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
    // The harness sets liveTickMs: 0 so no live timer is started by default.
    // Force one to exist so we can observe whether renderSummary cancels it
    // BEFORE the log-update teardown.
    r.liveTimer = setInterval(() => {}, 100_000);

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

    // Invariant: liveTimer must be null at the moment logUpdateClear runs.
    const clearCall = observations.find((c) => c.op === "logUpdateClear");
    expect(clearCall).toBeDefined();
    if (clearCall) {
      expect(clearCall.liveTimerWasSet).toBe(false);
    }
    renderer.dispose();
  });
});
