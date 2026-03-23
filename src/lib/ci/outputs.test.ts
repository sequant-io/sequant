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
    const outputs = formatMultiOutputs(results);
    expect(outputs.issue).toBe("1 2");
    expect(outputs.duration).toBe("300");
    expect(outputs.success).toBe("true");
  });

  it("reports failure if any issue failed", () => {
    const results = [
      makeResult({ issueNumber: 1 }),
      makeResult({ issueNumber: 2, success: false }),
    ];
    const outputs = formatMultiOutputs(results);
    expect(outputs.success).toBe("false");
  });

  it("combines PR URLs", () => {
    const results = [
      makeResult({ issueNumber: 1, prUrl: "https://github.com/pr/1" }),
      makeResult({ issueNumber: 2, prUrl: "https://github.com/pr/2" }),
    ];
    const outputs = formatMultiOutputs(results);
    expect(outputs["pr-url"]).toBe(
      "https://github.com/pr/1,https://github.com/pr/2",
    );
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
    const summary = formatSummary([makeResult()]);
    expect(summary).toContain("## Sequant Workflow Results");
    expect(summary).toContain("Issue #42");
    expect(summary).toContain("spec");
    expect(summary).toContain("exec");
    expect(summary).toContain("qa");
    expect(summary).toContain("480s");
  });

  it("shows PR URL when present", () => {
    const summary = formatSummary([
      makeResult({ prUrl: "https://github.com/pr/1" }),
    ]);
    expect(summary).toContain("https://github.com/pr/1");
  });

  it("shows abort reason when present", () => {
    const summary = formatSummary([
      makeResult({ abortReason: "Phase timeout" }),
    ]);
    expect(summary).toContain("Phase timeout");
  });

  it("handles multiple results", () => {
    const summary = formatSummary([
      makeResult({ issueNumber: 1, durationSeconds: 100 }),
      makeResult({ issueNumber: 2, durationSeconds: 200 }),
    ]);
    expect(summary).toContain("Issue #1");
    expect(summary).toContain("Issue #2");
    expect(summary).toContain("300s");
  });
});
