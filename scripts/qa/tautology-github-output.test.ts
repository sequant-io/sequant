/**
 * Unit tests for the CI `--github` output helpers (#940 AC-2, AC-3)
 *
 * Nothing previously pinned the `::warning` annotation format or the
 * TAUTOLOGY_SUMMARY marker's JSON shape — only live CI runs and manual
 * verification covered them. A future refactor of either format could
 * silently break Phase A's FP-rate accounting with no test going red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { TautologyFileResult } from "../../src/lib/test-tautology-detector.js";
import {
  emitGithubAnnotations,
  emitGithubStepSummary,
  summaryMarker,
} from "./tautology-detector-cli.js";

function fileResult(
  overrides: Partial<TautologyFileResult> = {},
): TautologyFileResult {
  return {
    filePath: "src/lib/foo.test.ts",
    totalTests: 1,
    tautologicalCount: 0,
    tautologicalPercentage: 0,
    testBlocks: [],
    importedFunctions: [],
    parseSuccess: true,
    ...overrides,
  };
}

describe("summaryMarker (#940 AC-3)", () => {
  it("emits an HTML-comment-wrapped, greppable JSON line with all fields", () => {
    const marker = summaryMarker({
      pr: 940,
      filesScanned: 2,
      totalTests: 4,
      findings: 1,
      skipped: 0,
      score: 0.25,
    });

    expect(marker).toMatch(/^<!-- TAUTOLOGY_SUMMARY \{.*\} -->$/);
    const json = marker
      .replace("<!-- TAUTOLOGY_SUMMARY ", "")
      .replace(" -->", "");
    expect(JSON.parse(json)).toEqual({
      pr: 940,
      filesScanned: 2,
      totalTests: 4,
      findings: 1,
      skipped: 0,
      score: 0.25,
    });
  });

  it("carries the reason field for skip cases (base-not-found / no-test-files)", () => {
    const marker = summaryMarker({
      filesScanned: 0,
      totalTests: 0,
      findings: 0,
      skipped: 0,
      score: 0,
      reason: "no-test-files",
    });
    const json = JSON.parse(
      marker.replace("<!-- TAUTOLOGY_SUMMARY ", "").replace(" -->", ""),
    );
    expect(json.reason).toBe("no-test-files");
    expect(json.pr).toBeUndefined();
  });
});

describe("emitGithubAnnotations (#940 AC-2)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits one ::warning line per tautological block, in workflow-command format", () => {
    const results = [
      fileResult({
        filePath: "src/lib/foo.test.ts",
        testBlocks: [
          {
            description: "is tautological",
            lineNumber: 4,
            isTautological: true,
            style: "it",
          },
        ],
      }),
    ];

    emitGithubAnnotations(results);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      '::warning file=src/lib/foo.test.ts,line=4,title=Tautological test::it("is tautological") — no production function calls',
    );
  });

  it("skips non-tautological blocks — no annotation for real tests", () => {
    const results = [
      fileResult({
        testBlocks: [
          {
            description: "calls production code",
            lineNumber: 10,
            isTautological: false,
            style: "test",
          },
        ],
      }),
    ];

    emitGithubAnnotations(results);

    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("emitGithubStepSummary (#940 AC-2, AC-3)", () => {
  let tmpDir: string;
  let summaryFile: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalSummaryEnv = process.env.GITHUB_STEP_SUMMARY;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tautology-summary-"));
    summaryFile = join(tmpDir, "summary.md");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalSummaryEnv === undefined) {
      delete process.env.GITHUB_STEP_SUMMARY;
    } else {
      process.env.GITHUB_STEP_SUMMARY = originalSummaryEnv;
    }
  });

  it("appends the markdown table and marker together to $GITHUB_STEP_SUMMARY", () => {
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
    // appendFileSync requires the file to exist first, matching the real
    // GITHUB_STEP_SUMMARY contract (the runner pre-creates it).
    writeFileSync(summaryFile, "");

    const marker = summaryMarker({
      filesScanned: 0,
      totalTests: 0,
      findings: 0,
      skipped: 0,
      score: 0,
      reason: "no-test-files",
    });
    emitGithubStepSummary(
      "### Test Tautology (Phase A, advisory)\n\nNo test files changed in diff",
      marker,
    );

    const content = readFileSync(summaryFile, "utf-8");
    expect(content).toContain("### Test Tautology (Phase A, advisory)");
    expect(content).toContain("No test files changed in diff");
    expect(content).toContain(marker);
  });

  it("falls back to stdout instead of silently dropping the summary when GITHUB_STEP_SUMMARY is unset", () => {
    delete process.env.GITHUB_STEP_SUMMARY;

    emitGithubStepSummary("some table", "<!-- TAUTOLOGY_SUMMARY {} -->");

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain("some table");
    expect(logSpy.mock.calls[0][0]).toContain("<!-- TAUTOLOGY_SUMMARY {} -->");
  });
});
