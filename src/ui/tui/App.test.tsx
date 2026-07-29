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
  // startedAt={state.startedAt} />` (dropping the completedAt prop) makes ONLY
  // this test fail — App's live `now` then drives the header past 01:30.
  it("freezes a passed issue's header while App's 1 Hz clock keeps ticking", async () => {
    vi.useFakeTimers();
    try {
      const started = new Date(1_000_000);
      const completed = new Date(started.getTime() + 90_000); // 01:30
      const passed: IssueRuntimeState = {
        number: 850,
        title: "Completed issue",
        branch: "feature/850",
        status: "passed",
        startedAt: started,
        completedAt: completed,
        phases: [{ name: "qa", status: "done" }],
      };
      const { lastFrame, unmount } = render(
        <App getSnapshot={() => snapshot([passed])} />,
      );
      expect(lastFrame() ?? "").toContain("01:30");

      // MUST be the async form (AC-7): `vi.advanceTimersByTime` fires App's
      // 1 Hz `now` interval but does NOT flush ink's render, so the frame is
      // byte-identical afterward and this assertion would pass even against the
      // unfixed code. Only `advanceTimersByTimeAsync` flushes the frame, making
      // the freeze assertion real.
      await vi.advanceTimersByTimeAsync(5000);
      expect(lastFrame() ?? "").toContain("01:30");
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
