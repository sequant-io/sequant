/**
 * Unit tests for the stats failureCategory breakdown (Issue #783)
 *
 * Covers:
 *   AC-1: breakdown rendered adjacent to outcome section (metrics display)
 *   AC-2: absent failureCategory bucketed as `unclassified`, distinct from enum `unknown`
 *   AC-3: section hidden when zero failed runs
 *   AC-4: breakdown computed post-filter (filters force log-mode; #640 contract)
 *   AC-5: JSON metrics output includes the breakdown
 *   AC-6: this file (mixed corpus + zero-failure corpus)
 *
 * Run with: npm test -- src/commands/stats-failure-categories.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import { statsCommand } from "./stats.js";
import type { Metrics, MetricRun } from "../lib/workflow/metrics-schema.js";
import { METRICS_FILE_PATH } from "../lib/workflow/metrics-schema.js";
import type { RunLog } from "../lib/workflow/run-log-schema.js";

// Mock fs module before imports
vi.mock("fs");

// Mock path module to control joins
vi.mock("path", async () => {
  const actual = await vi.importActual("path");
  return {
    ...actual,
    join: (...args: string[]) => args.join("/"),
  };
});

// Mock cli-ui to pass through content without visual formatting
vi.mock("../lib/cli-ui.js", () => ({
  configureUI: vi.fn(),
  getUIConfig: vi.fn(() => ({ noColor: true, jsonMode: false })),
  colors: {
    success: (s: string) => s,
    error: (s: string) => s,
    warning: (s: string) => s,
    info: (s: string) => s,
    muted: (s: string) => s,
    header: (s: string) => s,
    label: (s: string) => s,
    value: (s: string) => s,
    accent: (s: string) => s,
    bold: (s: string) => s,
    pending: (s: string) => s,
    running: (s: string) => s,
    completed: (s: string) => s,
    failed: (s: string) => s,
  },
  ui: {
    headerBox: vi.fn((title: string) => title),
    sectionHeader: vi.fn((title: string) => title),
    table: vi.fn(() => ""),
    keyValueTable: vi.fn((data: Record<string, unknown>) =>
      Object.entries(data)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n"),
    ),
    progressBar: vi.fn(() => ""),
  },
}));

let runCounter = 0;

/** Build a valid MetricRun with deterministic unique ids */
function makeRun(
  outcome: MetricRun["outcome"],
  failureCategory?: MetricRun["failureCategory"],
): MetricRun {
  runCounter++;
  const suffix = String(runCounter).padStart(12, "0");
  const run: MetricRun = {
    id: `12345678-1234-4234-a234-${suffix}`,
    date: "2026-07-01T10:00:00.000Z",
    issues: [100 + runCounter],
    phases: ["spec", "exec", "qa"],
    outcome,
    duration: 300,
    model: "opus",
    flags: [],
    metrics: {
      tokensUsed: 1000,
      filesChanged: 2,
      linesAdded: 50,
      acceptanceCriteria: 3,
      qaIterations: 1,
    },
  };
  if (failureCategory !== undefined) {
    run.failureCategory = failureCategory;
  }
  return run;
}

function makeMetrics(runs: MetricRun[]): Metrics {
  return { version: 1, runs };
}

/** Minimal valid run log for the log-mode fallback path (AC-4) */
const mockLog: RunLog = {
  version: 1,
  runId: "12345678-1234-4234-a234-123456789abc",
  startTime: "2026-07-01T10:00:00.000Z",
  endTime: "2026-07-01T10:05:00.000Z",
  config: {
    phases: ["spec", "exec", "qa"],
    sequential: false,
    qualityLoop: false,
    maxIterations: 3,
  },
  issues: [
    {
      issueNumber: 123,
      title: "Test Issue",
      labels: ["bug"],
      status: "success",
      phases: [
        {
          phase: "exec",
          issueNumber: 123,
          startTime: "2026-07-01T10:00:00.000Z",
          endTime: "2026-07-01T10:03:00.000Z",
          durationSeconds: 180,
          status: "success",
        },
      ],
      totalDurationSeconds: 180,
    },
  ],
  summary: {
    totalIssues: 1,
    passed: 1,
    failed: 0,
    totalDurationSeconds: 300,
  },
};

/** Wire fs mocks so METRICS_FILE_PATH serves `metrics` and log dirs serve `logs` */
function mockFilesystem(metrics: Metrics | null, logs: RunLog[] = []) {
  (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
    (p: string) => {
      if (String(p).endsWith(METRICS_FILE_PATH)) return metrics !== null;
      return true;
    },
  );
  (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(
    logs.map((_, i) => `run-2026-07-0${i + 1}-abc.json`),
  );
  (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(
    (p: string) => {
      if (String(p).endsWith(METRICS_FILE_PATH)) {
        return JSON.stringify(metrics);
      }
      const match = String(p).match(/run-2026-07-0(\d)-abc\.json$/);
      const idx = match ? Number(match[1]) - 1 : 0;
      return JSON.stringify(logs[idx] ?? mockLog);
    },
  );
}

function joinedOutput(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c) => c[0]).join("\n");
}

