import { describe, it, expect } from "vitest";
import { composeTeardownSummary } from "./teardown.js";
import type {
  RunSnapshot,
  IssueRuntimeState,
  IssueStatus,
} from "../../lib/workflow/run-state.js";

function snapshot(issues: IssueRuntimeState[]): RunSnapshot {
  return {
    config: { concurrency: 1, baseBranch: "main", qualityLoop: true },
    issues,
    done: true,
    capturedAt: new Date(0),
  };
}

function issue(
  number: number,
  status: IssueStatus,
  title = `Issue ${number}`,
): IssueRuntimeState {
  return { number, title, branch: `feature/${number}`, status, phases: [] };
}

describe("composeTeardownSummary (#699 AC-5)", () => {
  it("emits a ✔ line for a passed issue", () => {
    const out = composeTeardownSummary(snapshot([issue(699, "passed", "TUI")]));
    expect(out).toBe("✔ #699 TUI");
  });

  it("emits a ✘ line for a failed issue", () => {
    const out = composeTeardownSummary(snapshot([issue(700, "failed")]));
    expect(out).toContain("✘ #700");
  });

  it("renders one line per issue across a batch", () => {
    const out = composeTeardownSummary(
      snapshot([issue(1, "passed"), issue(2, "failed"), issue(3, "passed")]),
    );
    expect(out.split("\n")).toHaveLength(3);
    expect(out).toContain("✔ #1");
    expect(out).toContain("✘ #2");
    expect(out).toContain("✔ #3");
  });

  it("returns an empty string when there are no issues", () => {
    expect(composeTeardownSummary(snapshot([]))).toBe("");
  });

  it("treats non-failed terminal states as ✔", () => {
    // queued/running shouldn't normally reach teardown, but only `failed` → ✘.
    expect(composeTeardownSummary(snapshot([issue(5, "running")]))).toContain(
      "✔ #5",
    );
  });
});
