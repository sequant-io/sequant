/**
 * Gap-fix test for #914 — `RunOrchestrator.recordMetrics`'s
 * `phasePolicies: config.phasePolicies` line, the single-line pass-through
 * that carries the resolved per-phase model/effort map into
 * `MetricsWriter.recordRun`.
 *
 * `recordMetrics` is `private static` (TypeScript-only privacy — a plain
 * static method at runtime) and is only reachable through the large
 * `RunOrchestrator.run()` entry point, which itself needs issue resolution,
 * worktree setup, and a log writer before it ever reaches metrics recording.
 * Driving all of that for a one-line pass-through would be disproportionate,
 * so this calls `recordMetrics` directly via a cast — the same trade-off
 * `run-orchestrator.test.ts` already documents for `executeOneIssue`.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("./metrics-writer.js", () => ({
  // `new MetricsWriter(...)` requires a constructable implementation — an
  // arrow function throws "is not a constructor" when vitest forwards the
  // `new` call, so this must be a `function` expression.
  MetricsWriter: vi.fn().mockImplementation(function MockMetricsWriter() {
    return { recordRun: vi.fn().mockResolvedValue(undefined) };
  }),
}));

vi.mock("./token-utils.js", () => ({
  getTokenUsageForRun: vi.fn(() => ({ tokensUsed: 0 })),
}));

vi.mock("./worktree-manager.js", () => ({
  getWorktreeDiffStats: vi.fn(() => ({ filesChanged: 0, linesAdded: 0 })),
}));

import { RunOrchestrator } from "./run-orchestrator.js";
import { MetricsWriter } from "./metrics-writer.js";
import type { ExecutionConfig, IssueResult, RunOptions } from "./types.js";

function baseConfig(): ExecutionConfig {
  return {
    phases: ["exec"],
    phaseTimeout: 1800,
    qualityLoop: false,
    maxIterations: 1,
    skipVerification: false,
    sequential: false,
    concurrency: 3,
    parallel: false,
    verbose: false,
    noSmartTests: false,
    dryRun: false,
    mcp: true,
    retry: true,
  };
}

function issueResult(overrides: Partial<IssueResult> = {}): IssueResult {
  return {
    issueNumber: 914,
    success: true,
    phaseResults: [],
    durationSeconds: 10,
    ...overrides,
  };
}

/** `recordMetrics` is private to TypeScript only — call it via a cast. */
const recordMetrics = (
  RunOrchestrator as unknown as {
    recordMetrics(
      config: ExecutionConfig,
      mergedOptions: RunOptions,
      results: IssueResult[],
      worktreeMap: Map<number, unknown>,
      issueNumbers: number[],
      wallClockDurationSeconds: number,
    ): Promise<void>;
  }
).recordMetrics;

describe("#914 gap-fix: RunOrchestrator.recordMetrics forwards config.phasePolicies", () => {
  it("forwards the resolved phasePolicies map into recordRun", async () => {
    await recordMetrics(
      {
        ...baseConfig(),
        phasePolicies: { exec: { model: "sonnet", effort: "medium" } },
      },
      {} as RunOptions,
      [issueResult()],
      new Map(),
      [914],
      42,
    );

    const writerMock = vi.mocked(MetricsWriter);
    const lastInstance =
      writerMock.mock.results[writerMock.mock.results.length - 1].value;
    expect(lastInstance.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        phasePolicies: { exec: { model: "sonnet", effort: "medium" } },
      }),
    );
  });

  it("forwards undefined when no phase has a configured policy", async () => {
    await recordMetrics(
      baseConfig(),
      {} as RunOptions,
      [issueResult()],
      new Map(),
      [914],
      42,
    );

    const writerMock = vi.mocked(MetricsWriter);
    const lastInstance =
      writerMock.mock.results[writerMock.mock.results.length - 1].value;
    expect(lastInstance.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ phasePolicies: undefined }),
    );
  });
});
