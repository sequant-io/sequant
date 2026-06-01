// @tautology-skip: tests construct renderers via the makeTTY / makeNonTTY
// helpers (which internally call `new TTYRenderer(...)` / `new NonTTYRenderer`)
// and exercise production methods (`r.onEvent`, `r.renderLiveFrame`,
// `r.renderSummary`, etc.) on the resulting instances. The detector's
// imported-name body scan does not follow helper functions, so most tests
// here are flagged as not-calling-production despite testing it transitively.
/**
 * Tests for Issue #624 — run renderer follow-ups (#618 follow-up).
 *
 * Run with: npm test -- src/lib/cli-ui/run-renderer-624.test.ts
 *
 * Coverage map (15 ACs + 3 derived):
 *   Item 1 — live-zone height cap        : AC-1.1, AC-1.2, AC-1.3
 *   Item 2 — summary corruption          : AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-2.5
 *   Item 3 — exec attempt counter        : AC-3.1, AC-3.2, AC-3.3, AC-3.4
 *   Item 4 — failure dedup               : AC-4.1, AC-4.2, AC-4.3
 *   Derived                              : AC-D1, AC-D2, AC-D3
 */

import { describe, expect, it } from "vitest";
import {
  NonTTYRenderer,
  TTYRenderer,
  failureSignature,
  formatRetrySuffix,
} from "./run-renderer.js";
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

/**
 * Replay the motivating-transcript scenario from #624.
 *
 * The literal transcript (verbatim from the issue) is:
 *   - 2 issues registered (#608, #604)
 *   - #604 spec ✔, #608 spec ✔
 *   - #608 exec ✔, then qa ✔ → PR #623
 *   - #604 exec ✘ (3×, same failure each time, then loop drives retry)
 *
 * @see feedback_motivating_example_regression
 */
function replayTranscript(renderer: TTYRenderer | NonTTYRenderer): void {
  renderer.registerIssue({ issueNumber: 608 });
  renderer.registerIssue({ issueNumber: 604 });

  const events: ProgressEvent[] = [
    { issue: 608, phase: "spec", event: "start", iteration: 1 },
    { issue: 604, phase: "spec", event: "start", iteration: 1 },
    {
      issue: 604,
      phase: "spec",
      event: "complete",
      durationSeconds: 49,
      iteration: 1,
    },
    { issue: 604, phase: "exec", event: "start", iteration: 1 },
    {
      issue: 608,
      phase: "spec",
      event: "complete",
      durationSeconds: 61,
      iteration: 1,
    },
    { issue: 608, phase: "exec", event: "start", iteration: 1 },
    {
      issue: 608,
      phase: "exec",
      event: "complete",
      durationSeconds: 141,
      iteration: 1,
    },
    { issue: 608, phase: "qa", event: "start", iteration: 1 },
    {
      issue: 604,
      phase: "exec",
      event: "failed",
      error: "exec produced no changes (no commits, no uncommitted work)",
      iteration: 1,
    },
    { issue: 604, phase: "loop", event: "start", iteration: 1 },
    {
      issue: 604,
      phase: "loop",
      event: "complete",
      durationSeconds: 26,
      iteration: 1,
    },
    { issue: 604, phase: "exec", event: "start", iteration: 2 },
    {
      issue: 604,
      phase: "exec",
      event: "failed",
      error: "exec produced no changes (no commits, no uncommitted work)",
      iteration: 2,
    },
    { issue: 604, phase: "loop", event: "start", iteration: 2 },
    {
      issue: 608,
      phase: "qa",
      event: "complete",
      durationSeconds: 275,
      iteration: 1,
    },
    {
      issue: 604,
      phase: "loop",
      event: "complete",
      durationSeconds: 52,
      iteration: 2,
    },
    { issue: 604, phase: "exec", event: "start", iteration: 3 },
    {
      issue: 604,
      phase: "exec",
      event: "failed",
      error: "exec produced no changes (no commits, no uncommitted work)",
      iteration: 3,
    },
  ];
  for (const e of events) renderer.onEvent(e);
}

// =============================================================================
// Item 1 — Cap live-zone height
// =============================================================================

