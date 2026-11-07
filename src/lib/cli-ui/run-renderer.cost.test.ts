import { describe, it, expect } from "vitest";
import { renderRunSummary } from "./run-renderer.js";
import type { IssueSummary } from "./run-renderer-types.js";

// #1527: the summary states the run's cost from the figure it is handed.

const issue: IssueSummary = {
  issueNumber: 7,
  success: true,
  durationSeconds: 5,
  phases: [{ name: "exec", success: true }],
};

function render(
  cost?: { usd?: number; tokens?: number },
  dryRun?: boolean,
): string {
  let out = "";
  renderRunSummary(
    { issues: [issue], totalDurationSeconds: 5, cost, dryRun },
    { stdoutWrite: (s) => (out += s), noColor: true, columns: 120 },
  );
  return out;
}

describe("summary cost line (#1527)", () => {
  it("prints dollars and tokens when the run has both", () => {
    const out = render({ usd: 6.45, tokens: 69641 });
    expect(out).toContain("cost $6.45 (SDK estimate) · 69,641 tokens");
    expect(out).toContain("SDK estimate, not a billing statement");
  });

  it("prints cost unrecorded when the run has no record", () => {
    const out = render(undefined);
    expect(out).toContain("cost unrecorded");
    expect(out).not.toContain("$0.00");
    // No figure, so nothing for the caveat to qualify.
    expect(out).not.toContain("SDK estimate");
  });

  it("prints tokens and cost unrecorded when only tokens exist", () => {
    const out = render({ tokens: 1200 });
    expect(out).toContain("1,200 tokens · cost unrecorded");
  });

  it("prints no cost line for a dry run", () => {
    expect(render({ usd: 1, tokens: 5 }, true)).not.toContain("cost");
  });
});
