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
});
