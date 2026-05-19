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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    // Route the renderer's stderr (used by other diagnostics) into the same
    // VT — that is what a real pty does when stdout and stderr share a tty.
    // #664: `SEQUANT_DEBUG_RENDERER` no longer writes here (it sinks to a
    // file). The 2171× amplification observed in the #647 AC-1 capture was
    // produced by routing the debug instrumentation through this path; the
    // file-sink fix eliminates that amplifier.
    stderrWrite: harness.stderrWrite,
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

  // AC-2 (Mechanism #2-class — out-of-band writes break log-update's cursor
  // model). Forensic analysis of the AC-1 capture
  // (`docs/incidents/647/captures/2026-05-17/analysis.md`) shows that:
  //   - The capture's 2181 `SEQUANT WORKFLOW · ` occurrences are wire-traffic
  //     bytes, not scrollback occurrences.
  //   - Replaying the capture bytes through a 213×31 VT produces only 1
  //     scrollback header if the stderr SEQUANT_DEBUG_RENDERER lines are
  //     stripped first, but 2171 if they are kept (script(1) merged them
  //     into the same pty).
  //   - The amplifier is the stderr instrumentation writing to the same tty
  //     between log-update redraws. log-update tracks `previousLineCount`
  //     from its own writes only; out-of-band writes scroll the terminal
  //     without log-update's knowledge, so the next `eraseLines(N)` erases
  //     wrong lines (or undershoots) and the prior frame's top rows
  //     survive in scrollback.
  //
  // This test reproduces that mechanism deterministically: 1Hz ticks
  // (renderer.tickNow()) drive log-update redraws, with one out-of-band
  // write injected before each tick to simulate any non-log-update writer
  // (stderr instrumentation, subprocess output landing outside a paused
  // window, future feature that writes to stdout, etc.). On `main` HEAD,
  // every redraw cycle leaves a header in scrollback.
  //
  // Marked `it.fails` (vitest's "expected to fail until fix lands" marker)
  // per the issue body's AC-2 requirement: "Test must FAIL on main as of
  // this issue's creation (i.e. reproduces the bug) before any fix code is
  // written." When the AC-3 fix lands, the assertion below will pass and
  // `it.fails` will flip the test into a failure — that's the signal to
  // remove `.fails` and lock the green test in as the permanent regression
  // guard.
  it.fails(
    "AC-2: out-of-band writes between log-update redraws strand headers in scrollback (Mechanism #2-class)",
    () => {
      // Wide single-issue setup matching the AC-1 capture parameters.
      const { renderer, harness } = makeHarnessRenderer({
        rows: 31,
        cols: 213,
      });

      renderer.registerIssue({ issueNumber: 658 });

      // Initial frame so log-update has a `previousOutput` to compare
      // against on subsequent calls.
      renderer.tickNow();

      // Each iteration: write one out-of-band line to the same vt (mimics
      // stderr instrumentation), then trigger a redraw. log-update has no
      // record of the out-of-band line, so `eraseLines(previousLineCount)`
      // misses rows and the prior frame's header survives.
      //
      // Every 10th iteration is a phase event (exercises the
      // appendEventLine path) so we cover both redraw call sites.
      const ITERATIONS = 60;
      for (let i = 0; i < ITERATIONS; i++) {
        harness.stderrWrite(`OUT_OF_BAND ${i}\n`);
        if (i % 10 === 9) {
          renderer.onEvent({
            issue: 658,
            phase: "spec",
            event: "start",
            iteration: Math.floor(i / 10) + 1,
          });
        } else {
          renderer.tickNow();
        }
      }

      // The AC-2 invariant from the issue body: total occurrences of
      // `SEQUANT WORKFLOW · ` in (visible + scrollback) must be exactly 1.
      // This assertion is what the fix needs to make pass; on main it
      // fails because out-of-band writes have stranded prior frames in
      // scrollback. Surface raw terminal state on failure so the
      // mechanism is observable from the test output.
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

      // AC-C: Symptom 2 byte-integrity assertion (bundled #662). Every
      // `SEQUANT WORKFLOW · ... elapsed` line in (visible + scrollback)
      // must match the canonical pattern byte-for-byte — no mid-string
      // drops, no U+FFFD substitutions. Synthetic harness doesn't produce
      // these today (per the AC-1 capture analysis), so this assertion is
      // a negative-result lock-in that fires only if future renderer or
      // log-update changes introduce the corruption synthetically.
      const allLines = [
        ...harness.vt.scrollback,
        ...harness.vt.getVisibleLines(),
      ];
      const headerLines = allLines.filter(
        (l) => l.includes("SEQUANT WORKFLOW · ") && l.includes("elapsed"),
      );
      const corrupted = headerLines.filter(
        (l) =>
          !/^SEQUANT WORKFLOW · (?:#\d+|\d+ issues?) · [^·]+ elapsed/.test(
            l.trim(),
          ),
      );
      expect(corrupted).toEqual([]);

      renderer.dispose();
    },
  );

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

  // #655 negative-result lock-in: drive the motivating issue's exact event
  // sequence (complete `loop` followed by failed `loop` for the same issue)
  // through the harness at a width that exercises both the renderer's
  // `min(cols, 78)` cap AND a pause/resume cycle between the two events. The
  // issue body's forensic byte math (`complete[0:8] + failed[col 9+]` on the
  // same row) would manifest here as a row containing both the green ✔ marker
  // and the error string. Assert that no such row exists.
  //
  // This test is expected to PASS today (synthetic harness does not reproduce
  // Symptom A). Its purpose is to lock in the negative result: if a future
  // change to the renderer or log-update ever introduces an overlay reachable
  // synthetically, this test will catch it without needing a real-terminal
  // capture. See `docs/incidents/655/negative-result.md`.
  it("#655 negative-result lock-in: complete→failed event sequence does not produce an overlay row", () => {
    const { renderer, harness } = makeHarnessRenderer({
      rows: 24,
      cols: 80,
      streamColumns: 100,
      rendererColumns: 100,
    });

    renderer.registerIssue({ issueNumber: 505 });
    // Drive enough phase activity to push the live frame around in the
    // viewport before the loop pair fires.
    renderer.onEvent({ issue: 505, phase: "spec", event: "start" });
    renderer.onEvent({
      issue: 505,
      phase: "spec",
      event: "complete",
      durationSeconds: 232,
    });
    renderer.onEvent({ issue: 505, phase: "exec", event: "start" });
    renderer.onEvent({
      issue: 505,
      phase: "exec",
      event: "complete",
      durationSeconds: 820,
    });
    // The motivating pair: complete loop then failed loop for the same issue,
    // separated by a pause/resume that mimics verbose subprocess streaming
    // toggling. Pause/resume cycling exercises the `logUpdateClear()` →
    // `redraw()` path between the two event-line writes.
    renderer.onEvent({
      issue: 505,
      phase: "loop",
      event: "complete",
      durationSeconds: 60,
    });
    renderer.pause();
    harness.stdoutWrite("  [verbose] streamed line between events\n");
    renderer.resume();
    renderer.onEvent({
      issue: 505,
      phase: "loop",
      event: "failed",
      error: "Claude Code returned an error result: ETIMEDOUT",
    });

    // Overlay detector: any single row that contains BOTH the green ✔ marker
    // (only present on `complete` event lines) and the error string (only
    // present on `failed` event lines) is the Symptom A signature. The two
    // event types cannot legitimately co-occur on a single row.
    const allRows = [...harness.vt.scrollback, ...harness.vt.getVisibleLines()];
    const overlay = allRows.find(
      (row) => row.includes("✔") && row.includes("Claude Code returned"),
    );
    if (overlay) {
      throw new Error(
        `Symptom A overlay row produced synthetically (unexpected). Row:\n  ${overlay}`,
      );
    }
    expect(overlay).toBeUndefined();
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

describe("#664 SEQUANT_DEBUG_RENDERER file sink", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sequant-664-"));
    originalCwd = process.cwd();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try {
      process.chdir(originalCwd);
    } catch {
      // ignore — already on the original cwd
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore — test artefacts only
    }
  });

  // AC-1 + AC-5: debug output goes to default file path, NOT stderr.
  // The stderrWrite stub throws on any debug-format call (line starting with
  // "SEQUANT_DEBUG_RENDERER "), so if the renderer falls back to stderr we
  // see an exception instead of a passing test.
  it("AC-1/AC-5: default path receives writes, stderr is never called for debug output", () => {
    process.chdir(tmpDir);
    vi.stubEnv("SEQUANT_DEBUG_RENDERER", "1");
    vi.stubEnv("SEQUANT_DEBUG_RENDERER_FILE", "");

    const stderrCalls: string[] = [];
    const throwingStderr = (s: string) => {
      if (s.startsWith("SEQUANT_DEBUG_RENDERER ")) {
        throw new Error(
          `stderr received debug output it should not have: ${s}`,
        );
      }
      stderrCalls.push(s);
    };

    const harness = createTerminalHarness({ rows: 24, cols: 100 });
    const renderer = new TTYRenderer({
      stdoutWrite: harness.stdoutWrite,
      stderrWrite: throwingStderr,
      logUpdateInstance: harness.logUpdate,
      isTTY: true,
      noColor: true,
      columns: 100,
      rows: 24,
      liveTickMs: 0,
      noSignalListeners: true,
      now: () => FIXED_NOW,
      wallClock: () => FIXED_DATE,
    });

    renderer.registerIssue({ issueNumber: 664 });
    renderer.onEvent({ issue: 664, phase: "spec", event: "start" });
    renderer.onEvent({
      issue: 664,
      phase: "spec",
      event: "complete",
      durationSeconds: 30,
    });
    renderer.dispose();

    const defaultFile = path.join(tmpDir, ".sequant", "debug-renderer.jsonl");
    expect(fs.existsSync(defaultFile)).toBe(true);
    const content = fs.readFileSync(defaultFile, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.startsWith("SEQUANT_DEBUG_RENDERER ")).toBe(true);
    }
    // No stderr calls at all are expected on the debug path; the throwing
    // stub above is the primary guard, but assert explicitly so a future
    // regression that bypasses the throw still fails the test.
    const debugStderrCalls = stderrCalls.filter((s) =>
      s.startsWith("SEQUANT_DEBUG_RENDERER "),
    );
    expect(debugStderrCalls).toEqual([]);
  });

  // AC-2: explicit SEQUANT_DEBUG_RENDERER_FILE override is honoured.
  it("AC-2: SEQUANT_DEBUG_RENDERER_FILE override path receives writes; default path is not created", () => {
    process.chdir(tmpDir);
    const overridePath = path.join(tmpDir, "custom-debug.jsonl");
    vi.stubEnv("SEQUANT_DEBUG_RENDERER", "1");
    vi.stubEnv("SEQUANT_DEBUG_RENDERER_FILE", overridePath);

    const harness = createTerminalHarness({ rows: 24, cols: 100 });
    const renderer = new TTYRenderer({
      stdoutWrite: harness.stdoutWrite,
      stderrWrite: harness.stderrWrite,
      logUpdateInstance: harness.logUpdate,
      isTTY: true,
      noColor: true,
      columns: 100,
      rows: 24,
      liveTickMs: 0,
      noSignalListeners: true,
      now: () => FIXED_NOW,
      wallClock: () => FIXED_DATE,
    });

    renderer.registerIssue({ issueNumber: 664 });
    renderer.onEvent({ issue: 664, phase: "spec", event: "start" });
    renderer.dispose();

    expect(fs.existsSync(overridePath)).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, ".sequant", "debug-renderer.jsonl")),
    ).toBe(false);
    const content = fs.readFileSync(overridePath, "utf8");
    expect(content.length).toBeGreaterThan(0);
  });

  // Locks in the `||`-vs-`??` semantics for SEQUANT_DEBUG_RENDERER_FILE: an
  // empty env var (e.g. `SEQUANT_DEBUG_RENDERER_FILE= …`) must fall back to
  // the default path, not be passed verbatim to openSync. With `??` (nullish
  // coalescing) the empty string would propagate and openSync would throw,
  // routing through the fallback-notice path and silently disabling all
  // debug output. This test fails immediately if anyone refactors the
  // operator. See run-renderer.ts:586 inline comment.
  it("AC-2 (lockin): empty SEQUANT_DEBUG_RENDERER_FILE falls back to default path, not empty-string openSync", () => {
    process.chdir(tmpDir);
    vi.stubEnv("SEQUANT_DEBUG_RENDERER", "1");
    vi.stubEnv("SEQUANT_DEBUG_RENDERER_FILE", "");

    // stderrWrite stub that fails the test if the fallback-notice path
    // fires — that path only runs when openSync rejects the resolved
    // debugPath, which would happen if `??` let "" through.
    const fallbackNoticeCalls: string[] = [];
    const stderrWatcher = (s: string) => {
      if (s.startsWith("SEQUANT_DEBUG_RENDERER: file sink unavailable")) {
        fallbackNoticeCalls.push(s);
      }
    };

    const harness = createTerminalHarness({ rows: 24, cols: 100 });
    const renderer = new TTYRenderer({
      stdoutWrite: harness.stdoutWrite,
      stderrWrite: stderrWatcher,
      logUpdateInstance: harness.logUpdate,
      isTTY: true,
      noColor: true,
      columns: 100,
      rows: 24,
      liveTickMs: 0,
      noSignalListeners: true,
      now: () => FIXED_NOW,
      wallClock: () => FIXED_DATE,
    });
    renderer.registerIssue({ issueNumber: 664 });
    renderer.onEvent({ issue: 664, phase: "spec", event: "start" });
    renderer.dispose();

    expect(fallbackNoticeCalls).toEqual([]);
    expect(
      fs.existsSync(path.join(tmpDir, ".sequant", "debug-renderer.jsonl")),
    ).toBe(true);
  });

  // AC-3: JSON schema per record matches the pre-fix shape so existing
  // diagnostic replay tooling keeps working.
  it("AC-3: each line is `SEQUANT_DEBUG_RENDERER ` + JSON record matching prior schema", () => {
    const overridePath = path.join(tmpDir, "schema-debug.jsonl");
    vi.stubEnv("SEQUANT_DEBUG_RENDERER", "1");
    vi.stubEnv("SEQUANT_DEBUG_RENDERER_FILE", overridePath);

    const harness = createTerminalHarness({ rows: 24, cols: 100 });
    const renderer = new TTYRenderer({
      stdoutWrite: harness.stdoutWrite,
      stderrWrite: harness.stderrWrite,
      logUpdateInstance: harness.logUpdate,
      isTTY: true,
      noColor: true,
      columns: 100,
      rows: 24,
      liveTickMs: 0,
      noSignalListeners: true,
      now: () => FIXED_NOW,
      wallClock: () => FIXED_DATE,
    });

    renderer.registerIssue({ issueNumber: 664 });
    renderer.onEvent({ issue: 664, phase: "spec", event: "start" });
    renderer.onEvent({
      issue: 664,
      phase: "spec",
      event: "complete",
      durationSeconds: 30,
    });
    renderer.dispose();

    const lines = fs
      .readFileSync(overridePath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const prefix = "SEQUANT_DEBUG_RENDERER ";
      expect(line.startsWith(prefix)).toBe(true);
      const json = line.slice(prefix.length);
      const record = JSON.parse(json) as Record<string, unknown>;
      // Pre-fix schema (run-renderer.ts emitDebug record). Each key must be
      // present so the AC-1 capture analyser can replay this file unchanged.
      for (const key of [
        "t",
        "op",
        "frame",
        "rendererCols",
        "rendererRows",
        "stdoutCols",
        "stdoutRows",
      ]) {
        expect(record, `missing key ${key}`).toHaveProperty(key);
      }
      expect(["impl", "clear", "done"]).toContain(record.op);
    }
  });

  // AC-4: unwritable sink falls through to no-op rather than crashing, and
  // emits a single startup notice to stderr so the user sees why their
  // debug.jsonl is empty. Use `/dev/null/x.jsonl` — `/dev/null` is not a
  // directory, so both `mkdirSync` (on its parent) and `openSync` fail.
  it("AC-4: unwritable file path → one-shot stderr notice, no crash, no per-op spam", () => {
    const unwritable = "/dev/null/foo/debug.jsonl";
    vi.stubEnv("SEQUANT_DEBUG_RENDERER", "1");
    vi.stubEnv("SEQUANT_DEBUG_RENDERER_FILE", unwritable);

    const stderrCalls: string[] = [];
    const recordingStderr = (s: string) => {
      stderrCalls.push(s);
    };

    const harness = createTerminalHarness({ rows: 24, cols: 100 });
    expect(() => {
      const renderer = new TTYRenderer({
        stdoutWrite: harness.stdoutWrite,
        stderrWrite: recordingStderr,
        logUpdateInstance: harness.logUpdate,
        isTTY: true,
        noColor: true,
        columns: 100,
        rows: 24,
        liveTickMs: 0,
        noSignalListeners: true,
        now: () => FIXED_NOW,
        wallClock: () => FIXED_DATE,
      });
      renderer.registerIssue({ issueNumber: 664 });
      renderer.onEvent({ issue: 664, phase: "spec", event: "start" });
      renderer.onEvent({
        issue: 664,
        phase: "spec",
        event: "complete",
        durationSeconds: 30,
      });
      renderer.dispose();
    }).not.toThrow();

    const fallbackNotices = stderrCalls.filter((s) =>
      s.startsWith("SEQUANT_DEBUG_RENDERER: file sink unavailable"),
    );
    expect(fallbackNotices.length).toBe(1);
    // No debug-output stderr lines should leak through as a "fallback"
    // path — once we fail to open the file, emitDebug becomes a no-op.
    const debugOutputCalls = stderrCalls.filter((s) =>
      s.startsWith("SEQUANT_DEBUG_RENDERER "),
    );
    expect(debugOutputCalls).toEqual([]);
  });
});
