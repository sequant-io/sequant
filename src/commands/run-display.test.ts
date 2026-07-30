/**
 * Tests for the post-run summary display.
 *
 * Focused on the #760 checkpoint-failure notice: the per-issue warning fires
 * mid-run and has long scrolled past by the time a multi-hour chain finishes,
 * so the summary restates it. These lock the fact that `checkpointFailed` is
 * actually *consumed* — it was set on IssueResult and read by nobody.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { displaySummary, buildRateLimitHaltNotice } from "./run-display.js";
import { BillingError, RateLimitError } from "../lib/errors.js";
import { formatElapsedTime } from "../lib/cli-ui/format.js";
import {
  createEmptyRunLog,
  finalizeRunLog,
  type RunConfig,
} from "../lib/workflow/run-log-schema.js";
import type { RunResult } from "../lib/workflow/run-orchestrator.js";
import type {
  IssueResult,
  PhaseResult,
  RunOptions,
} from "../lib/workflow/types.js";
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

function runResult(
  results: IssueResult[],
  mergedOptions: Partial<RunOptions> = {},
  // #867: the orchestrator now hands the summary a single wall-clock value.
  // Default to the per-issue sum so pre-#867 tests (which never assert duration)
  // keep their prior rendered output; #867's tests pass an explicit wall clock
  // that diverges from the sum.
  wallClockDurationSeconds = results.reduce(
    (sum, r) => sum + (r.durationSeconds ?? 0),
    0,
  ),
): RunResult {
  return {
    results,
    logPath: null,
    exitCode: 0,
    worktreeMap: new Map(),
    issueInfoMap: new Map(),
    config: { dryRun: false, phases: [], qualityLoop: false },
    mergedOptions,
    logWriter: null,
    wallClockDurationSeconds,
  } as unknown as RunResult;
}

/**
 * Capture what `displaySummary` writes to stdout via the renderless path — the
 * SUMMARY header is emitted through `process.stdout.write` (renderRunSummary),
 * not `console.log`, so `capture` above misses it.
 */
function captureStdout(result: RunResult): string {
  const chunks: string[] = [];
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((s: string | Uint8Array) => {
      chunks.push(typeof s === "string" ? s : s.toString());
      return true;
    });
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    displaySummary(result);
    return chunks.join("");
  } finally {
    outSpy.mockRestore();
    logSpy.mockRestore();
  }
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

describe("displaySummary — ready-gate outcome (#817)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const readyGate = (overrides = {}) => ({
    issueNumber: 817,
    policy: "ac" as const,
    ready: true,
    reason: "AC_MET" as const,
    issueStatus: "waiting_for_human_merge" as const,
    iterations: 1,
    finalVerdict: "AC_MET_BUT_NOT_A_PLUS" as const,
    autoFixed: [],
    remaining: [],
    tokensUsed: 0,
    report: "",
    ...overrides,
  });

  it("surfaces the gate reason and never-merged status for a gated issue", () => {
    const output = capture(
      runResult([issueResult({ issueNumber: 817, readyGate: readyGate() })]),
    );

    expect(output).toContain("Ready gate");
    expect(output).toContain("never merged");
    expect(output).toContain("#817");
    expect(output).toContain("AC_MET");
    expect(output).toContain("waiting_for_human_merge");
  });

  it("flags a guard halt distinctly from a clean threshold", () => {
    const output = capture(
      runResult([
        issueResult({
          issueNumber: 818,
          readyGate: readyGate({
            ready: false,
            reason: "MAX_ITERATIONS",
            issueStatus: "blocked",
          }),
        }),
      ]),
    );

    expect(output).toContain("MAX_ITERATIONS");
    expect(output).toContain("blocked");
  });

  it("stays silent when no issue ran the gate (flag off)", () => {
    const output = capture(runResult([issueResult({ issueNumber: 1 })]));
    expect(output).not.toContain("Ready gate");
  });

  it("reports a crashed gate as 'did not run' rather than omitting it", () => {
    // A gate crash is non-fatal (the PR still opens), but the user opted into a
    // second look. If the summary omitted the issue entirely, a run whose gate
    // died would be indistinguishable from one that gated cleanly — the user
    // would believe the extra QA pass happened when it never did.
    const output = capture(
      runResult([
        issueResult({
          issueNumber: 819,
          readyGateError: "settings unreadable",
        }),
      ]),
    );

    expect(output).toContain("Ready gate");
    expect(output).toContain("#819");
    expect(output).toContain("did not run");
    expect(output).toContain("settings unreadable");
    // The remediation must be actionable, not just a complaint.
    expect(output).toContain("sequant ready 819");
    // A failed gate must never be rendered as a clean pass.
    expect(output).not.toContain("AC_MET");
    expect(output).not.toContain("waiting_for_human_merge");
  });
});

/**
 * #761 AC-5 — a chain halted by a rate limit restates the labeled cause at
 * the summary (the per-phase error scrolled past hours ago) and spells out
 * that resume is re-running the identical command (#760 added no flag).
 */