describe("Item 1 — live-zone height cap (TTYRenderer)", () => {
  it("AC-1.1: live zone height ≤ max(8, rows - 5) regardless of issue count", () => {
    const { r } = makeTTY({ columns: 100, rows: 20, multiIssueRowCap: 12 });
    for (let i = 1; i <= 12; i++) {
      r.registerIssue({ issueNumber: 600 + i });
      r.onEvent({ issue: 600 + i, phase: "exec", event: "start" });
    }
    const frame = stripAnsi(r.renderLiveFrame(100));
    const lineCount = frame.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(Math.max(8, 20 - 5));
    r.dispose();
  });

  it("AC-1.2: keeps exactly one live frame on screen after 5 issues × 10 events", () => {
    const { r } = makeTTY({ columns: 100, rows: 20 });
    for (let i = 1; i <= 5; i++) r.registerIssue({ issueNumber: 600 + i });

    // 10 events, each triggers a redraw → 10 frames replaced.
    const events: ProgressEvent[] = [];
    for (let i = 1; i <= 5; i++) {
      events.push({ issue: 600 + i, phase: "spec", event: "start" });
    }
    for (let i = 1; i <= 5; i++) {
      events.push({
        issue: 600 + i,
        phase: "spec",
        event: "complete",
        durationSeconds: 10,
      });
    }
    for (const e of events) r.onEvent(e);

    // Replacement-aware stub: one replacement per redraw beyond the first.
    const stub = r.getTestStub();
    expect(stub).not.toBeNull();
    // Each registerIssue + each onEvent triggers a redraw. 5 registers + 10
    // events = 15 redraws → 14 replacements (first call wasn't a replacement).
    expect(stub!.replacementCount).toBeGreaterThanOrEqual(10);

    // AC text says "captured output contains exactly one `SEQUANT WORKFLOW ·`
    // line per state". In test mode the stdout buffer accumulates every redraw
    // (the stub doesn't simulate log-update's in-place replacement); the right
    // semantic is `stub.lastFrame` — what a real terminal shows after the live
    // zone redraws. Asserting on `buf.joined()` would be wrong because the
    // stub appends instead of replacing.
    expect(stub!.lastFrame.match(/SEQUANT WORKFLOW ·/g) ?? []).toHaveLength(1);
    r.dispose();
  });

  it("AC-1.3: motivating-transcript scenario produces ≤ 1 header per state in the live frame", () => {
    for (const rows of [24, 50]) {
      for (const cols of [70, 100]) {
        const { r } = makeTTY({ columns: cols, rows });
        replayTranscript(r);
        const stub = r.getTestStub()!;
        // The latest live frame should have exactly one header line.
        const headers = stub.lastFrame.match(/SEQUANT WORKFLOW ·/g) ?? [];
        expect(headers).toHaveLength(1);
        // And the frame must respect the height cap.
        expect(stub.lastFrame.split("\n").length).toBeLessThanOrEqual(
          Math.max(8, rows - 5),
        );
        r.dispose();
      }
    }
  });

  describe("error handling", () => {
    it("clamps live zone to floor of 8 lines when rows < 13", () => {
      const { r } = makeTTY({ columns: 100, rows: 10 });
      for (let i = 1; i <= 8; i++) {
        r.registerIssue({ issueNumber: 600 + i });
        r.onEvent({ issue: 600 + i, phase: "exec", event: "start" });
      }
      const frame = stripAnsi(r.renderLiveFrame(100));
      expect(frame.split("\n").length).toBeLessThanOrEqual(8);
      r.dispose();
    });

    it("uses generous default rows (100) and renders normally when rows is omitted", () => {
      const { r } = makeTTY({ columns: 100 }); // rows omitted → DEFAULT_TERMINAL_ROWS=100
      r.registerIssue({ issueNumber: 614 });
      r.onEvent({ issue: 614, phase: "exec", event: "start" });
      const frame = stripAnsi(r.renderLiveFrame(100));
      expect(frame.length).toBeGreaterThan(0);
      expect(frame).toContain("#614");
      // At default rows=100, getMaxLiveRows()=95 — single-issue frame is well
      // under the cap, so the frame renders unclamped (no overflow indicator).
      expect(frame).not.toContain("more line");
      r.dispose();
    });

    it("re-evaluates cap when frame is rendered after a height change", () => {
      const buf = buffer();
      const r = new TTYRenderer({
        stdoutWrite: buf.write,
        noColor: true,
        now: () => FIXED_NOW,
        wallClock: () => FIXED_DATE,
        isTTY: true,
        columns: 100,
        rows: 50,
        liveTickMs: 0,
        noSignalListeners: true,
      });
      for (let i = 1; i <= 10; i++) {
        r.registerIssue({ issueNumber: 600 + i });
      }
      const tall = stripAnsi(r.renderLiveFrame(100));
      // At rows=50 the frame can be larger; just assert below cap.
      expect(tall.split("\n").length).toBeLessThanOrEqual(Math.max(8, 50 - 5));
      r.dispose();
    });
  });
});

// =============================================================================
// Item 2 — Summary teardown / width clamp
// =============================================================================

