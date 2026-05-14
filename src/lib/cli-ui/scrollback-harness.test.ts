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
 * STATUS (AC-2 partial): the assertions below currently pass on `main`.
 * That means the harness does NOT yet reproduce the production bug — the
 * `log-update@7` + VT pair we model here correctly tracks wrapped line counts
 * via `wrapAnsi`, so `eraseLines(previousLineCount)` covers everything the
 * renderer wrote. The production bug must come from a real-terminal behaviour
 * the VT does not yet model. AC-1 instrumentation in production is the
 * intended next step to identify which of the issue's candidate mechanisms
 * is firing (likely #2 stream.columns mismatch or #4 process.stdout.rows
 * undefined under `npx`), at which point the harness can be extended (e.g.
 * decouple `streamColumns` from `vt.cols` to simulate the mismatch) to make
 * these assertions fail on `main` as AC-2 requires.
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
function makeHarnessRenderer(opts: { rows: number; cols: number }) {
  const harness = createTerminalHarness(opts);
  const renderer = new TTYRenderer({
    stdoutWrite: harness.stdoutWrite,
    logUpdateInstance: harness.logUpdate,
    isTTY: true,
    noColor: true,
    columns: opts.cols,
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
});