describe("displaySummary — rate-limit chain halt notice (#761)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function rateLimitedIssue(issueNumber: number): IssueResult {
    return issueResult({
      issueNumber,
      success: false,
      phaseResults: [
        {
          phase: "exec",
          success: false,
          error: "Rate limited — resets at 14:30",
          structuredError: new RateLimitError(
            "Rate limited — resets at 14:30",
            { resetsAt: 1_700_000_000, rateLimitType: "five_hour" },
          ),
        } as PhaseResult,
      ],
    });
  }

  it("prints the labeled cause, the halted link, and the resume affordance", () => {
    const output = capture(
      runResult([issueResult({ issueNumber: 101 }), rateLimitedIssue(102)], {
        chain: true,
      }),
    );

    // formatRateLimitMessage label with resetsAt included.
    expect(output).toMatch(/Rate limited — resets at /);
    expect(output).toContain("chain halted at #102");
    // The resume affordance must say resume IS re-running the same command.
    expect(output).toContain("Re-run the same command to resume from #102");
  });

  it("labels a billing halt with the billing cause", () => {
    const output = capture(
      runResult(
        [
          issueResult({
            issueNumber: 55,
            success: false,
            phaseResults: [
              {
                phase: "qa",
                success: false,
                error: "Out of credits",
                structuredError: new BillingError("Out of credits", {
                  overageDisabledReason: "out_of_credits",
                }),
              } as PhaseResult,
            ],
          }),
        ],
        { chain: true },
      ),
    );

    expect(output).toContain("Out of credits");
    expect(output).toContain("chain halted at #55");
  });

  it("does not mislabel a metadata-less billing halt as rate-limited (assistant-error channel)", () => {
    // A billing_error arriving via the assistant-error channel has empty
    // metadata; re-deriving the label from metadata would say "Rate limited".
    const notice = buildRateLimitHaltNotice(
      [
        issueResult({
          issueNumber: 56,
          success: false,
          phaseResults: [
            {
              phase: "exec",
              success: false,
              error: "Billing error",
              structuredError: new BillingError("Billing error", {
                assistantError: "billing_error",
              }),
            } as PhaseResult,
          ],
        }),
      ],
      true,
    );

    expect(notice).toEqual({ issueNumber: 56, label: "Billing error" });
  });

  it("stays silent outside chain mode (no #760 resume semantics to point at)", () => {
    const output = capture(runResult([rateLimitedIssue(102)], {}));

    expect(output).not.toContain("chain halted");
  });

  it("stays silent when the chain halted on a non-rate-limit failure", () => {
    const output = capture(
      runResult(
        [
          issueResult({
            issueNumber: 7,
            success: false,
            phaseResults: [
              {
                phase: "exec",
                success: false,
                error: "build failed",
              } as PhaseResult,
            ],
          }),
        ],
        { chain: true },
      ),
    );

    expect(output).not.toContain("chain halted");
  });

  it("classifies from the LAST non-loop failing attempt (#766 reverse scan)", () => {
    // First iteration failed on a timeout, quality loop ran, the final
    // attempt died rate-limited — the notice must reflect the last attempt.
    const notice = buildRateLimitHaltNotice(
      [
        issueResult({
          issueNumber: 9,
          success: false,
          phaseResults: [
            {
              phase: "qa",
              success: false,
              error: "Timeout after 1800s",
            } as PhaseResult,
            { phase: "loop", success: true } as PhaseResult,
            {
              phase: "qa",
              success: false,
              error: "Rate limited",
              structuredError: new RateLimitError("Rate limited"),
            } as PhaseResult,
          ],
        }),
      ],
      true,
    );

    expect(notice).toEqual({ issueNumber: 9, label: "Rate limited" });
  });

  it("does not let a trailing loop failure mask the rate-limited phase", () => {
    const notice = buildRateLimitHaltNotice(
      [
        issueResult({
          issueNumber: 11,
          success: false,
          phaseResults: [
            {
              phase: "exec",
              success: false,
              error: "Rate limited",
              structuredError: new RateLimitError("Rate limited"),
            } as PhaseResult,
            {
              phase: "loop",
              success: false,
              error: "loop crashed",
            } as PhaseResult,
          ],
        }),
      ],
      true,
    );

    expect(notice).toEqual({ issueNumber: 11, label: "Rate limited" });
  });
});

/**
 * #867 — the SUMMARY header duration is the run's WALL CLOCK, computed once by
 * the orchestrator (`RunResult.wallClockDurationSeconds`), NOT the sum of
 * per-issue durations. Under `--parallel` that sum double-counts overlapping
 * issues and over-reports by ~the concurrency factor: a 36m 18s run printed
 * 1h 12m at concurrency 3 (run 21feec76 in the issue body).
 *
 * These tests drive `displaySummary` from a `RunResult` — through the bug site
 * at `run-display.ts` — not `renderSummary({totalDurationSeconds})`, which would
 * test the renderer and pass against unfixed code (AC-6).
 */
