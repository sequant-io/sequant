/**
 * Unit tests for stats command
 *
 * Tests the aggregate statistics functionality.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import { statsCommand } from "./stats.js";
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
  logo: vi.fn(() => ""),
  banner: vi.fn(() => ""),
  box: vi.fn((content: string) => content),
  successBox: vi.fn((title: string, content?: string) =>
    content ? `${title}\n${content}` : title,
  ),
  errorBox: vi.fn((title: string, content?: string) =>
    content ? `${title}\n${content}` : title,
  ),
  warningBox: vi.fn((title: string, content?: string) =>
    content ? `${title}\n${content}` : title,
  ),
  headerBox: vi.fn((title: string) => title),
  table: vi.fn(() => ""),
  keyValueTable: vi.fn((data: Record<string, unknown>) =>
    Object.entries(data)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
  ),
  statusIcon: vi.fn(() => ""),
  printStatus: vi.fn(),
  divider: vi.fn(() => "---"),
  sectionHeader: vi.fn((title: string) => title),
  phaseProgress: vi.fn(() => ""),
  progressBar: vi.fn(() => ""),
  spinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
    warn: vi.fn(),
    text: "",
  })),
  ui: {
    logo: vi.fn(() => ""),
    banner: vi.fn(() => ""),
    box: vi.fn((content: string) => content),
    successBox: vi.fn((title: string, content?: string) =>
      content ? `${title}\n${content}` : title,
    ),
    errorBox: vi.fn((title: string, content?: string) =>
      content ? `${title}\n${content}` : title,
    ),
    warningBox: vi.fn((title: string, content?: string) =>
      content ? `${title}\n${content}` : title,
    ),
    headerBox: vi.fn((title: string) => title),
    table: vi.fn(() => ""),
    keyValueTable: vi.fn((data: Record<string, unknown>) =>
      Object.entries(data)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n"),
    ),
    statusIcon: vi.fn(() => ""),
    printStatus: vi.fn(),
    divider: vi.fn(() => "---"),
    sectionHeader: vi.fn((title: string) => title),
    phaseProgress: vi.fn(() => ""),
    progressBar: vi.fn(() => ""),
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
      warn: vi.fn(),
      text: "",
    })),
  },
}));

describe("statsCommand", () => {
  const mockLog: RunLog = {
    version: 1,
    runId: "12345678-1234-4234-a234-123456789abc",
    startTime: "2024-01-15T10:00:00.000Z",
    endTime: "2024-01-15T10:05:00.000Z",
    config: {
      phases: ["spec", "exec", "qa"],
      sequential: false,
      qualityLoop: false,
      maxIterations: 3,
    },
    issues: [
      {
        issueNumber: 123,
        title: "Test Issue 1",
        labels: ["bug"],
        status: "success",
        phases: [
          {
            phase: "spec",
            issueNumber: 123,
            startTime: "2024-01-15T10:00:00.000Z",
            endTime: "2024-01-15T10:01:00.000Z",
            durationSeconds: 60,
            status: "success",
          },
          {
            phase: "exec",
            issueNumber: 123,
            startTime: "2024-01-15T10:01:00.000Z",
            endTime: "2024-01-15T10:03:00.000Z",
            durationSeconds: 120,
            status: "success",
          },
        ],
        totalDurationSeconds: 180,
      },
      {
        issueNumber: 456,
        title: "Test Issue 2",
        labels: ["feature"],
        status: "failure",
        phases: [
          {
            phase: "spec",
            issueNumber: 456,
            startTime: "2024-01-15T10:03:00.000Z",
            endTime: "2024-01-15T10:04:00.000Z",
            durationSeconds: 60,
            status: "success",
          },
          {
            phase: "exec",
            issueNumber: 456,
            startTime: "2024-01-15T10:04:00.000Z",
            endTime: "2024-01-15T10:05:00.000Z",
            durationSeconds: 60,
            status: "failure",
            error: "Build failed",
          },
        ],
        totalDurationSeconds: 120,
      },
    ],
    summary: {
      totalIssues: 2,
      passed: 1,
      failed: 1,
      totalDurationSeconds: 300,
    },
  };

  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe("with no logs", () => {
    beforeEach(() => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([]);
    });

    it("should show no data message for human output", async () => {
      await statsCommand({});

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("No data found"),
      );
    });

    it("should output error JSON for --json", async () => {
      await statsCommand({ json: true });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"error"'),
      );
    });

    it("should output header only for --csv", async () => {
      await statsCommand({ csv: true });

      expect(consoleSpy).toHaveBeenCalledWith(
        "runId,startTime,duration,issues,passed,failed,phases",
      );
    });
  });

  describe("with logs", () => {
    beforeEach(() => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        "run-2024-01-15-abc.json",
      ]);
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() =>
        JSON.stringify(mockLog),
      );
    });

    it("should show statistics for human output", async () => {
      await statsCommand({});

      // New UI format uses SEQUANT ANALYTICS header
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("SEQUANT ANALYTICS"),
      );
      // Key-value table format: "Total Runs: 1"
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Total Runs: 1"),
      );
    });

    it("should output valid JSON for --json", async () => {
      await statsCommand({ json: true });

      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.totalRuns).toBe(1);
      expect(parsed.totalIssues).toBe(2);
      expect(parsed.passed).toBe(1);
      expect(parsed.failed).toBe(1);
      expect(parsed.successRate).toBe(50);
    });

    it("should output valid CSV for --csv", async () => {
      await statsCommand({ csv: true });

      const output = consoleSpy.mock.calls[0][0] as string;
      const lines = output.split("\n");

      expect(lines[0]).toBe(
        "runId,startTime,duration,issues,passed,failed,phases",
      );
      expect(lines[1]).toContain(mockLog.runId);
      expect(lines[1]).toContain('"spec;exec;qa"');
    });
  });

  describe("statistics calculation", () => {
    const mockLog2: RunLog = {
      ...mockLog,
      runId: "87654321-4321-4321-a321-cba987654321",
      summary: {
        totalIssues: 3,
        passed: 3,
        failed: 0,
        totalDurationSeconds: 600,
      },
      issues: [
        {
          issueNumber: 789,
          title: "Test Issue 3",
          labels: [],
          status: "success",
          phases: [
            {
              phase: "spec",
              issueNumber: 789,
              startTime: "2024-01-16T10:00:00.000Z",
              endTime: "2024-01-16T10:02:00.000Z",
              durationSeconds: 120,
              status: "success",
            },
          ],
          totalDurationSeconds: 120,
        },
      ],
    };

    beforeEach(() => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        "run-1.json",
        "run-2.json",
      ]);
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(
        (path: string) => {
          if (path.includes("run-1")) return JSON.stringify(mockLog);
          return JSON.stringify(mockLog2);
        },
      );
    });

    it("should aggregate statistics across multiple logs", async () => {
      await statsCommand({ json: true });

      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.totalRuns).toBe(2);
      // mockLog has 2 issues (1 pass, 1 fail), mockLog2 has 1 issue (1 pass)
      expect(parsed.totalIssues).toBe(3);
      expect(parsed.passed).toBe(2);
      expect(parsed.failed).toBe(1);
    });

    it("should calculate phase durations", async () => {
      await statsCommand({ json: true });

      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      // spec phase: 60s + 60s + 120s = 240s across 3 runs
      expect(parsed.phaseDurations.spec).toBeDefined();
      expect(parsed.phaseDurations.spec.count).toBe(3);
    });

    it("should track common failures", async () => {
      await statsCommand({ json: true });

      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(Object.keys(parsed.commonFailures).length).toBeGreaterThan(0);
      expect(parsed.commonFailures["exec: Build failed"]).toBe(1);
    });
  });

  describe("--detailed flag", () => {
    const mockLogWithQa: RunLog = {
      version: 1,
      runId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      startTime: "2026-02-10T10:00:00.000Z",
      endTime: "2026-02-10T10:30:00.000Z",
      config: {
        phases: ["spec", "exec", "qa"],
        sequential: false,
        qualityLoop: false,
        maxIterations: 3,
      },
      issues: [
        {
          issueNumber: 100,
          title: "Issue with QA pass",
          labels: ["enhancement"],
          status: "success",
          phases: [
            {
              phase: "qa",
              issueNumber: 100,
              startTime: "2026-02-10T10:20:00.000Z",
              endTime: "2026-02-10T10:25:00.000Z",
              durationSeconds: 300,
              status: "success",
              verdict: "READY_FOR_MERGE",
            },
          ],
          totalDurationSeconds: 1500,
        },
        {
          issueNumber: 101,
          title: "Issue with QA fail then pass",
          labels: ["bug"],
          status: "success",
          phases: [
            {
              phase: "qa",
              issueNumber: 101,
              startTime: "2026-02-10T10:10:00.000Z",
              endTime: "2026-02-10T10:15:00.000Z",
              durationSeconds: 300,
              status: "failure",
              verdict: "AC_NOT_MET",
              error: "AC_NOT_MET",
            },
            {
              phase: "qa",
              issueNumber: 101,
              startTime: "2026-02-10T10:25:00.000Z",
              endTime: "2026-02-10T10:30:00.000Z",
              durationSeconds: 300,
              status: "success",
              verdict: "READY_FOR_MERGE",
            },
          ],
          totalDurationSeconds: 1800,
        },
      ],
      summary: {
        totalIssues: 2,
        passed: 2,
        failed: 0,
        totalDurationSeconds: 1800,
      },
    };

    beforeEach(() => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        "run-2026-02-10-aaa.json",
      ]);
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() =>
        JSON.stringify(mockLogWithQa),
      );
    });

    it("should display QA verdict section when --detailed is set", async () => {
      await statsCommand({ detailed: true });

      // Should display QA section header
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("QA Verdicts"),
      );
    });

    it("should display weekly trends when --detailed is set", async () => {
      await statsCommand({ detailed: true });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Weekly Trends"),
      );
    });

    it("should display label segmentation when --detailed is set", async () => {
      await statsCommand({ detailed: true });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Success by Label"),
      );
    });

    it("should not display detailed sections without --detailed", async () => {
      await statsCommand({});

      const allCalls = consoleSpy.mock.calls.flat().join(" ");
      expect(allCalls).not.toContain("QA Verdicts");
      expect(allCalls).not.toContain("Weekly Trends");
      expect(allCalls).not.toContain("Success by Label");
    });

    it("--detailed with a filter that excludes all runs emits 'No matching runs'", async () => {
      // Human path short-circuits via emitNoMatchingRuns and returns before
      // the --detailed block runs, so detailed sections must not appear.
      await statsCommand({ detailed: true, label: "nonexistent" });

      const allCalls = consoleSpy.mock.calls.flat().join(" ");
      expect(allCalls).toContain("No matching runs");
      expect(allCalls).not.toContain("QA Verdicts");
      expect(allCalls).not.toContain("Weekly Trends");
      expect(allCalls).not.toContain("Success by Label");
    });
  });

  describe("--label and --since filters", () => {
    const jan: RunLog = {
      version: 1,
      runId: "11111111-1111-4111-a111-111111111111",
      startTime: "2026-01-10T10:00:00.000Z",
      endTime: "2026-01-10T10:05:00.000Z",
      config: {
        phases: ["spec", "exec", "qa"],
        sequential: false,
        qualityLoop: false,
        maxIterations: 3,
      },
      issues: [
        {
          issueNumber: 1,
          title: "Jan docs issue",
          labels: ["docs"],
          status: "success",
          phases: [],
          totalDurationSeconds: 300,
        },
      ],
      summary: {
        totalIssues: 1,
        passed: 1,
        failed: 0,
        totalDurationSeconds: 300,
      },
    };

    const mar: RunLog = {
      version: 1,
      runId: "22222222-2222-4222-a222-222222222222",
      startTime: "2026-03-15T10:00:00.000Z",
      endTime: "2026-03-15T10:05:00.000Z",
      config: {
        phases: ["spec", "exec", "qa"],
        sequential: false,
        qualityLoop: false,
        maxIterations: 3,
      },
      issues: [
        {
          issueNumber: 2,
          title: "March bug",
          labels: ["bug"],
          status: "success",
          phases: [],
          totalDurationSeconds: 300,
        },
      ],
      summary: {
        totalIssues: 1,
        passed: 1,
        failed: 0,
        totalDurationSeconds: 300,
      },
    };

    beforeEach(() => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        "run-jan.json",
        "run-mar.json",
      ]);
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(
        (path: string) =>
          path.includes("run-jan") ? JSON.stringify(jan) : JSON.stringify(mar),
      );
    });

    it("--label keeps only runs whose issues carry the label", async () => {
      await statsCommand({ json: true, label: "docs" });

      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.totalRuns).toBe(1);
      expect(parsed.totalIssues).toBe(1);
    });

    it("--label with no matches emits 'No matching runs' (zero-match)", async () => {
      await statsCommand({ json: true, label: "nonexistent" });

      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.error).toBe("No matching runs");
      expect(parsed.runs).toEqual([]);
    });

    it("--since drops runs with startTime before the cutoff", async () => {
      await statsCommand({ json: true, since: "2026-02-01" });

      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      // Only the March run survives the Feb cutoff
      expect(parsed.totalRuns).toBe(1);
    });

    it("--label and --since compose (AND, zero match)", async () => {
      // docs + after 2026-02-01: jan has docs but is too early → 0 matches
      await statsCommand({ json: true, label: "docs", since: "2026-02-01" });

      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.error).toBe("No matching runs");
    });

    it("--label and --since compose (AND, positive match)", async () => {
      // bug + after 2026-02-01: only mar matches both → 1 run
      await statsCommand({ json: true, label: "bug", since: "2026-02-01" });

      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.totalRuns).toBe(1);
      expect(parsed.totalIssues).toBe(1);
    });

    it("rejects an invalid --since date with a clear error and exit code 1", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const prevExitCode = process.exitCode;

      try {
        await statsCommand({ json: true, since: "not-a-date" });

        expect(errSpy).toHaveBeenCalledWith(
          expect.stringContaining("Invalid --since date"),
        );
        expect(process.exitCode).toBe(1);
      } finally {
        errSpy.mockRestore();
        process.exitCode = prevExitCode;
      }
    });
  });
});

/**
 * #986 AC-5 / AC-6 — the `sequant stats` cost surface.
 *
 * `metrics.tokensUsed` read 0 on 365/365 recorded runs, so the token panel was
 * dead and there was no per-phase or per-model spend view at all. These tests
 * drive `statsCommand` against two on-disk fixtures: one post-fix record with
 * `phaseUsage`/`costUSD`, and one copied verbatim from a real pre-fix
 * `.sequant/metrics.json` (no such fields) to prove old records still render.
 */
