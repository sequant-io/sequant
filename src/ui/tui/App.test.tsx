import { describe, it, expect } from "vitest";
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