describe("displaySummary — run wall clock, not per-issue sum (#867)", () => {
  // Verbatim from the measured run in the issue body (run 21feec76):
  //   start 15:32:29.443Z → end 16:08:47.777Z = 2178.334s = 36m 18s (wall clock)
  //   per-issue durations 855.655 + 961.65 + 1203.303 + 1302.296 = 4322.904s
  //   = 1h 12m — exactly what the pre-#867 reduce misprinted.
  const RUN_STARTED_AT = Date.parse("2026-07-29T15:32:29.443Z");
  const RUN_ENDED_AT = Date.parse("2026-07-29T16:08:47.777Z");
  const MEASURED_WALL_CLOCK = (RUN_ENDED_AT - RUN_STARTED_AT) / 1000; // 2178.334
  const MEASURED_PER_ISSUE = [855.655, 961.65, 1203.303, 1302.296];

  const LOG_CONFIG: RunConfig = {
    phases: ["exec"],
    sequential: false,
    qualityLoop: false,
    maxIterations: 1,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // AC-5/AC-6/AC-7/AC-8: the regression gate. Restoring the `reduce` sum at
  // run-display.ts makes exactly THIS test fail (the AC-4 test below stays
  // green, since sum ≈ wall clock there).
  it("prints wall clock for a >2× parallel fixture; logs and SUMMARY agree", () => {
    // AC-5: a 3-concurrent run whose per-issue sum exceeds wall clock by >2×.
    // Two waves of 3 concurrent issues: 6 × 600s = 3600s summed, but the run's
    // wall clock is 1200s (20m). A summing implementation prints 1h; the >2×
    // gap means summing cannot satisfy the wall-clock assertion.
    const PARALLEL_WALL_CLOCK = 1200;
    const PARALLEL_SUM = 6 * 600;
    expect(PARALLEL_SUM).toBeGreaterThan(2 * PARALLEL_WALL_CLOCK); // fixture guard
    const parallel = runResult(
      Array.from({ length: 6 }, (_, i) =>
        issueResult({ issueNumber: 900 + i, durationSeconds: 600 }),
      ),
      {},
      PARALLEL_WALL_CLOCK,
    );

    // AC-6: driven through displaySummary from a RunResult (the bug site).
    const input = captureSummaryInput(parallel);
    expect(input.totalDurationSeconds).toBe(PARALLEL_WALL_CLOCK); // wall clock
    expect(input.totalDurationSeconds).not.toBe(PARALLEL_SUM); // not the sum

    // AC-6: and the wall-clock value reaches the rendered SUMMARY header.
    const parallelOut = captureStdout(parallel);
    expect(parallelOut).toContain(
      `· ${formatElapsedTime(PARALLEL_WALL_CLOCK)} ·`,
    ); // "· 20m ·"
    expect(parallelOut).not.toContain(formatElapsedTime(PARALLEL_SUM)); // not "1h"

    // Verbatim motivating example: the exact measured run reproduces 36m 18s,
    // never the summed 1h 12m.
    const measuredOut = captureStdout(
      runResult(
        MEASURED_PER_ISSUE.map((d, i) =>
          issueResult({ issueNumber: 850 + i, durationSeconds: d }),
        ),
        {},
        MEASURED_WALL_CLOCK,
      ),
    );
    expect(measuredOut).toContain("36m 18s");
    expect(measuredOut).not.toContain("1h 12m");

    // AC-7: `sequant logs --last 1` renders log.summary.totalDurationSeconds
    // (logs.ts:133); the live SUMMARY renders RunResult.wallClockDurationSeconds.
    // Threading the run origin into the log means both are (end - start)/1000
    // from the SAME start, so they report the same number for the same run.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(RUN_ENDED_AT);
      const log = finalizeRunLog(
        createEmptyRunLog(LOG_CONFIG, { startTime: new Date(RUN_STARTED_AT) }),
      );
      const summaryDuration = captureSummaryInput(
        runResult(
          MEASURED_PER_ISSUE.map((d, i) =>
            issueResult({ issueNumber: 850 + i, durationSeconds: d }),
          ),
          {},
          MEASURED_WALL_CLOCK,
        ),
      ).totalDurationSeconds;
      expect(log.summary.totalDurationSeconds).toBe(MEASURED_WALL_CLOCK);
      expect(log.summary.totalDurationSeconds).toBe(summaryDuration);
    } finally {
      vi.useRealTimers();
    }
  });

  // AC-4: a sequential (concurrency-1) run is unchanged by the fix — issues run
  // back-to-back so wall clock ≈ the per-issue sum. This passes with OR without
  // the reduce, pinning the fix as a no-op for serial runs.
  it("leaves a sequential run's duration unchanged (sum ≈ wall clock)", () => {
    const results = [
      issueResult({ issueNumber: 1, durationSeconds: 120 }),
      issueResult({ issueNumber: 2, durationSeconds: 180 }),
    ];
    const SEQUENTIAL_WALL_CLOCK = 300; // ≈ 120 + 180, serial execution
    const input = captureSummaryInput(
      runResult(results, {}, SEQUENTIAL_WALL_CLOCK),
    );
    expect(input.totalDurationSeconds).toBe(300);
  });
});