describe("#986 stats cost & usage by phase x model", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  /** Read a fixture with the REAL fs — `fs` is module-mocked in this file. */
  async function fixture(name: string): Promise<string> {
    const realFs = await vi.importActual<typeof import("fs")>("fs");
    return realFs.readFileSync(`src/commands/__fixtures__/${name}`, "utf-8");
  }

  /** Point `loadMetrics()` at a fixture and starve the run-log fallback. */
  function serveMetrics(json: string): void {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => String(p).endsWith("metrics.json"),
    );
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(
      () => json,
    );
    (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([]);
  }

  function output(): string {
    return consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
  }

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("986 renders a phase x model table with cost, by default", async () => {
    serveMetrics(await fixture("metrics-phase-usage-986.json"));

    await statsCommand({});
    const out = output();

    expect(out).toContain("Cost & Usage by Phase \u00D7 Model");
    // The SDK's own wording for costUSD — this is an estimate, and the panel
    // must say so rather than reading as an invoice.
    expect(out).toContain("SDK estimate, not a billing statement");
    expect(out).toContain("claude-fable-5");
    expect(out).toContain("claude-haiku-4-5-20251001");
    expect(out).toContain("claude-opus-5");
    // exec/claude-fable-5: 326 + 38515 input+output tokens, $10.2637.
    expect(out).toMatch(/exec\s+claude-fable-5\s+38,841\s+\$10\.2637/);
    expect(out).toContain("$12.3395");
  });

  it("986 folds the two qa executions into one row and reports the execution count", async () => {
    serveMetrics(await fixture("metrics-phase-usage-986.json"));

    await statsCommand({});

    // 1000+2000 and 3000+4000 across two qa executions on the same model.
    expect(output()).toMatch(/qa\s+claude-opus-5\s+10,000\s+\$2\.0000\s+2/);
  });

  it("986 exposes the same rollup under --json", async () => {
    serveMetrics(await fixture("metrics-phase-usage-986.json"));

    await statsCommand({ json: true });
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);

    expect(parsed.totalCostUSD).toBeCloseTo(12.339517, 6);
    expect(parsed.phaseModelUsage).toHaveLength(3);
    expect(parsed.phaseModelUsage[0]).toEqual({
      phase: "exec",
      model: "claude-fable-5",
      inputTokens: 326,
      outputTokens: 38515,
      cacheTokens: 2316899,
      costUSD: 10.263722,
      executions: 1,
    });
  });

  it("986 renders a pre-fix record without throwing, showing 0 / \u2014 for the missing fields (AC-6)", async () => {
    // Verbatim copy of a real record from .sequant/metrics.json, written
    // before costUSD/phaseUsage existed.
    const pre = await fixture("metrics-pre-986.json");
    expect(JSON.parse(pre).runs[0].metrics.phaseUsage).toBeUndefined();
    expect(JSON.parse(pre).runs[0].metrics.costUSD).toBeUndefined();
    serveMetrics(pre);

    await expect(statsCommand({})).resolves.toBeUndefined();
    const out = output();

    // Section still shown by default, with a placeholder rather than a
    // fabricated $0.00 — "not recorded" and "free" are different claims.
    expect(out).toContain("Cost & Usage by Phase \u00D7 Model");
    expect(out).toContain("SDK estimate, not a billing statement");
    expect(out).toContain("\u2014");
    expect(out).toContain("No per-phase usage recorded in these runs.");
    expect(out).not.toContain("$");
  });

  it("986 reports null cost under --json for a pre-fix record", async () => {
    serveMetrics(await fixture("metrics-pre-986.json"));

    await statsCommand({ json: true });
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);

    expect(parsed.phaseModelUsage).toEqual([]);
    expect(parsed.totalCostUSD).toBeNull();
  });
});
