import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { ElapsedTimer } from "./ElapsedTimer.js";

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

  it("matches the plain renderer's duration in MM:SS form (AC-6)", () => {
    // The plain renderer freezes a done issue at (completedAt - startedAt) too
    // (run-renderer.ts statusHeader). The renderers format differently on
    // purpose (`24m 7s` vs `24:07`), so this is a duration match: 1447s here.
    const started = new Date(1_000_000);
    const completed = new Date(started.getTime() + 1_447_000); // 24:07
    const { lastFrame } = render(
      <ElapsedTimer
        startedAt={started}
        completedAt={completed}
        now={completed.getTime() + 62_000}
      />,
    );
    expect(lastFrame()).toBe("24:07");
  });
});
