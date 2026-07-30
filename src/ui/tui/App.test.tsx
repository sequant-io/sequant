import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "./App.js";
import type {
  RunSnapshot,
  IssueRuntimeState,
  IssueStatus,
} from "../../lib/workflow/run-state.js";

function issue(number: number, status: IssueStatus): IssueRuntimeState {
  return {
    number,
    title: `Issue ${number}`,
    branch: `feature/${number}`,
    status,
    phases: [{ name: "qa", status: status === "running" ? "running" : "done" }],
    completedAt: status === "passed" ? new Date(number * 1000) : undefined,
  };
}

function snapshot(issues: IssueRuntimeState[]): RunSnapshot {
  return {
    config: { concurrency: 1, baseBranch: "main", qualityLoop: true },
    issues,
    done: false,
    capturedAt: new Date(0),
  };
}

describe("App row cap (#699 AC-4)", () => {
  it("renders a single box for the ready single-issue case", () => {
    const snap = snapshot([issue(699, "running")]);
    const { lastFrame, unmount } = render(<App getSnapshot={() => snap} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("#699");
    expect(frame).not.toContain("done"); // no rollup line for one issue
    unmount();
  });

  it("rolls older done issues into a `✔ N done` line when over the static cap", () => {
    // 15 issues all completed → static cap 10 → 9 boxes + rollup of 6
    // (1 slot reserved for the rollup line).
    const issues = Array.from({ length: 15 }, (_, i) =>
      issue(100 + i, "passed"),
    );
    const { lastFrame, unmount } = render(
      <App getSnapshot={() => snapshot(issues)} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/✔ \d+ done/);
    // Not every issue gets a box.
    const boxedCount = issues.filter((i) =>
      frame.includes(`#${i.number}`),
    ).length;
    expect(boxedCount).toBeLessThan(issues.length);
    unmount();
  });
});

describe("App completed-issue header freeze (#866)", () => {
  // Mutation-verified (AC-8): reverting IssueBox to `<ElapsedTimer
  // startedAt={state.startedAt} now={now} />` (dropping the completedAt prop)
  // makes ONLY this test fail — App's live `now` then drives the header to
  // 01:35 at the post-advance assertion.
  it("freezes a passed issue's header while App's 1 Hz clock keeps ticking", async () => {
    vi.useFakeTimers();
    try {
      // Anchored to the fake clock on purpose. With an absolute epoch
      // `startedAt` (e.g. `new Date(1_000_000)`), unfixed code renders a
      // ~29,756,227-minute header and the FIRST assertion below fails — the
      // mutant dies before the timer ever advances, leaving the async-flush
      // property in the AC-7 comment unexercised. A clock-relative span makes
      // the pre-advance frame correct either way, so the only assertion that
      // can fail is the post-advance freeze one.
      const completed = new Date(Date.now());
      const started = new Date(completed.getTime() - 90_000); // 01:30 span
      const passed: IssueRuntimeState = {
        number: 850,
        title: "Completed issue",
        branch: "feature/850",
        status: "passed",
        startedAt: started,
        completedAt: completed,
        phases: [{ name: "qa", status: "done" }],
      };
      // Built ONCE, outside the getSnapshot closure. Re-deriving the span from
      // `Date.now()` on every 10 Hz poll would re-anchor it to the advancing
      // fake clock and hold the header at 01:30 no matter what the component
      // does — the assertions would pass against unfixed code.
      const snap = snapshot([passed]);
      const { lastFrame, unmount } = render(<App getSnapshot={() => snap} />);
      expect(lastFrame() ?? "").toContain("01:30");

      // MUST be the async form (AC-7): `vi.advanceTimersByTime` fires App's
      // 1 Hz `now` interval but does NOT flush ink's render, so the frame is
      // byte-identical afterward and the assertion below would pass even
      // against the unfixed code. Only `advanceTimersByTimeAsync` flushes the
      // frame, making the freeze assertion real.
      await vi.advanceTimersByTimeAsync(5000);
      expect(lastFrame() ?? "").toContain("01:30");
      expect(lastFrame() ?? "").not.toContain("01:35"); // unfixed value
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  // Mutation-verified: dropping the `isTerminalStatus(state.status)` gate in
  // IssueBox (passing `state.completedAt` unconditionally) makes ONLY this test
  // fail — the header then freezes at 00:30 and never advances.
  it("keeps a running issue's header advancing when a stale completedAt survives", async () => {
    vi.useFakeTimers();
    try {
      // `status: "running"` alongside a populated `completedAt` is exactly what
      // the #766 quality-loop recovery window published before the orchestrator
      // learned to clear it: a non-loop failure stamped `completedAt`, then
      // iteration 2 flipped the issue back to `running`. This gates the
      // IssueBox status check independently of that orchestrator fix.
      const now = Date.now();
      const running: IssueRuntimeState = {
        number: 850,
        title: "Recovering issue",
        branch: "feature/850",
        status: "running",
        startedAt: new Date(now - 90_000), // 01:30 of real work so far
        completedAt: new Date(now - 60_000), // stale: 00:30 at the failure
        phases: [{ name: "qa", status: "running" }],
      };
      const snap = snapshot([running]);
      const { lastFrame, unmount } = render(<App getSnapshot={() => snap} />);
      expect(lastFrame() ?? "").toContain("01:30");
      expect(lastFrame() ?? "").not.toContain("00:30"); // frozen-at-failure value

      await vi.advanceTimersByTimeAsync(5000);
      expect(lastFrame() ?? "").toContain("01:35");
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
