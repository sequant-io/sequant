import { describe, it, expect } from "vitest";
import {
  formatMultiOutputs,
  formatOutputs,
  formatSummary,
  outputCommands,
} from "./outputs.js";
import type { IssueResult } from "../workflow/types.js";

const makeResult = (overrides: Partial<IssueResult> = {}): IssueResult => ({
  issueNumber: 42,
  success: true,
  phaseResults: [
    { phase: "spec", success: true, durationSeconds: 60 },
    { phase: "exec", success: true, durationSeconds: 300 },
    { phase: "qa", success: true, durationSeconds: 120 },
  ],
  durationSeconds: 480,
  ...overrides,
});

describe("formatOutputs", () => {
  it("formats a successful result", () => {
    const outputs = formatOutputs(makeResult());
    expect(outputs.issue).toBe("42");
    expect(outputs.success).toBe("true");
    expect(outputs.duration).toBe("480");
    expect(outputs["pr-url"]).toBe("");
  });

  it("includes PR URL when present", () => {
    const outputs = formatOutputs(
      makeResult({ prUrl: "https://github.com/org/repo/pull/1" }),
    );
    expect(outputs["pr-url"]).toBe("https://github.com/org/repo/pull/1");
  });

  it("formats phases as JSON", () => {
    const outputs = formatOutputs(makeResult());
    const phases = JSON.parse(outputs.phases);
    expect(phases).toHaveLength(3);
    expect(phases[0]).toEqual({ phase: "spec", success: true, duration: 60 });
  });

  it("handles failed result", () => {
    const outputs = formatOutputs(makeResult({ success: false }));
    expect(outputs.success).toBe("false");
  });
});

describe("formatMultiOutputs", () => {
  it("combines multiple issue results", () => {
    const results = [
      makeResult({ issueNumber: 1, durationSeconds: 100 }),
      makeResult({ issueNumber: 2, durationSeconds: 200 }),
    ];
    // Serial run: wall clock ≈ the per-issue sum, so the reported figure is
    // unchanged from the pre-#867 behaviour.
    const outputs = formatMultiOutputs(results, 300);
    expect(outputs.issue).toBe("1 2");
    expect(outputs.duration).toBe("300");
    expect(outputs.success).toBe("true");
  });

  it("reports failure if any issue failed", () => {
    const results = [
      makeResult({ issueNumber: 1 }),
      makeResult({ issueNumber: 2, success: false }),
    ];
    const outputs = formatMultiOutputs(results, 960);
    expect(outputs.success).toBe("false");
  });

  it("combines PR URLs", () => {
    const results = [
      makeResult({ issueNumber: 1, prUrl: "https://github.com/pr/1" }),
      makeResult({ issueNumber: 2, prUrl: "https://github.com/pr/2" }),
    ];
    const outputs = formatMultiOutputs(results, 960);
    expect(outputs["pr-url"]).toBe(
      "https://github.com/pr/1,https://github.com/pr/2",
    );
  });

  // #867 sibling site. `formatMultiOutputs` fed the GitHub Actions `duration`
  // output from `results.reduce((sum, r) => sum + r.durationSeconds)` — the
  // identical defect the SUMMARY header had, in a different consumer. The
  // fixture's sum exceeds wall clock by 3×, so a summing implementation cannot
  // satisfy this assertion.
  it("reports run wall clock, not the sum of overlapping per-issue durations", () => {
    const WALL_CLOCK = 1200;
    const PER_ISSUE_SUM = 6 * 600;
    expect(PER_ISSUE_SUM).toBeGreaterThan(2 * WALL_CLOCK); // fixture guard

    const results = Array.from({ length: 6 }, (_, i) =>
      makeResult({ issueNumber: 900 + i, durationSeconds: 600 }),
    );
    const outputs = formatMultiOutputs(results, WALL_CLOCK);

    expect(outputs.duration).toBe(String(WALL_CLOCK));
    expect(outputs.duration).not.toBe(String(PER_ISSUE_SUM));
  });
});

describe("outputCommands", () => {
  it("generates GITHUB_OUTPUT echo commands", () => {
    const cmds = outputCommands({
      issue: "42",
      success: "true",
      phases: "[]",
      "pr-url": "",
      duration: "100",
    });
    expect(cmds).toHaveLength(5);
    expect(cmds[0]).toContain('echo "issue=42"');
    expect(cmds[0]).toContain("$GITHUB_OUTPUT");
  });
});

describe("formatSummary", () => {
  it("generates Markdown summary", () => {
    const summary = formatSummary([makeResult()], 480);
    expect(summary).toContain("## Sequant Workflow Results");
    expect(summary).toContain("Issue #42");
    expect(summary).toContain("spec");
    expect(summary).toContain("exec");
    expect(summary).toContain("qa");
    expect(summary).toContain("480s");
  });

  it("shows PR URL when present", () => {
    const summary = formatSummary(
      [makeResult({ prUrl: "https://github.com/pr/1" })],
      480,
    );
    expect(summary).toContain("https://github.com/pr/1");
  });

  it("shows abort reason when present", () => {
    const summary = formatSummary(
      [makeResult({ abortReason: "Phase timeout" })],
      480,
    );
    expect(summary).toContain("Phase timeout");
  });

  it("handles multiple results", () => {
    // Serial run: wall clock ≈ the per-issue sum, unchanged from pre-#867.
    const summary = formatSummary(
      [
        makeResult({ issueNumber: 1, durationSeconds: 100 }),
        makeResult({ issueNumber: 2, durationSeconds: 200 }),
      ],
      300,
    );
    expect(summary).toContain("Issue #1");
    expect(summary).toContain("Issue #2");
    expect(summary).toContain("300s");
  });

  // #867 sibling site — the step summary's "Total duration" line carried the
  // same `reduce` sum as the `duration` output above. Per-phase durations in
  // the tables stay per-phase; only the run-level roll-up was wrong.
  it("reports run wall clock in Total duration, not the per-issue sum", () => {
    const WALL_CLOCK = 1200;
    const PER_ISSUE_SUM = 6 * 600;
    expect(PER_ISSUE_SUM).toBeGreaterThan(2 * WALL_CLOCK); // fixture guard

    const summary = formatSummary(
      Array.from({ length: 6 }, (_, i) =>
        makeResult({
          issueNumber: 900 + i,
          durationSeconds: 600,
          phaseResults: [
            { phase: "exec", success: true, durationSeconds: 600 },
          ],
        }),
      ),
      WALL_CLOCK,
    );

    expect(summary).toContain(`**Total duration:** ${WALL_CLOCK}s`);
    expect(summary).not.toContain(`**Total duration:** ${PER_ISSUE_SUM}s`);
  });
});
