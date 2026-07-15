/**
 * Tests for the post-run summary display.
 *
 * Focused on the #760 checkpoint-failure notice: the per-issue warning fires
 * mid-run and has long scrolled past by the time a multi-hour chain finishes,
 * so the summary restates it. These lock the fact that `checkpointFailed` is
 * actually *consumed* — it was set on IssueResult and read by nobody.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { displaySummary } from "./run-display.js";
import type { RunResult } from "../lib/workflow/run-orchestrator.js";
import type { IssueResult } from "../lib/workflow/types.js";

function issueResult(overrides: Partial<IssueResult> = {}): IssueResult {
  return {
    issueNumber: 1,
    success: true,
    phaseResults: [],
    durationSeconds: 1,
    loopTriggered: false,
    ...overrides,
  };
}

function runResult(results: IssueResult[]): RunResult {
  return {
    results,
    logPath: null,
    exitCode: 0,
    worktreeMap: new Map(),
    issueInfoMap: new Map(),
    config: { dryRun: false, phases: [], qualityLoop: false },
    mergedOptions: {},
    logWriter: null,
  } as unknown as RunResult;
}

/** Capture everything displaySummary prints. */
function capture(result: RunResult): string {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    displaySummary(result);
    return spy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
  } finally {
    spy.mockRestore();
  }
}

describe("displaySummary — checkpoint failure notice (#760)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("restates a checkpoint failure at the summary, naming the issue", () => {
    const output = capture(
      runResult([issueResult({ issueNumber: 42, checkpointFailed: true })]),
    );

    expect(output).toContain("Checkpoint commit failed");
    expect(output).toContain("#42");
    // The actionable half: what a resume will do about it.
    expect(output).toContain("--force");
  });

  it("names every issue whose checkpoint failed", () => {
    const output = capture(
      runResult([
        issueResult({ issueNumber: 7, checkpointFailed: true }),
        issueResult({ issueNumber: 8 }),
        issueResult({ issueNumber: 9, checkpointFailed: true }),
      ]),
    );

    expect(output).toContain("#7");
    expect(output).toContain("#9");
    expect(output).toMatch(/Checkpoint commit failed for #7, #9/);
  });

  it("stays silent when no checkpoint failed (the normal path)", () => {
    const output = capture(
      runResult([
        issueResult({ issueNumber: 1 }),
        issueResult({ issueNumber: 2 }),
      ]),
    );

    expect(output).not.toContain("Checkpoint commit failed");
  });
});