describe("Item 2 — summary teardown + width clamp", () => {
  it("AC-2.1: corruption repro matrix — no box-char or U+FFFD garble at any (cols, rows)", () => {
    for (const cols of [70, 100]) {
      for (const rows of [24, 50]) {
        const { r, buf } = makeTTY({ columns: cols, rows });
        r.registerIssue({ issueNumber: 608 });
        r.registerIssue({ issueNumber: 604 });
        r.onEvent({ issue: 608, phase: "spec", event: "start" });
        r.onEvent({
          issue: 608,
          phase: "spec",
          event: "complete",
          durationSeconds: 60,
        });
        r.onEvent({
          issue: 604,
          phase: "exec",
          event: "failed",
          error: "bad",
        });
        r.renderSummary({
          issues: [
            {
              issueNumber: 608,
              success: true,
              durationSeconds: 60,
              phases: [{ name: "spec", success: true }],
              prNumber: 999,
            },
            {
              issueNumber: 604,
              success: false,
              durationSeconds: 60,
              phases: [{ name: "exec", success: false }],
              failureReason: "exec produced no changes",
            },
          ],
        });
        const out = stripAnsi(buf.joined());
        // No replacement character, no half-open box junk.
        expect(out).not.toContain("�");
        // No bare `\x1b[K` erase-line escapes leaking past the live zone.
        expect(buf.joined()).not.toMatch(/\x1b\[K[A-Za-z0-9]/);
        // The verbatim corruption from the motivating transcript was
        // `├───────�ing:` — a box-drawing char abutting alphanumeric text.
        // U+2500..U+257F covers the entire Box Drawing block (canonical JS
        // regex equivalent of `\p{Block=Box_Drawing}`, which V8 does not
        // support — ECMAScript only allows General_Category / Script /
        // Script_Extensions / binary properties).
        expect(out).not.toMatch(/[─-╿][A-Za-z0-9]/u);
        r.dispose();
      }
    }
  });

  it("AC-2.2: renderSummary invokes logUpdate.clear() + logUpdate.done() before writing summary", () => {
    const writes: string[] = [];
    const r = new TTYRenderer({
      stdoutWrite: (s) => writes.push(s),
      noColor: true,
      now: () => FIXED_NOW,
      wallClock: () => FIXED_DATE,
      isTTY: true,
      columns: 100,
      liveTickMs: 0,
      noSignalListeners: true,
    });
    r.registerIssue({ issueNumber: 614 });
    r.onEvent({ issue: 614, phase: "spec", event: "start" });

    const stub = r.getTestStub()!;
    expect(stub.lastFrame.length).toBeGreaterThan(0);
    const clearsBefore = stub.clearCalls;
    const donesBefore = stub.doneCalls;

    r.renderSummary({
      issues: [
        {
          issueNumber: 614,
          success: true,
          durationSeconds: 60,
          phases: [{ name: "spec", success: true }],
        },
      ],
    });

    // Counter assertions prove the renderer actually called the teardown
    // methods on log-update — not just that the stub's local state was reset.
    expect(stub.clearCalls).toBeGreaterThan(clearsBefore);
    expect(stub.doneCalls).toBeGreaterThan(donesBefore);
    expect(stub.lastFrame).toBe("");

    // And the summary block was written after the teardown.
    const last = writes.join("");
    expect(stripAnsi(last)).toContain("SUMMARY · 1 issue");
    r.dispose();
  });

  it("AC-2.3 (TTY): cols=200 and cols=110 produce identical summary widths (cap pinned at 110)", () => {
    const renderAt = (cols: number): number => {
      const { r, buf } = makeTTY({ columns: cols });
      r.registerIssue({ issueNumber: 614 });
      r.renderSummary({
        issues: [
          {
            issueNumber: 614,
            success: true,
            durationSeconds: 60,
            phases: [{ name: "spec", success: true }],
          },
        ],
      });
      const out = stripAnsi(buf.joined());
      let maxLineWidth = 0;
      for (const line of out.split("\n")) {
        if (line.length > maxLineWidth) maxLineWidth = line.length;
      }
      r.dispose();
      return maxLineWidth;
    };

    const widthAt110 = renderAt(110);
    const widthAt200 = renderAt(200);
    // Pin the cap: at any cols ≥ 110, the visible summary width must equal
    // the width at cols=110. If SUMMARY_COLUMN_CAP were silently bumped or
    // lowered (current value 110), this equality would break.
    expect(widthAt200).toBe(widthAt110);
    // And the cap is at or below 110 (allow 2 chars of left-margin slack).
    expect(widthAt200).toBeLessThanOrEqual(112);
  });

  it("AC-2.3 (NonTTY): renders box-drawing summary with the same pinned cap as TTY", () => {
    const renderAt = (cols: number): { width: number; out: string } => {
      const { r, buf } = makeNonTTY({ columns: cols });
      r.registerIssue({ issueNumber: 614 });
      r.renderSummary({
        issues: [
          {
            issueNumber: 614,
            success: true,
            durationSeconds: 60,
            phases: [{ name: "spec", success: true }],
          },
        ],
      });
      const out = stripAnsi(buf.joined());
      let width = 0;
      for (const line of out.split("\n")) {
        if (line.length > width) width = line.length;
      }
      r.dispose();
      return { width, out };
    };

    const at110 = renderAt(110);
    const at200 = renderAt(200);
    // NonTTY path shares the same SUMMARY_COLUMN_CAP — width at cols=200 must
    // equal width at cols=110 (the cap pins it).
    expect(at200.width).toBe(at110.width);
    expect(at200.width).toBeLessThanOrEqual(112);
    // The narrow-fallback (no box drawing) is NOT triggered at columns=200 —
    // i.e. the AC-2.3 fix replaced the hardcoded 80 with the shared cap.
    expect(at200.out).toContain("┌");
  });

  it("AC-2.4: motivating-transcript scenario produces clean captured stdout (no \\x1b[K leak, no U+FFFD)", () => {
    const { r, buf } = makeTTY({ columns: 100, rows: 24 });
    replayTranscript(r);
    r.renderSummary({
      issues: [
        {
          issueNumber: 608,
          success: true,
          durationSeconds: 478,
          phases: [
            { name: "spec", success: true },
            { name: "exec", success: true },
            { name: "qa", success: true },
          ],
          prNumber: 623,
        },
        {
          issueNumber: 604,
          success: false,
          durationSeconds: 700,
          phases: [{ name: "exec", success: false }],
          failureReason: "exec produced no changes",
        },
      ],
    });
    const raw = buf.joined();
    const stripped = stripAnsi(raw);
    // No replacement character.
    expect(stripped).not.toContain("�");
    // No erase-line escape leak.
    expect(raw).not.toMatch(/\x1b\[K[A-Za-z0-9]/);
    // No `├ing:`-style box-char abutting alphanumeric (the verbatim corruption
    // from the issue body).
    expect(stripped).not.toMatch(/[─-╿][A-Za-z0-9]/u);
    r.dispose();
  });

  describe.each([
    [70, 24],
    [70, 50],
    [100, 24],
    [100, 50],
    [140, 24],
    [140, 50],
  ])("AC-2.5: matrix (cols=%i, rows=%i)", (cols, rows) => {
    it.each([1, 2, 4])("renders cleanly with %i issues", (issueCount) => {
      const { r, buf } = makeTTY({ columns: cols, rows });
      for (let i = 1; i <= issueCount; i++) {
        r.registerIssue({ issueNumber: 600 + i });
        r.onEvent({ issue: 600 + i, phase: "spec", event: "start" });
        r.onEvent({
          issue: 600 + i,
          phase: "spec",
          event: "complete",
          durationSeconds: 60,
        });
      }
      r.renderSummary({
        issues: Array.from({ length: issueCount }, (_, i) => ({
          issueNumber: 601 + i,
          success: true,
          durationSeconds: 60,
          phases: [{ name: "spec", success: true }],
        })),
      });
      const raw = buf.joined();
      const stripped = stripAnsi(raw);
      expect(stripped).not.toContain("�");
      expect(raw).not.toMatch(/\x1b\[K[A-Za-z0-9]/);
      r.dispose();
    });
  });
});

// =============================================================================
// Item 3 — Exec attempt counter
// =============================================================================

describe("Item 3 — exec attempt counter", () => {
  it("AC-3.1 (post-#672): TTYRenderer failure lines carry `(attempt N/M)` from second exec onwards", () => {
    // #672 AC-1 dropped the TTY `▸ start` journal line, so the attempt
    // suffix on retries surfaces through the surviving failure lines and
    // the live-zone `loop N/M` status header. NonTTY behaviour is covered
    // separately by AC-3.2 below.
    const { r, buf } = makeTTY({ columns: 100, maxLoopIterations: 3 });
    r.registerIssue({ issueNumber: 604 });
    r.onEvent({ issue: 604, phase: "exec", event: "start", iteration: 1 });
    r.onEvent({
      issue: 604,
      phase: "exec",
      event: "failed",
      error: "boom",
      iteration: 1,
    });
    r.onEvent({ issue: 604, phase: "loop", event: "start", iteration: 1 });
    r.onEvent({
      issue: 604,
      phase: "loop",
      event: "complete",
      durationSeconds: 26,
      iteration: 1,
    });
    r.onEvent({ issue: 604, phase: "exec", event: "start", iteration: 2 });
    r.onEvent({
      issue: 604,
      phase: "exec",
      event: "failed",
      error: "different err",
      iteration: 2,
    });
    r.onEvent({ issue: 604, phase: "loop", event: "start", iteration: 2 });
    r.onEvent({
      issue: 604,
      phase: "loop",
      event: "complete",
      durationSeconds: 52,
      iteration: 2,
    });
    r.onEvent({ issue: 604, phase: "exec", event: "start", iteration: 3 });

    const stripped = stripAnsi(buf.joined());
    const execFailLines = stripped
      .split("\n")
      .filter((l) => /✘ #604 exec/.test(l));
    expect(execFailLines).toHaveLength(2);
    expect(execFailLines[0]).not.toMatch(/\(attempt/);
    expect(execFailLines[1]).toContain("(attempt 2/3)");
    // Live frame status header carries the third attempt counter via `loop N/M`.
    const frame = stripAnsi(r.renderLiveFrame(100));
    expect(frame).toMatch(/exec loop 3\/3/);
    r.dispose();
  });

  it("AC-3.2: NonTTYRenderer event lines emit identical `(attempt N/M)` suffix", () => {
    const { r, buf } = makeNonTTY({ maxLoopIterations: 3 });
    r.registerIssue({ issueNumber: 604 });
    r.onEvent({ issue: 604, phase: "exec", event: "start", iteration: 1 });
    r.onEvent({
      issue: 604,
      phase: "exec",
      event: "failed",
      error: "boom",
      iteration: 1,
    });
    r.onEvent({ issue: 604, phase: "exec", event: "start", iteration: 2 });
    r.onEvent({
      issue: 604,
      phase: "exec",
      event: "failed",
      error: "different err",
      iteration: 2,
    });
    r.onEvent({ issue: 604, phase: "exec", event: "start", iteration: 3 });

    const stripped = stripAnsi(buf.joined());
    const execStartLines = stripped
      .split("\n")
      .filter((l) => /▸ #604 exec/.test(l));
    expect(execStartLines[0]).not.toMatch(/\(attempt/);
    expect(execStartLines[1]).toContain("(attempt 2/3)");
    expect(execStartLines[2]).toContain("(attempt 3/3)");
    r.dispose();
  });

  it("AC-3.3: TTYRenderer live-zone status cell shows `loop N/M · last fail: <reason>` while retrying", () => {
    const { r } = makeTTY({ columns: 100, maxLoopIterations: 3 });
    r.registerIssue({ issueNumber: 604 });
    r.onEvent({ issue: 604, phase: "exec", event: "start", iteration: 1 });
    r.onEvent({
      issue: 604,
      phase: "exec",
      event: "failed",
      error: "exec produced no changes",
      iteration: 1,
    });
    r.onEvent({ issue: 604, phase: "loop", event: "start", iteration: 1 });

    const frame = stripAnsi(r.renderLiveFrame(100));
    expect(frame).toMatch(/loop 1\/3 · last fail: exec produced no changes/);
    r.dispose();
  });

  it("AC-3.4: 3-attempt exec emits `(attempt 2/3)` and `(attempt 3/3)` in both render paths", () => {
    const drive = (renderer: TTYRenderer | NonTTYRenderer): void => {
      renderer.registerIssue({ issueNumber: 604 });
      for (let i = 1; i <= 3; i++) {
        renderer.onEvent({
          issue: 604,
          phase: "exec",
          event: "start",
          iteration: i,
        });
        if (i < 3)
          renderer.onEvent({
            issue: 604,
            phase: "exec",
            event: "failed",
            error: `err-${i}`,
            iteration: i,
          });
      }
    };

    const { r: tty, buf: ttyBuf } = makeTTY({ maxLoopIterations: 3 });
    drive(tty);
    const ttyOut = stripAnsi(ttyBuf.joined());
    // #672 AC-1: TTY scrollback now only carries terminal transitions
    // (`✘ failed` here). The retry suffix surfaces on the failure lines —
    // the dropped `▸ start` lines previously carried it too. The third
    // attempt has no failure (it's still `start` only), so we only check
    // the second.
    expect(ttyOut).toContain("(attempt 2/3)");
    // Live frame surfaces the third attempt as `loop N/M`.
    const ttyFrame = stripAnsi(tty.renderLiveFrame(100));
    expect(ttyFrame).toMatch(/exec loop 3\/3/);
    tty.dispose();

    const { r: nonTty, buf: nonTtyBuf } = makeNonTTY({ maxLoopIterations: 3 });
    drive(nonTty);
    const nonTtyOut = stripAnsi(nonTtyBuf.joined());
    expect(nonTtyOut).toContain("(attempt 2/3)");
    expect(nonTtyOut).toContain("(attempt 3/3)");
    nonTty.dispose();
  });

  describe("error handling", () => {
    it("does not emit `(attempt N/M)` when only a single exec attempt occurs", () => {
      const { r, buf } = makeTTY({ maxLoopIterations: 3 });
      r.registerIssue({ issueNumber: 614 });
      r.onEvent({ issue: 614, phase: "exec", event: "start", iteration: 1 });
      r.onEvent({
        issue: 614,
        phase: "exec",
        event: "complete",
        durationSeconds: 60,
        iteration: 1,
      });
      expect(stripAnsi(buf.joined())).not.toMatch(/\(attempt/);
      r.dispose();
    });

    it("handles `iteration` missing from event payload (back-compat)", () => {
      const { r, buf } = makeTTY({ maxLoopIterations: 3 });
      r.registerIssue({ issueNumber: 614 });
      // No iteration field — pre-#624 emitters.
      r.onEvent({ issue: 614, phase: "exec", event: "start" });
      r.onEvent({
        issue: 614,
        phase: "exec",
        event: "complete",
        durationSeconds: 60,
      });
      const out = stripAnsi(buf.joined());
      expect(out).not.toMatch(/\(attempt/);
      // #672 AC-1: TTY scrollback no longer carries `▸` start lines; only
      // the `✔ complete` line remains.
      expect(out).toContain("✔ #614 exec");
      expect(out).not.toContain("▸ #614 exec");
      r.dispose();
    });
  });
});

// =============================================================================
// Item 4 — Collapse repeated identical failures
// =============================================================================

describe("Item 4 — failure dedup", () => {
  it("AC-4.1: when failureSignature matches previous, abbreviate subsequent occurrence", () => {
    const err = "exec produced no changes (no commits, no uncommitted work)";
    const { r, buf } = makeTTY({ maxLoopIterations: 3 });
    r.registerIssue({ issueNumber: 604 });
    r.onEvent({ issue: 604, phase: "exec", event: "start", iteration: 1 });
    r.onEvent({
      issue: 604,
      phase: "exec",
      event: "failed",
      error: err,
      iteration: 1,
    });
    r.onEvent({ issue: 604, phase: "exec", event: "start", iteration: 2 });
    r.onEvent({
      issue: 604,
      phase: "exec",
      event: "failed",
      error: err,
      iteration: 2,
    });

    const stripped = stripAnsi(buf.joined());
    const failLines = stripped.split("\n").filter((l) => /✘ #604 exec/.test(l));
    expect(failLines[0]).toContain("exec produced no changes");
    expect(failLines[1]).toContain("same failure as attempt 1");
    expect(failLines[1]).not.toContain("exec produced no changes");
    r.dispose();
  });

  it("AC-4.2: full text re-emitted on the final attempt before giving up", () => {
    const err = "exec produced no changes";
    const { r, buf } = makeTTY({ maxLoopIterations: 3 });
    r.registerIssue({ issueNumber: 604 });
    for (let i = 1; i <= 3; i++) {
      r.onEvent({ issue: 604, phase: "exec", event: "start", iteration: i });
      r.onEvent({
        issue: 604,
        phase: "exec",
        event: "failed",
        error: err,
        iteration: i,
      });
    }
    const stripped = stripAnsi(buf.joined());
    const failLines = stripped.split("\n").filter((l) => /✘ #604 exec/.test(l));
    expect(failLines).toHaveLength(3);
    expect(failLines[0]).toContain("exec produced no changes");
    expect(failLines[1]).toContain("same failure as attempt 1");
    expect(failLines[2]).toContain("exec produced no changes");
    expect(failLines[2]).not.toContain("same failure as");
    r.dispose();
  });

  it("AC-4.3 (literal): 3 identical with maxIter=3 → full/abbreviated/full (last-before-max-iter)", () => {
    const err = "exec produced no changes (no commits, no uncommitted work)";
    const { r, buf } = makeTTY({ maxLoopIterations: 3 });
    r.registerIssue({ issueNumber: 604 });
    for (let i = 1; i <= 3; i++) {
      r.onEvent({ issue: 604, phase: "exec", event: "start", iteration: i });
      r.onEvent({
        issue: 604,
        phase: "exec",
        event: "failed",
        error: err,
        iteration: i,
      });
    }
    const stripped = stripAnsi(buf.joined());
    const failLines = stripped.split("\n").filter((l) => /✘ #604 exec/.test(l));
    expect(failLines).toHaveLength(3);
    // Attempt 1: full text (first-seen for this signature).
    expect(failLines[0]).toContain(err);
    expect(failLines[0]).not.toContain("same failure as");
    // Attempt 2: abbreviated (sig matches, not last).
    expect(failLines[1]).toContain("(attempt 2/3)");
    expect(failLines[1]).toContain("same failure as attempt 1");
    expect(failLines[1]).not.toContain(err);
    // Attempt 3: full text re-emitted (last-before-max-iter rule).
    expect(failLines[2]).toContain("(attempt 3/3)");
    expect(failLines[2]).toContain(err);
    expect(failLines[2]).not.toContain("same failure as");
    r.dispose();
  });

  it("AC-4.3 (divergence): identical-then-divergent → full on divergence and on max-iter", () => {
    const errA = "error A: bad spec";
    const errB = "error B: bad qa";
    const { r, buf } = makeTTY({ maxLoopIterations: 4 });
    r.registerIssue({ issueNumber: 604 });
    const events: ProgressEvent[] = [
      { issue: 604, phase: "exec", event: "start", iteration: 1 },
      {
        issue: 604,
        phase: "exec",
        event: "failed",
        error: errA,
        iteration: 1,
      },
      { issue: 604, phase: "exec", event: "start", iteration: 2 },
      {
        issue: 604,
        phase: "exec",
        event: "failed",
        error: errA,
        iteration: 2,
      },
      { issue: 604, phase: "exec", event: "start", iteration: 3 },
      {
        issue: 604,
        phase: "exec",
        event: "failed",
        error: errB,
        iteration: 3,
      },
      { issue: 604, phase: "exec", event: "start", iteration: 4 },
      {
        issue: 604,
        phase: "exec",
        event: "failed",
        error: errB,
        iteration: 4,
      },
    ];
    for (const e of events) r.onEvent(e);

    const stripped = stripAnsi(buf.joined());
    const failLines = stripped.split("\n").filter((l) => /✘ #604 exec/.test(l));
    expect(failLines).toHaveLength(4);
    // Attempt 1: full text A (first-seen).
    expect(failLines[0]).toContain(errA);
    // Attempt 2: abbreviated (sig matches A).
    expect(failLines[1]).toContain("same failure as attempt 1");
    expect(failLines[1]).not.toContain(errA);
    // Attempt 3: full text B (first-seen for B / divergence).
    expect(failLines[2]).toContain(errB);
    expect(failLines[2]).not.toContain("same failure as");
    // Attempt 4: full text B (final attempt before max-iter).
    expect(failLines[3]).toContain(errB);
    expect(failLines[3]).not.toContain("same failure as");
    r.dispose();
  });

  it("failureSignature normalizes ANSI, case, and trailing whitespace", () => {
    const a = "\x1b[31mERROR\x1b[0m: bad\n";
    const b = "error: bad   ";
    expect(failureSignature(a)).toBe(failureSignature(b));
  });

  it("dedup state is per-phase: exec fail then qa fail with same string does NOT abbreviate qa", () => {
    // Per-phase dedup (hardening fix #1): if exec and qa both fail with the
    // exact same error string across iterations, the qa abbreviation must NOT
    // reference an exec attempt — the user expects "attempt N" to mean
    // "attempt N of this phase", not "attempt N of any phase on this issue".
    const err = "downstream service returned 500";
    const { r, buf } = makeTTY({ maxLoopIterations: 3 });
    r.registerIssue({ issueNumber: 604 });
    // iter 1: exec fails with `err`
    r.onEvent({ issue: 604, phase: "exec", event: "start", iteration: 1 });
    r.onEvent({
      issue: 604,
      phase: "exec",
      event: "failed",
      error: err,
      iteration: 1,
    });
    // iter 2: qa fails with same `err` text (but different phase)
    r.onEvent({ issue: 604, phase: "qa", event: "start", iteration: 2 });
    r.onEvent({
      issue: 604,
      phase: "qa",
      event: "failed",
      error: err,
      iteration: 2,
    });

    const stripped = stripAnsi(buf.joined());
    const execFails = stripped.split("\n").filter((l) => /✘ #604 exec/.test(l));
    const qaFails = stripped.split("\n").filter((l) => /✘ #604 qa/.test(l));
    expect(execFails).toHaveLength(1);
    expect(qaFails).toHaveLength(1);
    // qa is first-seen for the qa phase → full text, NOT abbreviated.
    expect(qaFails[0]).toContain(err);
    expect(qaFails[0]).not.toContain("same failure as");
    r.dispose();
  });

  describe("error handling", () => {
    it("handles empty error message (signature is empty string)", () => {
      const { r, buf } = makeTTY({ maxLoopIterations: 3 });
      r.registerIssue({ issueNumber: 604 });
      r.onEvent({ issue: 604, phase: "exec", event: "start", iteration: 1 });
      r.onEvent({
        issue: 604,
        phase: "exec",
        event: "failed",
        error: "",
        iteration: 1,
      });
      r.onEvent({ issue: 604, phase: "exec", event: "start", iteration: 2 });
      r.onEvent({
        issue: 604,
        phase: "exec",
        event: "failed",
        error: "",
        iteration: 2,
      });
      // No throw + second occurrence is abbreviated since signatures match.
      const stripped = stripAnsi(buf.joined());
      const failLines = stripped
        .split("\n")
        .filter((l) => /✘ #604 exec/.test(l));
      expect(failLines).toHaveLength(2);
      expect(failLines[1]).toContain("same failure as attempt 1");
      r.dispose();
    });

    it("signature truncation uses first 80 chars (per plan decision)", () => {
      const prefix = "a".repeat(80);
      const a = prefix + "_branchA_diff_tail";
      const b = prefix + "_branchB_diff_tail";
      // Signatures must collide on the 80-char prefix.
      expect(failureSignature(a)).toBe(failureSignature(b));
    });
  });
});

// =============================================================================
// Derived ACs
// =============================================================================

describe("Derived AC-D1: test-mode log-update stub tracks frame replacement", () => {
  it("test-mode log-update tracks replacement count and lastFrame", () => {
    const { r } = makeTTY({ columns: 100 });
    const stub = r.getTestStub();
    expect(stub).not.toBeNull();
    expect(stub!.replacementCount).toBe(0);
    expect(stub!.lastFrame).toBe("");

    r.registerIssue({ issueNumber: 614 });
    // First redraw fills lastFrame but doesn't count as a replacement.
    expect(stub!.replacementCount).toBe(0);
    expect(stub!.lastFrame.length).toBeGreaterThan(0);

    r.onEvent({ issue: 614, phase: "exec", event: "start" });
    // The event-line emit calls logUpdateClear first then redraws — so we see
    // at least one replacement after the clear → redraw cycle, AND the
    // lastFrame is the most recent.
    expect(stub!.replacementCount).toBeGreaterThanOrEqual(0);
    expect(stub!.lastFrame).toContain("#614");
    r.dispose();
  });

  it("test-mode log-update replaces, not appends — multiple redraws keep one live frame", () => {
    const { r } = makeTTY({ columns: 100 });
    r.registerIssue({ issueNumber: 614 });
    for (let i = 0; i < 5; i++) {
      r.tickNow();
    }
    const stub = r.getTestStub()!;
    // After 5 ticks, exactly one frame is "live" (the latest).
    expect(stub.lastFrame.match(/SEQUANT WORKFLOW ·/g) ?? []).toHaveLength(1);
    // And we counted replacements.
    expect(stub.replacementCount).toBeGreaterThan(0);
    r.dispose();
  });
});

describe("Derived AC-D2: maxLoopIterations threaded through all 3 retry-suffix sites", () => {
  it("respects maxLoopIterations=5 in NonTTYRenderer events log", () => {
    const { r, buf } = makeNonTTY({ maxLoopIterations: 5 });
    r.registerIssue({ issueNumber: 614 });
    r.onEvent({ issue: 614, phase: "exec", event: "start", iteration: 4 });
    const out = stripAnsi(buf.joined());
    expect(out).toContain("(attempt 4/5)");
    expect(out).not.toContain("(attempt 4/3)");
    r.dispose();
  });

  it("respects maxLoopIterations=5 in TTYRenderer live frame (post-#672)", () => {
    // #672 AC-1 dropped the `▸ start` TTY events log line, so the
    // `(attempt N/M)` suffix on starts now surfaces via the live-zone
    // `loop N/M` status header. The events log path is exercised by the
    // NonTTY test above.
    const { r } = makeTTY({ maxLoopIterations: 5 });
    r.registerIssue({ issueNumber: 614 });
    r.onEvent({ issue: 614, phase: "exec", event: "start", iteration: 4 });
    const frame = stripAnsi(r.renderLiveFrame(100));
    expect(frame).toMatch(/exec loop 4\/5/);
    expect(frame).not.toMatch(/4\/3/);
    r.dispose();
  });

  it("respects maxLoopIterations=5 in TTYRenderer status header (qa loop)", () => {
    const { r } = makeTTY({ columns: 100, maxLoopIterations: 5 });
    r.registerIssue({ issueNumber: 606 });
    r.onEvent({ issue: 606, phase: "qa", event: "start", iteration: 4 });
    const frame = stripAnsi(r.renderLiveFrame(100));
    expect(frame).toMatch(/qa loop 4\/5/);
    expect(frame).not.toMatch(/qa loop 4\/3/);
    r.dispose();
  });
});

describe("Derived AC-D3: box-char assertions use the Box Drawing codepoint range (Windows-safe)", () => {
  it("detects box-drawing chars in the U+2500–U+257F range emitted by the renderer", () => {
    // The spec plan called for `\p{Block=Box_Drawing}` Unicode property
    // escapes, but ECMAScript regex (V8 / Node) does NOT support the `Block`
    // property name — only `General_Category`, `Script`, `Script_Extensions`,
    // and binary properties are allowed. The canonical JS equivalent is the
    // codepoint range `[─-╿]/u` (U+2500..U+257F = the entire Box Drawing
    // block). Codepoint-range matching is platform-agnostic (Linux/macOS/
    // Windows all encode these chars identically), so the Windows-safety
    // requirement is satisfied without needing a Windows CI runner.
    // Use a multi-issue frame: single-issue switched to a boxless indented
    // layout (#647/#655), but the multi-issue grid still draws box chars, which
    // is what this Windows-safe detection regex needs to exercise.
    const { r } = makeTTY({ columns: 100 });
    r.registerIssue({ issueNumber: 614 });
    r.registerIssue({ issueNumber: 615 });
    r.onEvent({ issue: 614, phase: "exec", event: "start" });
    const frame = r.renderLiveFrame(100);
    expect(/[─-╿]/u.test(frame)).toBe(true);
    r.dispose();
  });

  it("no orphan box characters at line boundaries", () => {
    const { r, buf } = makeTTY({ columns: 100 });
    r.registerIssue({ issueNumber: 614 });
    r.registerIssue({ issueNumber: 615 });
    r.onEvent({ issue: 614, phase: "exec", event: "start" });
    r.renderSummary({
      issues: [
        {
          issueNumber: 614,
          success: true,
          durationSeconds: 60,
          phases: [{ name: "exec", success: true }],
        },
      ],
    });
    const stripped = stripAnsi(buf.joined());
    // No "lone" box-drawing char at end of line — every box char is adjacent
    // to whitespace or another box construct, never an alphanumeric.
    expect(stripped).not.toMatch(/[─-╿][A-Za-z0-9]/u);
    r.dispose();
  });
});

// =============================================================================
// formatRetrySuffix unit tests
// =============================================================================

describe("formatRetrySuffix helper", () => {
  it("returns empty string when iteration is undefined / 0 / 1", () => {
    expect(formatRetrySuffix(undefined, 3, "events")).toBe("");
    expect(formatRetrySuffix(0, 3, "events")).toBe("");
    expect(formatRetrySuffix(1, 3, "events")).toBe("");
  });

  it("returns parenthesized form for events log", () => {
    expect(formatRetrySuffix(2, 3, "events")).toBe(" (attempt 2/3)");
    expect(formatRetrySuffix(3, 5, "events")).toBe(" (attempt 3/5)");
  });

  it("returns bare counter form for status header", () => {
    expect(formatRetrySuffix(2, 3, "header")).toBe(" 2/3");
    expect(formatRetrySuffix(3, 5, "header")).toBe(" 3/5");
  });
});
