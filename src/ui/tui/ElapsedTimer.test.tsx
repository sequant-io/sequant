import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ElapsedTimer } from "./ElapsedTimer.js";
import { TTYRenderer } from "../../lib/cli-ui/run-renderer.js";

/** Seconds encoded by the TUI's own `MM:SS` header. */
function tuiSeconds(frame: string | undefined): number {
  const m = /^(\d+):(\d\d)$/.exec((frame ?? "").trim());
  if (!m) throw new Error(`not a MM:SS frame: ${JSON.stringify(frame)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Seconds encoded by the plain renderer's `24m 7s` / `45s` / `1h 2m` form. */
function plainSeconds(text: string): number {
  const m = /^(?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s)?$/.exec(text.trim());
  if (!m || m[0] === "")
    throw new Error(`not an elapsed-time string: ${JSON.stringify(text)}`);
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/**
 * Ink render tests need more than the `unit` project's 5s default — see the
 * longer note in `App.test.tsx` (#880). File scope for the same reason: the
 * flush test is the worst case, not the only exposed one.
 */
vi.setConfig({ testTimeout: 30_000 });

describe("ElapsedTimer", () => {
  it("renders --:-- when startedAt is missing (AC-5)", () => {
    const { lastFrame } = render(<ElapsedTimer now={Date.now()} />);
    expect(lastFrame()).toBe("--:--");
  });

  it("advances a running issue against the passed-in now (AC-5)", () => {
    const started = new Date(1_000_000);
    const { lastFrame, rerender } = render(
      <ElapsedTimer startedAt={started} now={started.getTime() + 5_000} />,
    );
    expect(lastFrame()).toBe("00:05");
    // A later `now` (App's next 1 Hz tick) advances the running timer.
    rerender(
      <ElapsedTimer startedAt={started} now={started.getTime() + 6_000} />,
    );
    expect(lastFrame()).toBe("00:06");
  });

  it("freezes at completedAt - startedAt, ignoring a later now (AC-1)", () => {
    const started = new Date(1_000_000);
    const completed = new Date(started.getTime() + 90_000); // 01:30
    const { lastFrame, rerender } = render(
      <ElapsedTimer
        startedAt={started}
        completedAt={completed}
        now={completed.getTime() + 60_000}
      />,
    );
    expect(lastFrame()).toBe("01:30");
    // now advancing further does not move a completed timer.
    rerender(
      <ElapsedTimer
        startedAt={started}
        completedAt={completed}
        now={completed.getTime() + 600_000}
      />,
    );
    expect(lastFrame()).toBe("01:30");
  });

  it("freezes in render on a running → passed transition without remount (AC-3)", () => {
    const started = new Date(1_000_000);
    // Same mounted component (identical position/type across rerenders, so
    // React never remounts): running first, then completedAt appears.
    const { lastFrame, rerender } = render(
      <ElapsedTimer startedAt={started} now={started.getTime() + 25_000} />,
    );
    expect(lastFrame()).toBe("00:25");
    const completed = new Date(started.getTime() + 30_000); // froze at 00:30
    rerender(
      <ElapsedTimer
        startedAt={started}
        completedAt={completed}
        now={started.getTime() + 45_000}
      />,
    );
    // Frozen at the transition (00:30), not the live 00:45.
    expect(lastFrame()).toBe("00:30");
  });

  it("owns no interval — the frame only moves when a parent re-renders (AC-4)", async () => {
    vi.useFakeTimers();
    try {
      const started = new Date(Date.now() - 5_000);
      const { lastFrame, unmount } = render(
        <ElapsedTimer startedAt={started} now={Date.now()} />,
      );
      expect(lastFrame()).toBe("00:05");
      // Nothing else is rendering here — no App, no snapshot poller. The
      // pre-#866 implementation owned a 1 Hz interval and would repaint 00:10.
      // Reading `now` from props means only a parent re-render can move it.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(lastFrame()).toBe("00:05");
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("freezes at the same duration the plain renderer freezes at (AC-6)", () => {
    // Parity is read off the plain renderer rather than hardcoded: drive a real
    // TTYRenderer through the same span on a controlled clock and compare the
    // duration it froze at with the one ElapsedTimer froze at. A hardcoded
    // "24:07" would stay green if the plain renderer changed which span it
    // freezes — the only thing AC-6 is about. The renderers format differently
    // on purpose (`24m 7s` vs `24:07`), so this compares seconds, not strings.
    const T0 = 1_000_000;
    const SPAN_MS = 1_447_000; // 24m 7s / 24:07
    const AFTER_MS = 62_000; // both clocks run on past completion
    let clock = T0;
    const written: string[] = [];

    const plain = new TTYRenderer({
      stdoutWrite: (s) => void written.push(s),
      noColor: true,
      isTTY: true,
      columns: 100,
      liveTickMs: 0,
      noSignalListeners: true,
      now: () => clock,
      wallClock: () => new Date(clock),
    });
    plain.registerIssue({ issueNumber: 850 });
    plain.setPhasePlan(850, ["qa"]);
    plain.onEvent({ issue: 850, phase: "qa", event: "start" });
    clock = T0 + SPAN_MS;
    plain.onEvent({ issue: 850, phase: "qa", event: "complete" });
    clock = T0 + SPAN_MS + AFTER_MS;
    plain.tickNow(); // repaint at the later clock; a done issue must not move
    plain.dispose();

    // The LAST repaint, not the first. `written` accumulates every frame, and
    // the frame emitted at completion is written when the renderer's clock still
    // equals `completedAt` — there a frozen duration and a live one agree, so
    // reading it would let a non-freezing plain renderer pass. Only the
    // post-completion `tickNow()` frame distinguishes them.
    const plainDurations = [
      ...written.join("").matchAll(/done · ([^·\n]+) ·/g),
    ].map((m) => m[1]);
    expect(plainDurations.length).toBeGreaterThan(0);
    const plainDuration = plainDurations[plainDurations.length - 1];

    const { lastFrame } = render(
      <ElapsedTimer
        startedAt={new Date(T0)}
        completedAt={new Date(T0 + SPAN_MS)}
        now={clock}
      />,
    );

    // Three-way: both renderers agree with each other AND with the true span,
    // so the test can't pass by both being wrong in the same direction.
    expect(tuiSeconds(lastFrame())).toBe(plainSeconds(plainDuration));
    expect(tuiSeconds(lastFrame())).toBe(SPAN_MS / 1000);
  });
});
