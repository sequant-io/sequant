/**
 * Unit tests for sequant_run structured output (Issue #391)
 *
 * Tests buildStructuredResponse and readLatestRunLog directly
 * without MCP server infrastructure.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { buildStructuredResponse, readLatestRunLog } from "./run.js";
import type { RunLog } from "../../lib/workflow/run-log-schema.js";

// Mock fs.existsSync (still used synchronously in resolveLogDir)
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

// Mock fs/promises for async I/O
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    readFile: vi.fn(actual.readFile),
  };
});

const mockedExistsSync = vi.mocked(existsSync);
const mockedReaddir = vi.mocked(readdir);
const mockedReadFile = vi.mocked(readFile);

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

  // AC-4: Response size limits (uses Buffer.byteLength for accurate measurement)
  it("should enforce 64KB response size limit by truncating rawOutput", () => {
    const runLog = makeRunLog();
    // Create output larger than 64KB
    const hugeOutput = "x".repeat(100_000);
    const response = buildStructuredResponse(runLog, hugeOutput, "success");

    const responseJson = JSON.stringify(response);
    expect(Buffer.byteLength(responseJson, "utf-8")).toBeLessThanOrEqual(
      64 * 1024,
    );
  });

  it("should enforce size limit for multi-byte content", () => {
    const runLog = makeRunLog();
    // Each emoji is 4 bytes in UTF-8 but 2 chars (surrogate pair) in JS
    const emojiOutput = "\u{1F600}".repeat(20_000);
    const response = buildStructuredResponse(runLog, emojiOutput, "success");

    const responseJson = JSON.stringify(response);
    expect(Buffer.byteLength(responseJson, "utf-8")).toBeLessThanOrEqual(
      64 * 1024,
    );
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

  it("should not include exitCode when null", () => {
    const runLog = makeRunLog();
    const response = buildStructuredResponse(runLog, "", "success", null);

    expect(response.exitCode).toBeUndefined();
  });
});

// AC-5 (derived): Graceful fallback when log file unavailable
describe("readLatestRunLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return null when log directory does not exist", async () => {
    mockedExistsSync.mockReturnValue(false);

    const result = await readLatestRunLog();
    expect(result).toBeNull();
  });

  it("should return null when log directory is empty", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([]);

    const result = await readLatestRunLog();
    expect(result).toBeNull();
  });

  it("should return null when log file is corrupt", async () => {
    mockedExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedReaddir.mockResolvedValue([
      "run-2026-03-23T10-00-00-abc.json",
    ] as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedReadFile.mockResolvedValue("not valid json{{{" as any);

    const result = await readLatestRunLog();
    expect(result).toBeNull();
  });

  it("should parse and return the most recent valid log file", async () => {
    const runLog = makeRunLog();
    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "run-2026-03-23T10-00-00-abc.json" as any,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedReadFile.mockResolvedValue(JSON.stringify(runLog) as any);

    const result = await readLatestRunLog();
    expect(result).not.toBeNull();
    expect(result!.runId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(result!.issues).toHaveLength(2);
  });

  it("should filter out stale log files when runStartTime is provided", async () => {
    const runLog = makeRunLog();
    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "run-2026-03-23T10-00-00-abc.json" as any, // 10:00 — recent
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "run-2026-03-22T08-00-00-old.json" as any, // yesterday — stale
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedReadFile.mockResolvedValue(JSON.stringify(runLog) as any);

    // Run started at 10:00 — only the 10:00 log should match
    const runStartTime = new Date("2026-03-23T10:00:00.000Z");
    const result = await readLatestRunLog(runStartTime);
    expect(result).not.toBeNull();
  });

  it("should return null when all log files are stale", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "run-2026-03-22T08-00-00-old.json" as any,
    ]);

    // Run started now — yesterday's log is too old
    const runStartTime = new Date("2026-03-23T10:00:00.000Z");
    const result = await readLatestRunLog(runStartTime);
    expect(result).toBeNull();
  });

  it("should return all files when no runStartTime is provided", async () => {
    const runLog = makeRunLog();
    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "run-2026-03-22T08-00-00-old.json" as any,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedReadFile.mockResolvedValue(JSON.stringify(runLog) as any);

    // No runStartTime — should include all files
    const result = await readLatestRunLog();
    expect(result).not.toBeNull();
  });

  it("should handle readdir rejection gracefully", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockRejectedValue(new Error("EACCES: permission denied"));

    const result = await readLatestRunLog();
    expect(result).toBeNull();
  });
});
