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

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./metrics-writer.js", () => ({
  // `new MetricsWriter(...)` requires a constructable implementation — an
  // arrow function throws "is not a constructor" when vitest forwards the
  // `new` call, so this must be a `function` expression.
  MetricsWriter: vi.fn().mockImplementation(function MockMetricsWriter() {
    return { recordRun: vi.fn().mockResolvedValue(undefined) };
  }),
}));

vi.mock("./token-utils.js", () => ({
  // #986: the hook fallback, read through the one worktree-anchored helper.
  // Returns zeros by default so the driver-sourced assertions below are not
  // contaminated; the fallback-precedence test overrides it per-call.
  readWorktreeTokenUsage: vi.fn(() => ({
    tokensUsed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
  })),
}));

vi.mock("./worktree-manager.js", () => ({
  getWorktreeDiffStats: vi.fn(() => ({ filesChanged: 0, linesAdded: 0 })),
}));

import * as fs from "node:fs";
import { RunOrchestrator } from "./run-orchestrator.js";
import { MetricsWriter } from "./metrics-writer.js";
import { readWorktreeTokenUsage } from "./token-utils.js";
import type {
  ExecutionConfig,
  IssueResult,
  PhaseUsage,
  RunOptions,
} from "./types.js";

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

describe("#915: RunOrchestrator.recordMetrics aggregates effortEscalations from both retry sites", () => {
  it("collects escalated phaseResults across issues into a single flat array", async () => {
    await recordMetrics(
      baseConfig(),
      {} as RunOptions,
      [
        issueResult({
          issueNumber: 915,
          phaseResults: [
            {
              phase: "exec",
              success: true,
              escalatedEffort: { base: "high", escalated: "xhigh" },
            },
            { phase: "qa", success: true }, // not escalated — excluded
          ],
        }),
        issueResult({
          issueNumber: 916,
          phaseResults: [
            {
              phase: "qa",
              success: true,
              escalatedEffort: { base: "medium", escalated: "high" },
            },
          ],
        }),
      ],
      new Map(),
      [915, 916],
      42,
    );

    const writerMock = vi.mocked(MetricsWriter);
    const lastInstance =
      writerMock.mock.results[writerMock.mock.results.length - 1].value;
    expect(lastInstance.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        effortEscalations: [
          { phase: "exec", base: "high", escalated: "xhigh" },
          { phase: "qa", base: "medium", escalated: "high" },
        ],
      }),
    );
  });

  it("also collects escalations recorded on the --ready-gate path (IssueResult.readyGate.effortEscalations)", async () => {
    await recordMetrics(
      baseConfig(),
      {} as RunOptions,
      [
        issueResult({
          issueNumber: 915,
          phaseResults: [],
          readyGate: {
            effortEscalations: [
              { phase: "qa", base: "high", escalated: "xhigh" },
            ],
          } as never,
        }),
      ],
      new Map(),
      [915],
      42,
    );

    const writerMock = vi.mocked(MetricsWriter);
    const lastInstance =
      writerMock.mock.results[writerMock.mock.results.length - 1].value;
    expect(lastInstance.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        effortEscalations: [{ phase: "qa", base: "high", escalated: "xhigh" }],
      }),
    );
  });

  it("passes an empty array when nothing escalated (no phase, no ready-gate)", async () => {
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
      expect.objectContaining({ effortEscalations: [] }),
    );
  });
});

/**
 * #986 — the driver already hands us exact per-model tokens and an SDK cost
 * estimate; before this, `recordMetrics` read a bare-relative `.sequant`
 * (the main checkout) and recorded `tokensUsed: 0` on every run ever made.
 */
