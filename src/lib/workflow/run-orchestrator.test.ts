/**
 * Tests for the run orchestrator's *producer* side.
 *
 * #867 fixed the SUMMARY duration by moving the computation here: the
 * orchestrator brackets the whole run, so it owns the wall clock and hands one
 * value to every consumer. `run-display.test.ts` covers the consumer seam, but
 * it drives `displaySummary` from a hand-built `RunResult` — nothing exercised
 * the code that *produces* `wallClockDurationSeconds`. These tests close that
 * gap by driving the real `RunOrchestrator.run()`.
 *
 * The empty-issue path is the hermetic seam: `run()` returns before any
 * services, git, log writer, or network are touched, and passing `baseBranch`
 * skips `detectDefaultBranch`'s git shell-out. That is enough to assert the
 * property that matters — the value is `(end - start)` across the run, not
 * anything derived from per-issue durations.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { RunOrchestrator } from "./run-orchestrator.js";
import type { RunInit } from "./run-orchestrator.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import type { RunOptions } from "./types.js";

function runInit(options: Partial<RunOptions> = {}): RunInit {
  return {
    options: { noLog: true, ...options } as RunOptions,
    settings: DEFAULT_SETTINGS,
    manifest: { stack: "node", packageManager: "npm" },
    // Skip detectDefaultBranch's git shell-out — keeps the test hermetic.
    baseBranch: "main",
  };
}

/**
 * Freeze `Date.now` to a scripted sequence so the run's bracket is exact and
 * the assertion is not a timing tolerance. The first read is the origin the
 * orchestrator captures; every later read is the run's end.
 */
function stubElapsed(millis: number): () => void {
  const START = Date.parse("2026-07-29T15:32:29.443Z");
  let first = true;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => {
    if (first) {
      first = false;
      return START;
    }
    return START + millis;
  });
  return () => spy.mockRestore();
}

describe("RunOrchestrator.run — produces the run wall clock (#867)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns elapsed wall clock on RunResult", async () => {
    const restore = stubElapsed(2_178_334); // the measured run: 36m 18s
    try {
      const result = await RunOrchestrator.run(runInit(), []);
      expect(result.wallClockDurationSeconds).toBe(2178.334);
    } finally {
      restore();
    }
  });

  it("derives the value from the run bracket, not from per-issue durations", async () => {
    // The defect this pins: a run with NO issue results still has a wall clock.
    // Any implementation that reaches for `results.reduce(...)` reports 0 here,
    // because there is nothing to sum — the two computations are only
    // interchangeable when issues run back-to-back, which is exactly the
    // assumption #419 invalidated.
    const restore = stubElapsed(45_000);
    try {
      const result = await RunOrchestrator.run(runInit(), []);
      expect(result.results).toHaveLength(0);
      expect(result.wallClockDurationSeconds).toBe(45);
      expect(result.wallClockDurationSeconds).not.toBe(0);
    } finally {
      restore();
    }
  });

  it("produces the value under --no-log, where there is no run log to read it back from", async () => {
    // AC-3: the origin is captured before log setup, so the summary's duration
    // survives `--no-log` (and a log-init failure, which nulls the writer the
    // same way). Sourcing the duration from the stored log would report nothing
    // on this path.
    const restore = stubElapsed(600_000);
    try {
      const result = await RunOrchestrator.run(runInit({ noLog: true }), []);
      expect(result.logWriter).toBeNull();
      expect(result.wallClockDurationSeconds).toBe(600);
    } finally {
      restore();
    }
  });
});