describe("stats failureCategory breakdown (#783)", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    runCounter = 0;
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe("AC-1: renders breakdown from MetricRun.failureCategory over failed runs", () => {
    it("renders 'Failure Categories' with per-category count and percentage for a mixed corpus", async () => {
      // Given: 2x rate_limit failed, 1x build_error failed, 1 pre-#761 failed,
      // 1 success, 1 partial
      mockFilesystem(
        makeMetrics([
          makeRun("failed", "rate_limit"),
          makeRun("failed", "rate_limit"),
          makeRun("failed", "build_error"),
          makeRun("failed"),
          makeRun("success"),
          makeRun("partial"),
        ]),
      );

      // When
      await statsCommand({});

      // Then
      const output = joinedOutput(consoleSpy);
      expect(output).toContain("Failure Categories (4 failed runs)");
      expect(output).toMatch(/rate_limit\s+2 \(50%\)/);
      expect(output).toMatch(/build_error\s+1 \(25%\)/);
      expect(output).toMatch(/unclassified\s+1 \(25%\)/);
    });

    it("sorts buckets by count descending", async () => {
      mockFilesystem(
        makeMetrics([
          makeRun("failed", "timeout"),
          makeRun("failed", "rate_limit"),
          makeRun("failed", "rate_limit"),
          makeRun("failed", "rate_limit"),
          makeRun("failed", "timeout"),
        ]),
      );

      await statsCommand({});

      const output = joinedOutput(consoleSpy);
      expect(output.indexOf("rate_limit")).toBeGreaterThan(-1);
      expect(output.indexOf("rate_limit")).toBeLessThan(
        output.indexOf("timeout"),
      );
    });
  });

  describe("AC-2: unclassified vs unknown are distinct buckets", () => {
    it("buckets records without failureCategory as 'unclassified' (not dropped)", async () => {
      mockFilesystem(makeMetrics([makeRun("failed"), makeRun("success")]));

      await statsCommand({});

      const output = joinedOutput(consoleSpy);
      expect(output).toContain("Failure Categories (1 failed run)");
      expect(output).toMatch(/unclassified\s+1 \(100%\)/);
    });

    it("keeps enum 'unknown' separate from 'unclassified'", async () => {
      // Given: one failed run classified as "unknown" AND one without the field
      mockFilesystem(
        makeMetrics([makeRun("failed", "unknown"), makeRun("failed")]),
      );

      await statsCommand({});

      const output = joinedOutput(consoleSpy);
      expect(output).toMatch(/\bunknown\s+1 \(50%\)/);
      expect(output).toMatch(/\bunclassified\s+1 \(50%\)/);
    });
  });

  describe("AC-3: section hidden with zero failed runs", () => {
    it("does not print the section header for a success/partial-only corpus", async () => {
      mockFilesystem(
        makeMetrics([
          makeRun("success"),
          makeRun("success"),
          makeRun("partial"),
        ]),
      );

      await statsCommand({});

      const output = joinedOutput(consoleSpy);
      expect(output).toContain("SEQUANT ANALYTICS");
      expect(output).not.toContain("Failure Categories");
    });
  });

  describe("AC-4: breakdown respects cohort filters (post-filter computation)", () => {
    it("does not render the metrics breakdown when --label forces log-mode", async () => {
      // Given: metrics.json with categorized failures AND run logs on disk
      mockFilesystem(makeMetrics([makeRun("failed", "rate_limit")]), [mockLog]);

      // When: a cohort filter is set (#640: filters bypass metrics entirely)
      await statsCommand({ label: "bug" });

      // Then: log-based display renders; no metrics failure-category section
      const output = joinedOutput(consoleSpy);
      expect(output).toContain("Log directory:");
      expect(output).not.toContain("Failure Categories");
    });

    it("does not render the metrics breakdown when --since forces log-mode", async () => {
      mockFilesystem(makeMetrics([makeRun("failed", "rate_limit")]), [mockLog]);

      await statsCommand({ since: "2026-01-01" });

      const output = joinedOutput(consoleSpy);
      expect(output).toContain("Log directory:");
      expect(output).not.toContain("Failure Categories");
    });
  });

  describe("AC-5: machine-readable output includes the breakdown", () => {
    it("includes failureCategories in --json metrics-source output", async () => {
      mockFilesystem(
        makeMetrics([
          makeRun("failed", "rate_limit"),
          makeRun("failed", "rate_limit"),
          makeRun("failed"),
          makeRun("success"),
        ]),
      );

      await statsCommand({ json: true });

      const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(parsed.source).toBe("metrics");
      expect(parsed.failureCategories).toEqual([
        { category: "rate_limit", count: 2 },
        { category: "unclassified", count: 1 },
      ]);
      // Per-run category still present via runs[]
      expect(parsed.runs[0].failureCategory).toBe("rate_limit");
      expect(parsed.runs[2].failureCategory).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("handles a corpus where ALL failed runs are unclassified (no NaN%)", async () => {
      mockFilesystem(
        makeMetrics([makeRun("failed"), makeRun("failed"), makeRun("failed")]),
      );

      await statsCommand({});

      const output = joinedOutput(consoleSpy);
      expect(output).toContain("Failure Categories (3 failed runs)");
      expect(output).toMatch(/unclassified\s+3 \(100%\)/);
      expect(output).not.toContain("NaN");
    });

    it("does not count categories carried by non-failed runs", async () => {
      // Given: a partial run carrying failureCategory (run-orchestrator records
      // it when >=1 issue fails) plus one categorized failed run
      mockFilesystem(
        makeMetrics([
          makeRun("partial", "timeout"),
          makeRun("failed", "rate_limit"),
        ]),
      );

      await statsCommand({});

      // Then: only the failed run counts (AC-1 literal: "over failed runs")
      const output = joinedOutput(consoleSpy);
      expect(output).toContain("Failure Categories (1 failed run)");
      expect(output).toMatch(/rate_limit\s+1 \(100%\)/);
      expect(output).not.toContain("timeout");
    });
  });
});
