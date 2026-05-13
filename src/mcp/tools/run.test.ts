/**
 * Unit tests for sequant_run MCP tool (Issues #391, #435)
 *
 * Tests buildStructuredResponse, readLatestRunLog, and progress notification
 * functions (parseProgressLine, createLineBuffer, formatProgressMessage)
 * directly without MCP server infrastructure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import {
  buildStructuredResponse,
  readLatestRunLog,
  readRunLogById,
  resolveRunLog,
  parseProgressLine,
  parseRunIdLine,
  createLineBuffer,
  createRunIdCapture,
  formatProgressMessage,
  spawnAsync,
  PHASE_TIMEOUT,
  MAX_TOTAL_TIMEOUT,
} from "./run.js";
import type { ProgressEvent } from "./run.js";
import type { RunLog } from "../../lib/workflow/run-log-schema.js";
import {
  emitProgressLine,
  emitRunIdLine,
} from "../../lib/workflow/batch-executor.js";

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
    mockedReaddir.mockRejectedValue(new Error("ENOENT"));

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

// ── Issue #435: Progress notification tests ──────────────────────────

describe("parseProgressLine", () => {
  it("should parse a valid start event", () => {
    const line =
      'SEQUANT_PROGRESS:{"issue":325,"phase":"spec","event":"start"}';
    const result = parseProgressLine(line);
    expect(result).toEqual({
      issue: 325,
      phase: "spec",
      event: "start",
    });
  });

  it("should parse a valid complete event with durationSeconds", () => {
    const line =
      'SEQUANT_PROGRESS:{"issue":325,"phase":"spec","event":"complete","durationSeconds":45}';
    const result = parseProgressLine(line);
    expect(result).toEqual({
      issue: 325,
      phase: "spec",
      event: "complete",
      durationSeconds: 45,
    });
  });

  it("should parse a valid failed event with error", () => {
    const line =
      'SEQUANT_PROGRESS:{"issue":325,"phase":"exec","event":"failed","error":"timeout"}';
    const result = parseProgressLine(line);
    expect(result).toEqual({
      issue: 325,
      phase: "exec",
      event: "failed",
      error: "timeout",
    });
  });

  it("should return null for non-progress lines", () => {
    expect(parseProgressLine("some random stderr output")).toBeNull();
    expect(parseProgressLine("")).toBeNull();
    expect(parseProgressLine("SEQUANT_OTHER:data")).toBeNull();
  });

  it("should return null for invalid JSON after prefix", () => {
    expect(parseProgressLine("SEQUANT_PROGRESS:{invalid json}")).toBeNull();
  });

  it("should return null when required fields are missing", () => {
    // Missing event field (required in new schema)
    expect(
      parseProgressLine('SEQUANT_PROGRESS:{"issue":1,"phase":"spec"}'),
    ).toBeNull();
    // Missing phase field
    expect(
      parseProgressLine('SEQUANT_PROGRESS:{"issue":1,"event":"start"}'),
    ).toBeNull();
    // Missing issue field
    expect(
      parseProgressLine('SEQUANT_PROGRESS:{"phase":"spec","event":"start"}'),
    ).toBeNull();
  });

  it("should return null for invalid event type", () => {
    expect(
      parseProgressLine(
        'SEQUANT_PROGRESS:{"issue":1,"phase":"spec","event":"unknown"}',
      ),
    ).toBeNull();
  });

  it("should ignore non-numeric durationSeconds", () => {
    const line =
      'SEQUANT_PROGRESS:{"issue":1,"phase":"spec","event":"complete","durationSeconds":"fast"}';
    const result = parseProgressLine(line);
    expect(result).toEqual({
      issue: 1,
      phase: "spec",
      event: "complete",
    });
    expect(result?.durationSeconds).toBeUndefined();
  });
});

describe("createLineBuffer", () => {
  it("should yield complete lines from a single chunk", () => {
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));

    buffer("line1\nline2\n");
    expect(lines).toEqual(["line1", "line2"]);
  });

  it("should handle partial chunks across multiple calls", () => {
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));

    buffer("SEQUANT_PRO");
    expect(lines).toEqual([]); // no complete line yet

    buffer("GRESS:{}\n");
    expect(lines).toEqual(["SEQUANT_PROGRESS:{}"]);
  });

  it("should handle multiple lines in a single chunk", () => {
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));

    buffer("a\nb\nc\n");
    expect(lines).toEqual(["a", "b", "c"]);
  });

  it("should skip empty lines", () => {
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));

    buffer("a\n\nb\n");
    // empty string between \n\n should be skipped
    expect(lines).toEqual(["a", "b"]);
  });

  it("should hold incomplete trailing content until next chunk", () => {
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));

    buffer("hello\nworld");
    expect(lines).toEqual(["hello"]);
    // "world" is buffered, not emitted

    buffer(" end\n");
    expect(lines).toEqual(["hello", "world end"]);
  });
});

describe("formatProgressMessage", () => {
  it("should format start events", () => {
    const event: ProgressEvent = {
      issue: 325,
      phase: "spec",
      event: "start",
    };
    expect(formatProgressMessage(event)).toBe("#325: spec started");
  });

  it("should format complete events with duration", () => {
    const event: ProgressEvent = {
      issue: 325,
      phase: "spec",
      event: "complete",
      durationSeconds: 45,
    };
    expect(formatProgressMessage(event)).toBe("#325: spec \u2713 (45s)");
  });

  it("should format complete events without duration", () => {
    const event: ProgressEvent = {
      issue: 325,
      phase: "exec",
      event: "complete",
    };
    expect(formatProgressMessage(event)).toBe("#325: exec \u2713");
  });

  it("should format failed events with error", () => {
    const event: ProgressEvent = {
      issue: 384,
      phase: "exec",
      event: "failed",
      error: "timeout",
    };
    expect(formatProgressMessage(event)).toBe(
      "#384: exec \u2717 \u2014 timeout",
    );
  });

  it("should format failed events without error", () => {
    const event: ProgressEvent = {
      issue: 384,
      phase: "qa",
      event: "failed",
    };
    expect(formatProgressMessage(event)).toBe("#384: qa \u2717");
  });
});

describe("spawnAsync timeout reset (AC-4)", () => {
  it("should export PHASE_TIMEOUT and MAX_TOTAL_TIMEOUT constants", () => {
    expect(PHASE_TIMEOUT).toBe(1_800_000); // 30 minutes
    expect(MAX_TOTAL_TIMEOUT).toBe(7_200_000); // 2 hours
  });

  it("should kill process after timeout with no progress", async () => {
    await expect(
      spawnAsync("sleep", ["10"], {
        timeout: 100,
      }),
    ).rejects.toThrow("Process timed out after 100ms");
  });

  it("should reset timeout when SEQUANT_PROGRESS lines arrive on stderr", async () => {
    let progressCalls = 0;

    // This process emits SEQUANT_PROGRESS lines on stderr every 100ms
    // and runs for ~500ms total. With a 300ms timeout and progress
    // resets, it should complete successfully instead of timing out.
    const result = await spawnAsync(
      "bash",
      [
        "-c",
        'for i in 1 2 3 4 5; do echo "SEQUANT_PROGRESS:{\"issue\":1,\"phase\":\"spec\",\"event\":\"start\"}" >&2; sleep 0.1; done; echo done',
      ],
      {
        timeout: 300,
        onProgress: () => {
          progressCalls++;
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("done");
    expect(progressCalls).toBeGreaterThan(0);
  }, 5000);

  it("should respect per-phase timeout when no progress arrives (with onProgress)", async () => {
    // onProgress is set but the process never emits progress lines,
    // so the per-phase timeout fires.
    await expect(
      spawnAsync("sleep", ["10"], {
        timeout: 50,
        onProgress: () => {},
      }),
    ).rejects.toThrow("no progress for 50ms");
  });

  it("should behave identically without onProgress (AC-5)", async () => {
    await expect(
      spawnAsync("sleep", ["10"], {
        timeout: 50,
      }),
    ).rejects.toThrow("Process timed out after 50ms");
  });

  it("should hit total ceiling when remaining <= 0 at schedule time", async () => {
    // Use maxTotalTimeout: 0 so the very first scheduleTimeout call
    // sees remaining <= 0 and takes the immediate-kill path.
    // This is deterministic — no real-clock race.
    await expect(
      spawnAsync("sleep", ["10"], {
        timeout: 500,
        maxTotalTimeout: 0,
        onProgress: () => {},
      }),
    ).rejects.toThrow(/Process timed out.*ceiling of 0ms/);
  });
});

describe("emitProgressLine (AC-8)", () => {
  const originalEnv = process.env.SEQUANT_ORCHESTRATOR;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SEQUANT_ORCHESTRATOR;
    } else {
      process.env.SEQUANT_ORCHESTRATOR = originalEnv;
    }
  });

  it("should emit start event to stderr when orchestrated", () => {
    process.env.SEQUANT_ORCHESTRATOR = "mcp-server";
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    emitProgressLine(325, "spec", "start");

    expect(writeSpy).toHaveBeenCalledOnce();
    const output = writeSpy.mock.calls[0][0] as string;
    const parsed = parseProgressLine(output.trim());
    expect(parsed).toEqual({
      issue: 325,
      phase: "spec",
      event: "start",
    });
  });

  it("should emit complete event with durationSeconds", () => {
    process.env.SEQUANT_ORCHESTRATOR = "mcp-server";
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    emitProgressLine(325, "spec", "complete", { durationSeconds: 45 });

    const output = writeSpy.mock.calls[0][0] as string;
    const parsed = parseProgressLine(output.trim());
    expect(parsed).toEqual({
      issue: 325,
      phase: "spec",
      event: "complete",
      durationSeconds: 45,
    });
  });

  it("should emit failed event with error", () => {
    process.env.SEQUANT_ORCHESTRATOR = "mcp-server";
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    emitProgressLine(325, "exec", "failed", { error: "timeout" });

    const output = writeSpy.mock.calls[0][0] as string;
    const parsed = parseProgressLine(output.trim());
    expect(parsed).toEqual({
      issue: 325,
      phase: "exec",
      event: "failed",
      error: "timeout",
    });
  });

  it("should not emit when SEQUANT_ORCHESTRATOR is not set", () => {
    delete process.env.SEQUANT_ORCHESTRATOR;
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    emitProgressLine(325, "spec", "start");

    expect(writeSpy).not.toHaveBeenCalled();
  });
});

// ── Issue #631: runId threading to defeat log-file lookup races ───────

describe("parseRunIdLine (#631 AC-1, AC-3)", () => {
  it("should parse a valid UUID v4 runId line", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(parseRunIdLine(`SEQUANT_RUN_ID:${id}`)).toBe(id);
  });

  it("should trim trailing whitespace before validating", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(parseRunIdLine(`SEQUANT_RUN_ID:${id} `)).toBe(id);
  });

  it("should return null for non-runId lines", () => {
    expect(parseRunIdLine("")).toBeNull();
    expect(parseRunIdLine("SEQUANT_OTHER:abc")).toBeNull();
    expect(
      parseRunIdLine(
        'SEQUANT_PROGRESS:{"issue":1,"phase":"spec","event":"start"}',
      ),
    ).toBeNull();
  });

  it("should reject payloads that are not well-formed UUIDs", () => {
    expect(parseRunIdLine("SEQUANT_RUN_ID:not-a-uuid")).toBeNull();
    expect(parseRunIdLine("SEQUANT_RUN_ID:")).toBeNull();
    expect(parseRunIdLine("SEQUANT_RUN_ID:550e8400")).toBeNull();
  });
});

describe("readRunLogById (#631 AC-2, AC-5, AC-6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return null when no file matches the runId suffix", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "run-2026-03-23T10-00-00-other-uuid.json" as any,
    ]);

    const result = await readRunLogById("550e8400-e29b-41d4-a716-446655440000");
    expect(result).toBeNull();
  });

  it("should return the log file whose name ends with -<runId>.json", async () => {
    const runId = "550e8400-e29b-41d4-a716-446655440000";
    const runLog = makeRunLog({ runId });
    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      `run-2026-03-23T10-00-00-${runId}.json` as any,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedReadFile.mockResolvedValue(JSON.stringify(runLog) as any);

    const result = await readRunLogById(runId);
    expect(result).not.toBeNull();
    expect(result!.runId).toBe(runId);
  });

  // AC-5: Two concurrent runs — each lookup returns its own log,
  // regardless of which filename `.sort().reverse()` would prefer.
  it("should return the caller's own log when concurrent run logs coexist", async () => {
    const runIdA = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const runIdB = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    const logA = makeRunLog({ runId: runIdA });
    const logB = makeRunLog({ runId: runIdB });

    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([
      // Both filenames pass `readLatestRunLog`'s 5-minute window; without
      // runId lookup, `.sort().reverse()` would return runIdB's file for both.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      `run-2026-03-23T10-00-00-${runIdA}.json` as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      `run-2026-03-23T10-00-01-${runIdB}.json` as any,
    ]);
    mockedReadFile.mockImplementation(async (path) => {
      const name = String(path);
      if (name.endsWith(`-${runIdA}.json`)) return JSON.stringify(logA);
      if (name.endsWith(`-${runIdB}.json`)) return JSON.stringify(logB);
      throw new Error(`Unexpected read: ${name}`);
    });

    const resultA = await readRunLogById(runIdA);
    const resultB = await readRunLogById(runIdB);
    expect(resultA!.runId).toBe(runIdA);
    expect(resultB!.runId).toBe(runIdB);
  });

  // AC-6: A stale same-issue log from the last 5 minutes does not bleed
  // into a fresh run when the fresh runId is used for lookup.
  it("should not return a stale same-issue log when looked up by fresh runId", async () => {
    // UUID v4 group 4 must start with 8/9/a/b for zod's .uuid() to accept it.
    const staleRunId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const freshRunId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const freshLog = makeRunLog({ runId: freshRunId });

    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([
      // Stale file is lexicographically *later* than the fresh one — without
      // runId lookup, `readLatestRunLog` would return it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      `run-2026-03-23T10-00-00-${freshRunId}.json` as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      `run-2026-03-23T10-02-00-${staleRunId}.json` as any,
    ]);
    mockedReadFile.mockImplementation(async (path) => {
      const name = String(path);
      if (name.endsWith(`-${freshRunId}.json`)) return JSON.stringify(freshLog);
      throw new Error(`Should not read stale log: ${name}`);
    });

    const result = await readRunLogById(freshRunId);
    expect(result).not.toBeNull();
    expect(result!.runId).toBe(freshRunId);
  });

  it("should return null on parse failure", async () => {
    const runId = "550e8400-e29b-41d4-a716-446655440000";
    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      `run-2026-03-23T10-00-00-${runId}.json` as any,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedReadFile.mockResolvedValue("not-json{{{" as any);

    const result = await readRunLogById(runId);
    expect(result).toBeNull();
  });

  it("should return null on readdir rejection", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockRejectedValue(new Error("EACCES"));

    const result = await readRunLogById("550e8400-e29b-41d4-a716-446655440000");
    expect(result).toBeNull();
  });
});

describe("emitRunIdLine (#631 AC-1)", () => {
  const originalEnv = process.env.SEQUANT_ORCHESTRATOR;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SEQUANT_ORCHESTRATOR;
    } else {
      process.env.SEQUANT_ORCHESTRATOR = originalEnv;
    }
  });

  it("should emit a SEQUANT_RUN_ID line with the runId when orchestrated", () => {
    process.env.SEQUANT_ORCHESTRATOR = "mcp-server";
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const runId = "550e8400-e29b-41d4-a716-446655440000";

    emitRunIdLine(runId);

    expect(writeSpy).toHaveBeenCalledOnce();
    const output = writeSpy.mock.calls[0][0] as string;
    expect(output).toBe(`SEQUANT_RUN_ID:${runId}\n`);
    expect(parseRunIdLine(output.trim())).toBe(runId);
  });

  it("should not emit when SEQUANT_ORCHESTRATOR is not set", () => {
    delete process.env.SEQUANT_ORCHESTRATOR;
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    emitRunIdLine("550e8400-e29b-41d4-a716-446655440000");

    expect(writeSpy).not.toHaveBeenCalled();
  });

  // AC-1: runId line must precede the first SEQUANT_PROGRESS line so the
  // MCP buffer captures it before any progress event arrives.
  it("should be emittable before emitProgressLine (ordering invariant)", () => {
    process.env.SEQUANT_ORCHESTRATOR = "mcp-server";
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const runId = "550e8400-e29b-41d4-a716-446655440000";

    emitRunIdLine(runId);
    emitProgressLine(1, "spec", "start");

    expect(writeSpy).toHaveBeenCalledTimes(2);
    const first = writeSpy.mock.calls[0][0] as string;
    const second = writeSpy.mock.calls[1][0] as string;
    expect(parseRunIdLine(first.trim())).toBe(runId);
    expect(parseProgressLine(second.trim())).toEqual({
      issue: 1,
      phase: "spec",
      event: "start",
    });
  });
});

// ── Issue #631 follow-up: QA gap closure ──────────────────────────────
//
// Gap 1: extracted `createRunIdCapture` factory makes the capture logic
//        testable in integration with the real `createLineBuffer` so
//        AC-5/AC-6 are exercised end-to-end at the wire-protocol level,
//        not just against the helper in isolation.
// Gap 2: `resolveRunLog` makes the `readRunLogById ?? readLatestRunLog`
//        fallback chain directly testable.
// Gap 3: lookup-miss with a captured runId now emits a debug line on the
//        MCP server's stderr (`console.error`) so the silent fallback is
//        observable; covered by `resolveRunLog` tests.

describe("createRunIdCapture (#631 follow-up)", () => {
  it("returns null until a SEQUANT_RUN_ID line is seen", () => {
    const { routeLine, getCapturedRunId } = createRunIdCapture();
    expect(getCapturedRunId()).toBeNull();
    expect(routeLine("some unrelated stderr noise")).toBeNull();
    expect(getCapturedRunId()).toBeNull();
  });

  it("captures the first valid SEQUANT_RUN_ID line and returns null for it", () => {
    const runId = "550e8400-e29b-41d4-a716-446655440000";
    const { routeLine, getCapturedRunId } = createRunIdCapture();
    expect(routeLine(`SEQUANT_RUN_ID:${runId}`)).toBeNull();
    expect(getCapturedRunId()).toBe(runId);
  });

  it("captures only the first valid runId (subsequent runId lines are passed through as non-progress)", () => {
    const runIdA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const runIdB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const { routeLine, getCapturedRunId } = createRunIdCapture();
    routeLine(`SEQUANT_RUN_ID:${runIdA}`);
    // After capture, the runId guard is closed; a second runId line
    // would be passed to parseProgressLine and yield null (not a progress
    // line), but the captured value is unchanged.
    expect(routeLine(`SEQUANT_RUN_ID:${runIdB}`)).toBeNull();
    expect(getCapturedRunId()).toBe(runIdA);
  });

  it("falls through to parseProgressLine for progress events (after capture)", () => {
    const runId = "550e8400-e29b-41d4-a716-446655440000";
    const { routeLine } = createRunIdCapture();
    routeLine(`SEQUANT_RUN_ID:${runId}`);
    const event = routeLine(
      'SEQUANT_PROGRESS:{"issue":42,"phase":"qa","event":"start"}',
    );
    expect(event).toEqual({ issue: 42, phase: "qa", event: "start" });
  });

  it("falls through to parseProgressLine for progress events (before capture)", () => {
    // Defensive: if a progress event somehow precedes the runId line, we
    // still surface it (capture remains open for a later runId line).
    const { routeLine, getCapturedRunId } = createRunIdCapture();
    const event = routeLine(
      'SEQUANT_PROGRESS:{"issue":1,"phase":"spec","event":"complete"}',
    );
    expect(event).toEqual({ issue: 1, phase: "spec", event: "complete" });
    expect(getCapturedRunId()).toBeNull();
  });

  it("rejects malformed runId payloads and stays uncaptured", () => {
    const { routeLine, getCapturedRunId } = createRunIdCapture();
    expect(routeLine("SEQUANT_RUN_ID:not-a-uuid")).toBeNull();
    expect(getCapturedRunId()).toBeNull();
  });
});

describe("createRunIdCapture + createLineBuffer integration (#631 AC-3, AC-5, AC-6)", () => {
  // Gap 1 closure: exercise the actual wire-protocol path used by
  // `registerRunTool` — chunk boundaries, line buffering, capture, and
  // fall-through — instead of testing the helper in isolation.

  it("captures runId when the SEQUANT_RUN_ID line is split across chunk boundaries", () => {
    const runId = "550e8400-e29b-41d4-a716-446655440000";
    const { routeLine, getCapturedRunId } = createRunIdCapture();
    const buffer = createLineBuffer((line) => {
      routeLine(line);
    });
    // First chunk has the prefix only; second chunk completes the line.
    buffer("SEQUANT_RUN_");
    expect(getCapturedRunId()).toBeNull();
    buffer(`ID:${runId}\n`);
    expect(getCapturedRunId()).toBe(runId);
  });

  it("captures runId and forwards subsequent progress events from the same buffer", () => {
    const runId = "550e8400-e29b-41d4-a716-446655440000";
    const events: ProgressEvent[] = [];
    const { routeLine, getCapturedRunId } = createRunIdCapture();
    const buffer = createLineBuffer((line) => {
      const event = routeLine(line);
      if (event) events.push(event);
    });
    // Realistic chunk shape: runId then several progress events in one chunk.
    buffer(
      `SEQUANT_RUN_ID:${runId}\n` +
        'SEQUANT_PROGRESS:{"issue":1,"phase":"spec","event":"start"}\n' +
        'SEQUANT_PROGRESS:{"issue":1,"phase":"spec","event":"complete","durationSeconds":2}\n',
    );
    expect(getCapturedRunId()).toBe(runId);
    expect(events).toEqual([
      { issue: 1, phase: "spec", event: "start" },
      {
        issue: 1,
        phase: "spec",
        event: "complete",
        durationSeconds: 2,
      },
    ]);
  });

  // AC-5 (Gap 1 closure): full stream-driven scenario. Two captures with
  // different runIds resolve to different logs even though both filenames
  // are present in the log dir and the wrong one would win `.sort().reverse()`.
  it("end-to-end: two concurrent captures resolve to their own logs (AC-5)", async () => {
    const runIdA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const runIdB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const logA = makeRunLog({ runId: runIdA });
    const logB = makeRunLog({ runId: runIdB });

    // Both files present; runIdB filename sorts later — would win `readLatestRunLog`.
    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      `run-2026-03-23T10-00-00-${runIdA}.json` as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      `run-2026-03-23T10-00-01-${runIdB}.json` as any,
    ]);
    mockedReadFile.mockImplementation(async (path) => {
      const name = String(path);
      if (name.endsWith(`-${runIdA}.json`)) return JSON.stringify(logA);
      if (name.endsWith(`-${runIdB}.json`)) return JSON.stringify(logB);
      throw new Error(`Unexpected read: ${name}`);
    });

    // Caller A: drive a real stderr stream and resolve via its captured runId.
    const captureA = createRunIdCapture();
    const bufferA = createLineBuffer((line) => {
      captureA.routeLine(line);
    });
    bufferA(`SEQUANT_RUN_ID:${runIdA}\n`);
    const resolvedA = await resolveRunLog(
      captureA.getCapturedRunId(),
      new Date(),
    );
    expect(resolvedA?.runId).toBe(runIdA);

    // Caller B: same dir, different runId — must NOT see A's log.
    const captureB = createRunIdCapture();
    const bufferB = createLineBuffer((line) => {
      captureB.routeLine(line);
    });
    bufferB(`SEQUANT_RUN_ID:${runIdB}\n`);
    const resolvedB = await resolveRunLog(
      captureB.getCapturedRunId(),
      new Date(),
    );
    expect(resolvedB?.runId).toBe(runIdB);
  });

  // AC-6 (Gap 1 closure): a stale same-issue log present in the dir does
  // not bleed into a fresh capture. End-to-end through stream + capture +
  // resolveRunLog. `mockedReadFile` throws on the stale path so a
  // regression that reads it (e.g. fallback firing unexpectedly) fails
  // loudly.
  it("end-to-end: a stale same-issue log is not returned for a fresh capture (AC-6)", async () => {
    const staleRunId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const freshRunId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const freshLog = makeRunLog({ runId: freshRunId });

    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([
      // Fresh file lexicographically *earlier* — stale would win readLatestRunLog.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      `run-2026-03-23T10-00-00-${freshRunId}.json` as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      `run-2026-03-23T10-02-00-${staleRunId}.json` as any,
    ]);
    mockedReadFile.mockImplementation(async (path) => {
      const name = String(path);
      if (name.endsWith(`-${freshRunId}.json`)) return JSON.stringify(freshLog);
      throw new Error(`Should not read stale log: ${name}`);
    });

    const capture = createRunIdCapture();
    const buffer = createLineBuffer((line) => {
      capture.routeLine(line);
    });
    buffer(`SEQUANT_RUN_ID:${freshRunId}\n`);

    const resolved = await resolveRunLog(
      capture.getCapturedRunId(),
      new Date(),
    );
    expect(resolved?.runId).toBe(freshRunId);
  });
});

describe("resolveRunLog (#631 follow-up — Gap 2 / Gap 3)", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Silence + capture the debug line emitted on lookup-miss fallback.
    consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("returns the runId-matched log when capturedRunId is set and lookup hits", async () => {
    const runId = "550e8400-e29b-41d4-a716-446655440000";
    const log = makeRunLog({ runId });
    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      `run-2026-03-23T10-00-00-${runId}.json` as any,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedReadFile.mockResolvedValue(JSON.stringify(log) as any);

    const result = await resolveRunLog(runId, new Date());
    expect(result?.runId).toBe(runId);
    // No fallback warning when the lookup succeeds.
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("falls back to readLatestRunLog when capturedRunId is set but lookup misses (Gap 2 + Gap 3)", async () => {
    const capturedRunId = "550e8400-e29b-41d4-a716-446655440000";
    const otherRunId = "11111111-1111-4111-8111-111111111111";
    const otherLog = makeRunLog({ runId: otherRunId });
    const runStartTime = new Date();

    mockedExistsSync.mockReturnValue(true);
    // Only the other run's file is on disk — lookup by capturedRunId misses.
    // Filename timestamp is set so readLatestRunLog's recency filter accepts it.
    const fileName = `run-${runStartTime
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19)}-${otherRunId}.json`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedReaddir.mockResolvedValue([fileName as any]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedReadFile.mockResolvedValue(JSON.stringify(otherLog) as any);

    const result = await resolveRunLog(capturedRunId, runStartTime);
    // Fell back to readLatestRunLog and returned the other-run log.
    expect(result?.runId).toBe(otherRunId);
    // Debug line emitted so the silent fallback is observable.
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const message = String(consoleErrorSpy.mock.calls[0][0]);
    expect(message).toContain(capturedRunId);
    expect(message).toContain("lookup miss");
  });

  it("goes straight to readLatestRunLog when capturedRunId is null (no debug log)", async () => {
    const runId = "22222222-2222-4222-8222-222222222222";
    const log = makeRunLog({ runId });
    const runStartTime = new Date();

    mockedExistsSync.mockReturnValue(true);
    const fileName = `run-${runStartTime
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19)}-${runId}.json`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedReaddir.mockResolvedValue([fileName as any]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedReadFile.mockResolvedValue(JSON.stringify(log) as any);

    const result = await resolveRunLog(null, runStartTime);
    expect(result?.runId).toBe(runId);
    // No runId was captured, so the lookup-miss debug line should not fire.
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("returns null when both the runId lookup and the time-window fallback miss", async () => {
    const capturedRunId = "550e8400-e29b-41d4-a716-446655440000";
    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([]);

    const result = await resolveRunLog(capturedRunId, new Date());
    expect(result).toBeNull();
    // Debug line still fires for the missed runId before the empty fallback.
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
  });
});
