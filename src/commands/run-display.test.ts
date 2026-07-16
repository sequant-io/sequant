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
import type { IssueResult, PhaseResult } from "../lib/workflow/types.js";
import type {
  RunRenderer,
  SummaryRenderInput,
} from "../lib/cli-ui/run-renderer-types.js";

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

/**
 * Capture the `IssueSummary[]` displaySummary hands the renderer, so the
 * `IssueResult` → `IssueSummary` mapping can be asserted directly rather than
 * through ANSI-coloured grid output.
 */
function captureSummaryInput(result: RunResult): SummaryRenderInput {
  let captured: SummaryRenderInput | undefined;
  const renderer = {
    renderSummary: (input: SummaryRenderInput) => {
      captured = input;
    },
  } as unknown as RunRenderer;
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    displaySummary(result, renderer);
  } finally {
    spy.mockRestore();
  }
  if (!captured) throw new Error("renderSummary was never called");
  return captured;
}

function phase(overrides: Partial<PhaseResult>): PhaseResult {
  return { phase: "qa", success: true, ...overrides } as PhaseResult;
}

/**
 * #766 — the summary detail cell is fed by `toIssueSummary`, NOT by the
 * renderer's own last-wins `failureReason` (`run-renderer.ts:288`, which drives
 * the live card). It used `.find()` over `phaseResults` — which accumulates
 * every attempt across every quality-loop iteration — so it rendered the FIRST
 * failure and pinned a stale reason. This is the loose end recorded in #766's
 * Notes: #762's cell read `Timeout after 1800s` when its last failure was an
 * API drop.
 */
describe("displaySummary — failure reason is the last attempt (#766)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the last failing attempt's reason, not the first (#762's cell)", () => {
    // #762's real shape: qa timed out twice, then died on an API drop.
    const input = captureSummaryInput(
      runResult([
        issueResult({
          issueNumber: 762,
          success: false,
          phaseResults: [
            phase({ phase: "exec", success: true }),
            phase({ success: false, error: "Timeout after 1800s" }),
            phase({ phase: "loop", success: true }),
            phase({ phase: "exec", success: true }),
            phase({ success: false, error: "Timeout after 1800s" }),
            phase({ phase: "loop", success: true }),
            phase({ phase: "exec", success: true }),
            phase({
              success: false,
              error: "API Error: Connection closed mid-response",
            }),
          ],
        }),
      ]),
    );

    expect(input.issues[0].failureReason).toBe(
      "API Error: Connection closed mid-response",
    );
  });

  it("ignores a trailing loop failure so the reason names the phase that failed", () => {
    // A failed `loop` is auxiliary recovery — reporting "loop crashed" would
    // bury the qa failure it was trying to fix. Mirrors `pipelineHasFailed`.
    const input = captureSummaryInput(
      runResult([
        issueResult({
          issueNumber: 766,
          success: false,
          phaseResults: [
            phase({ success: false, error: "AC not met" }),
            phase({ phase: "loop", success: false, error: "loop crashed" }),
          ],
        }),
      ]),
    );

    expect(input.issues[0].failureReason).toBe("AC not met");
  });

  it("carries the latest attempt's qa verdict and unmet count, not the first", () => {
    // `verdict`/`unmetCount` hang off the same entry as `failureReason`, so
    // first-wins made them stale too: a run that closed 2 of 3 gaps still
    // reported the first iteration's 3.
    const input = captureSummaryInput(
      runResult([
        issueResult({
          issueNumber: 766,
          success: false,
          phaseResults: [
            phase({
              success: false,
              error: "AC not met",
              verdict: "AC_NOT_MET",
              summary: { gaps: ["a", "b", "c"] },
            } as Partial<PhaseResult>),
            phase({ phase: "loop", success: true }),
            phase({
              success: false,
              error: "AC not met",
              verdict: "AC_NOT_MET",
              summary: { gaps: ["c"] },
            } as Partial<PhaseResult>),
          ],
        }),
      ]),
    );

    expect(input.issues[0].unmetCount).toBe(1);
  });

  it("falls back to abortReason when no phase ran (locked/aborted issue)", () => {
    const input = captureSummaryInput(
      runResult([
        issueResult({
          issueNumber: 99,
          success: false,
          phaseResults: [],
          abortReason: "locked by PID 123",
        }),
      ]),
    );

    expect(input.issues[0].failureReason).toBe("locked by PID 123");
  });
});

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