describe("#986: RunOrchestrator.recordMetrics aggregates driver modelUsage", () => {
  /**
   * Recorded real SDK `result` message, two model entries. Normalized here the
   * same way `phase-executor.ts` normalizes it, so this test consumes the real
   * field names and magnitudes rather than hand-picked round numbers.
   */
  const fixture = JSON.parse(
    fs.readFileSync(
      "src/lib/workflow/__fixtures__/sdk-result-modelusage-986.json",
      "utf-8",
    ),
  ) as {
    modelUsage: Record<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        costUSD: number;
      }
    >;
  };

  const fixtureUsage: PhaseUsage[] = Object.entries(fixture.modelUsage).map(
    ([model, e]) => ({
      model,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheReadTokens: e.cacheReadInputTokens,
      cacheCreationTokens: e.cacheCreationInputTokens,
      costUSD: e.costUSD,
    }),
  );

  function lastRecordRun() {
    const writerMock = vi.mocked(MetricsWriter);
    const lastInstance =
      writerMock.mock.results[writerMock.mock.results.length - 1].value;
    return lastInstance.recordRun.mock.calls[0][0];
  }

  beforeEach(() => {
    // Call history leaks across tests otherwise — the "fallback not consulted"
    // assertion would see the previous test's call.
    vi.clearAllMocks();
    vi.mocked(readWorktreeTokenUsage).mockReturnValue({
      tokensUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
    });
  });

  it("986 records tokens and costUSD equal to the sums of the recorded modelUsage entries (AC-1)", async () => {
    await recordMetrics(
      baseConfig(),
      {} as RunOptions,
      [
        issueResult({
          issueNumber: 986,
          phaseResults: [{ phase: "exec", success: true, usage: fixtureUsage }],
        }),
      ],
      new Map(),
      [986],
      42,
    );

    const entries = Object.values(fixture.modelUsage);
    const sum = (pick: (e: (typeof entries)[number]) => number) =>
      entries.reduce((acc, e) => acc + pick(e), 0);
    const inputTokens = sum((e) => e.inputTokens);
    const outputTokens = sum((e) => e.outputTokens);

    expect(lastRecordRun().metrics).toEqual(
      expect.objectContaining({
        tokensUsed: inputTokens + outputTokens,
        inputTokens,
        outputTokens,
        cacheTokens:
          sum((e) => e.cacheReadInputTokens) +
          sum((e) => e.cacheCreationInputTokens),
        costUSD: sum((e) => e.costUSD),
      }),
    );
    // The defect this replaces: 0 on 365/365 recorded runs.
    expect(lastRecordRun().metrics.tokensUsed).toBeGreaterThan(0);
  });

  it("986 keeps two qa executions as two phaseUsage rows, not one merged row (AC-2)", async () => {
    const oneModel = (model: string, inputTokens: number): PhaseUsage[] => [
      {
        model,
        inputTokens,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0.5,
      },
    ];

    await recordMetrics(
      baseConfig(),
      {} as RunOptions,
      [
        issueResult({
          issueNumber: 986,
          phaseResults: [
            // A quality-loop retry: the SAME phase name, executed twice.
            { phase: "qa", success: false, usage: oneModel("claude-x", 100) },
            { phase: "loop", success: true },
            { phase: "qa", success: true, usage: oneModel("claude-x", 200) },
          ],
        }),
      ],
      new Map(),
      [986],
      42,
    );

    const phaseUsage = lastRecordRun().metrics.phaseUsage as Array<
      PhaseUsage & { phase: string }
    >;
    const qaRows = phaseUsage.filter((r) => r.phase === "qa");
    expect(qaRows).toHaveLength(2);
    // Keying by phase name would have merged these into one 300-token row.
    expect(qaRows.map((r) => r.inputTokens)).toEqual([100, 200]);
    expect(qaRows.every((r) => r.model === "claude-x")).toBe(true);
    expect(qaRows[0]).toEqual({
      phase: "qa",
      model: "claude-x",
      inputTokens: 100,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUSD: 0.5,
    });
  });

  it("986 omits phaseUsage and costUSD entirely when no driver reported usage", async () => {
    await recordMetrics(
      baseConfig(),
      {} as RunOptions,
      [issueResult({ phaseResults: [{ phase: "exec", success: true }] })],
      new Map(),
      [986],
      42,
    );

    // Omitted, not an empty array / a 0 — "absent" and "free" are different
    // claims, and the stats table renders them differently.
    expect(lastRecordRun().metrics.phaseUsage).toBeUndefined();
    expect(lastRecordRun().metrics.costUSD).toBeUndefined();
  });

  it("986 falls back to the worktree-anchored hook files only when the driver reported nothing (AC-4)", async () => {
    vi.mocked(readWorktreeTokenUsage).mockReturnValue({
      tokensUsed: 900,
      inputTokens: 600,
      outputTokens: 300,
      cacheTokens: 50,
    });

    await recordMetrics(
      baseConfig(),
      {} as RunOptions,
      [issueResult({ phaseResults: [{ phase: "exec", success: true }] })],
      new Map([[914, { path: "/wt/feature-986" } as never]]),
      [914],
      42,
    );

    expect(readWorktreeTokenUsage).toHaveBeenCalledWith("/wt/feature-986", {
      cleanup: true,
    });
    expect(lastRecordRun().metrics).toEqual(
      expect.objectContaining({
        tokensUsed: 900,
        inputTokens: 600,
        outputTokens: 300,
        cacheTokens: 50,
      }),
    );
  });

  it("986 does not consult the hook fallback when driver usage exists", async () => {
    vi.mocked(readWorktreeTokenUsage).mockReturnValue({
      tokensUsed: 900,
      inputTokens: 600,
      outputTokens: 300,
      cacheTokens: 50,
    });

    await recordMetrics(
      baseConfig(),
      {} as RunOptions,
      [
        issueResult({
          phaseResults: [{ phase: "exec", success: true, usage: fixtureUsage }],
        }),
      ],
      new Map([[914, { path: "/wt/feature-986" } as never]]),
      [914],
      42,
    );

    expect(readWorktreeTokenUsage).not.toHaveBeenCalled();
  });
});

/**
 * #986 AC-4 gate — scoped to the `recordMetrics` body, so a mention of the old
 * call in a comment or in an unrelated method cannot satisfy or break it.
 */
describe("#986 AC-4 gate: the metrics read is worktree-anchored", () => {
  const SOURCE = "src/lib/workflow/run-orchestrator.ts";

  function recordMetricsRegion(): string {
    const src = fs.readFileSync(SOURCE, "utf-8");
    const start = src.indexOf("private static async recordMetrics(");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("function findOrAppendPhase", start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it("986 leaves no getTokenUsageForRun(undefined call in recordMetrics", () => {
    // The defect: `getTokenUsageForRun(undefined, true)` resolved `.sequant`
    // against process.cwd() — the MAIN checkout — while the hook writes into
    // the worktree. It also deleted the user's own interactive-session token
    // files there.
    expect(recordMetricsRegion()).not.toContain(
      "getTokenUsageForRun(undefined",
    );
  });

  it("986 reads through the same helper the ready gate's readTokensUsed default uses", () => {
    expect(recordMetricsRegion()).toContain("readWorktreeTokenUsage(");
    expect(
      fs.readFileSync("src/lib/workflow/ready-gate.ts", "utf-8"),
    ).toContain("readWorktreeTokenUsage(");
  });
});
