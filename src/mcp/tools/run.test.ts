/**
 * Unit tests for sequant_run structured output (Issue #391)
 *
 * Tests buildStructuredResponse and readLatestRunLog directly
 * without MCP server infrastructure.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import { buildStructuredResponse, readLatestRunLog } from "./run.js";
import type { RunLog } from "../../lib/workflow/run-log-schema.js";

// Mock fs module for readLatestRunLog tests
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readdirSync: vi.fn(actual.readdirSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

const mockedFs = vi.mocked(fs);

function makeRunLog(overrides?: Partial<RunLog>): RunLog {
  return {
    version: 1,
    runId: "550e8400-e29b-41d4-a716-446655440000",
    startTime: "2026-03-23T10:00:00.000Z",
    endTime: "2026-03-23T10:05:00.000Z",
    config: {
      phases: ["spec", "exec", "qa"],
      sequential: false,
      qualityLoop: false,
      maxIterations: 3,
    },
    issues: [
      {
        issueNumber: 100,
        title: "Test issue 1",
        labels: ["enhancement"],
        status: "success",
        phases: [
          {
            phase: "spec",
            issueNumber: 100,
            startTime: "2026-03-23T10:00:00.000Z",
            endTime: "2026-03-23T10:01:00.000Z",
            durationSeconds: 60,
            status: "success",
          },
          {
            phase: "exec",
            issueNumber: 100,
            startTime: "2026-03-23T10:01:00.000Z",
            endTime: "2026-03-23T10:03:00.000Z",
            durationSeconds: 120,
            status: "success",
          },
          {
            phase: "qa",
            issueNumber: 100,
            startTime: "2026-03-23T10:03:00.000Z",
            endTime: "2026-03-23T10:04:00.000Z",
            durationSeconds: 60,
            status: "success",
            verdict: "READY_FOR_MERGE",
          },
        ],
        totalDurationSeconds: 240,
      },
      {
        issueNumber: 200,
        title: "Test issue 2",
        labels: ["bug"],
        status: "failure",
        phases: [
          {
            phase: "spec",
            issueNumber: 200,
            startTime: "2026-03-23T10:00:00.000Z",
            endTime: "2026-03-23T10:01:00.000Z",
            durationSeconds: 60,
            status: "success",
          },
          {
            phase: "exec",
            issueNumber: 200,
            startTime: "2026-03-23T10:01:00.000Z",
            endTime: "2026-03-23T10:02:30.000Z",
            durationSeconds: 90,
            status: "failure",
            error: "Build failed",
          },
        ],
        totalDurationSeconds: 150,
      },
    ],
    summary: {
      totalIssues: 2,
      passed: 1,
      failed: 1,
      totalDurationSeconds: 300,
    },
    ...overrides,
  };
}

describe("buildStructuredResponse", () => {
  // AC-1: Structured JSON with per-issue summaries
  it("should return structured JSON with per-issue summaries", () => {
    const runLog = makeRunLog();
    const response = buildStructuredResponse(runLog, "raw output", "success");

    expect(response.status).toBe("success");
    expect(response.issues).toHaveLength(2);
    expect(response.issues[0].issueNumber).toBe(100);
    expect(response.issues[1].issueNumber).toBe(200);
  });

  // AC-2: Each issue includes status, phases, verdict, duration
  it("should include status, phases, verdict, and duration per issue", () => {
    const runLog = makeRunLog();
    const response = buildStructuredResponse(runLog, "", "success");

    const issue1 = response.issues[0];
    expect(issue1.status).toBe("success");
    expect(issue1.phases).toHaveLength(3);
    expect(issue1.phases[0]).toEqual({
      phase: "spec",
      status: "success",
      durationSeconds: 60,
    });
    expect(issue1.verdict).toBe("READY_FOR_MERGE");
    expect(issue1.durationSeconds).toBe(240);

    const issue2 = response.issues[1];
    expect(issue2.status).toBe("failure");
    expect(issue2.phases).toHaveLength(2);
    expect(issue2.verdict).toBeUndefined();
    expect(issue2.durationSeconds).toBe(150);
  });

  // AC-2: verdict only present when QA ran
  it("should omit verdict when QA did not run", () => {
    const runLog = makeRunLog({
      issues: [
        {
          issueNumber: 300,
          title: "No QA issue",
          labels: [],
          status: "success",
          phases: [
            {
              phase: "exec",
              issueNumber: 300,
              startTime: "2026-03-23T10:00:00.000Z",
              endTime: "2026-03-23T10:01:00.000Z",
              durationSeconds: 60,
              status: "success",
            },
          ],
          totalDurationSeconds: 60,
        },
      ],
      summary: {
        totalIssues: 1,
        passed: 1,
        failed: 0,
        totalDurationSeconds: 60,
      },
    });
    const response = buildStructuredResponse(runLog, "", "success");

    expect(response.issues[0].verdict).toBeUndefined();
    // Ensure verdict key is not present at all
    expect("verdict" in response.issues[0]).toBe(false);
  });

  // AC-3: Raw output as secondary field
  it("should include rawOutput as secondary field", () => {
    const runLog = makeRunLog();
    const response = buildStructuredResponse(
      runLog,
      "some raw output",
      "success",
    );

    expect(response.rawOutput).toBe("some raw output");
  });

  it("should truncate rawOutput to 2000 chars", () => {
    const runLog = makeRunLog();
    const largeOutput = "x".repeat(5000);
    const response = buildStructuredResponse(runLog, largeOutput, "success");

    expect(response.rawOutput!.length).toBeLessThanOrEqual(2000);
  });

  // AC-6 (derived): Backwards-compatible status field
  it("should include status field for backwards compatibility", () => {
    const runLog = makeRunLog();

    const successResponse = buildStructuredResponse(runLog, "", "success");
    expect(successResponse.status).toBe("success");

    const failureResponse = buildStructuredResponse(
      runLog,
      "",
      "failure",
      1,
      "err",
    );
    expect(failureResponse.status).toBe("failure");
    expect(failureResponse.exitCode).toBe(1);
    expect(failureResponse.error).toBe("err");
  });

  it("should include summary statistics", () => {
    const runLog = makeRunLog();
    const response = buildStructuredResponse(runLog, "", "success");

    expect(response.summary).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      durationSeconds: 300,
    });
  });

  it("should include phases as comma-separated string", () => {
    const runLog = makeRunLog();
    const response = buildStructuredResponse(runLog, "", "success");

    expect(response.phases).toContain("spec");
    expect(response.phases).toContain("exec");
    expect(response.phases).toContain("qa");
  });

  // AC-4: Response size limits
  it("should enforce 64KB response size limit by truncating rawOutput", () => {
    const runLog = makeRunLog();
    // Create output larger than 64KB
    const hugeOutput = "x".repeat(100_000);
    const response = buildStructuredResponse(runLog, hugeOutput, "success");

    const responseJson = JSON.stringify(response);
    expect(responseJson.length).toBeLessThanOrEqual(64 * 1024);
  });

  // Edge case: empty run (0 issues)
  it("should handle empty run with 0 issues", () => {
    const runLog = makeRunLog({
      issues: [],
      summary: {
        totalIssues: 0,
        passed: 0,
        failed: 0,
        totalDurationSeconds: 0,
      },
    });
    const response = buildStructuredResponse(runLog, "", "success");

    expect(response.issues).toHaveLength(0);
    expect(response.summary.total).toBe(0);
  });

  // Edge case: single issue
  it("should handle single issue run", () => {
    const runLog = makeRunLog({
      issues: [
        {
          issueNumber: 42,
          title: "Single issue",
          labels: [],
          status: "success",
          phases: [
            {
              phase: "exec",
              issueNumber: 42,
              startTime: "2026-03-23T10:00:00.000Z",
              endTime: "2026-03-23T10:01:00.000Z",
              durationSeconds: 60,
              status: "success",
            },
          ],
          totalDurationSeconds: 60,
        },
      ],
      summary: {
        totalIssues: 1,
        passed: 1,
        failed: 0,
        totalDurationSeconds: 60,
      },
    });
    const response = buildStructuredResponse(runLog, "", "success");

    expect(response.issues).toHaveLength(1);
    expect(response.issues[0].issueNumber).toBe(42);
  });

  it("should not include exitCode when status is 0 (success)", () => {
    const runLog = makeRunLog();
    const response = buildStructuredResponse(runLog, "", "success", 0);

    expect(response.exitCode).toBeUndefined();
  });
});

// AC-5 (derived): Graceful fallback when log file unavailable
describe("readLatestRunLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return null when log directory does not exist", () => {
    mockedFs.existsSync.mockReturnValue(false);

    const result = readLatestRunLog();
    expect(result).toBeNull();
  });

  it("should return null when log directory is empty", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readdirSync.mockReturnValue([]);

    const result = readLatestRunLog();
    expect(result).toBeNull();
  });

  it("should return null when log file is corrupt", () => {
    mockedFs.existsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readdirSync.mockReturnValue(["run-2026-03-23-abc.json"] as any);
    mockedFs.readFileSync.mockReturnValue("not valid json{{{");

    const result = readLatestRunLog();
    expect(result).toBeNull();
  });

  it("should parse and return the most recent valid log file", () => {
    const runLog = makeRunLog();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readdirSync.mockReturnValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "run-2026-03-23T10-00-00-abc.json" as any,
    ]);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(runLog));

    const result = readLatestRunLog();
    expect(result).not.toBeNull();
    expect(result!.runId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(result!.issues).toHaveLength(2);
  });
});
