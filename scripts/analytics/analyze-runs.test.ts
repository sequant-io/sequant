/**
 * Unit tests for the analyze-runs script
 *
 * Runs the script once in beforeAll and shares the parsed report across tests
 * to avoid repeated subprocess spawns (each takes ~5s for npx tsx).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import type { RunLog } from "../../src/lib/workflow/run-log-schema.js";

describe("analyze-runs script", { timeout: 30000 }, () => {
  let tmpDir: string;
  let jsonReport: Record<string, unknown>;
  let humanOutput: string;

  const makeLog = (overrides: Partial<RunLog> = {}): RunLog => ({
    version: 1,
    runId: "11111111-1111-4111-a111-111111111111",
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
        title: "Test Issue",
        labels: ["enhancement"],
        status: "success",
        phases: [
          {
            phase: "spec",
            issueNumber: 100,
            startTime: "2026-02-10T10:00:00.000Z",
            endTime: "2026-02-10T10:05:00.000Z",
            durationSeconds: 300,
            status: "success",
          },
          {
            phase: "exec",
            issueNumber: 100,
            startTime: "2026-02-10T10:05:00.000Z",
            endTime: "2026-02-10T10:15:00.000Z",
            durationSeconds: 600,
            status: "success",
          },
          {
            phase: "qa",
            issueNumber: 100,
            startTime: "2026-02-10T10:15:00.000Z",
            endTime: "2026-02-10T10:20:00.000Z",
            durationSeconds: 300,
            status: "success",
            verdict: "READY_FOR_MERGE",
          },
        ],
        totalDurationSeconds: 1200,
      },
    ],
    summary: {
      totalIssues: 1,
      passed: 1,
      failed: 0,
      totalDurationSeconds: 1800,
    },
    ...overrides,
  });

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-runs-test-"));

    const log1 = makeLog();
    const log2 = makeLog({
      runId: "22222222-2222-4222-a222-222222222222",
      startTime: "2026-02-17T10:00:00.000Z",
      endTime: "2026-02-17T10:30:00.000Z",
      issues: [
        {
          issueNumber: 200,
          title: "Failed Issue",
          labels: ["bug"],
          status: "failure",
          phases: [
            {
              phase: "exec",
              issueNumber: 200,
              startTime: "2026-02-17T10:05:00.000Z",
              endTime: "2026-02-17T10:10:00.000Z",
              durationSeconds: 300,
              status: "failure",
              error: "Claude Code process exited with code 1",
            },
          ],
          totalDurationSeconds: 300,
        },
        {
          issueNumber: 201,
          title: "QA Not Met",
          labels: ["enhancement"],
          status: "failure",
          phases: [
            {
              phase: "qa",
              issueNumber: 201,
              startTime: "2026-02-17T10:15:00.000Z",
              endTime: "2026-02-17T10:20:00.000Z",
              durationSeconds: 300,
              status: "failure",
              verdict: "AC_NOT_MET",
              error: "AC_NOT_MET",
            },
          ],
          totalDurationSeconds: 300,
        },
      ],
      summary: {
        totalIssues: 2,
        passed: 0,
        failed: 2,
        totalDurationSeconds: 1800,
      },
    });

    fs.writeFileSync(
      path.join(tmpDir, "run-2026-02-10-aaa.json"),
      JSON.stringify(log1),
    );
    fs.writeFileSync(
      path.join(tmpDir, "run-2026-02-17-bbb.json"),
      JSON.stringify(log2),
    );

    // Run script once for JSON output
    const jsonResult = execSync(
      `npx tsx scripts/analytics/analyze-runs.ts --json --path "${tmpDir}"`,
      { encoding: "utf-8", timeout: 30000 },
    );
    jsonReport = JSON.parse(jsonResult);

    // Run script once for human output
    humanOutput = execSync(
      `npx tsx scripts/analytics/analyze-runs.ts --path "${tmpDir}"`,
      { encoding: "utf-8", timeout: 30000 },
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should produce valid JSON structure", () => {
    expect(jsonReport.baselines).toBeDefined();
    expect(jsonReport.temporalTrends).toBeDefined();
    expect(jsonReport.qaAnalysis).toBeDefined();
    expect(jsonReport.failureForensics).toBeDefined();
    expect(jsonReport.segmentation).toBeDefined();
  });

  it("should compute correct baselines", () => {
    const baselines = jsonReport.baselines as Record<string, unknown>;
    expect(baselines.totalRuns).toBe(2);
    expect(baselines.totalIssues).toBe(3);
    expect(baselines.overallSuccessRate).toBeCloseTo(33.3, 0);
  });

  it("should compute QA first-pass rate", () => {
    const qa = jsonReport.qaAnalysis as Record<string, unknown>;
    // Issue 100: READY_FOR_MERGE (first pass), Issue 201: AC_NOT_MET → 50%
    expect(qa.firstPassQaRate).toBe(50);
    expect(qa.totalQaPhases).toBe(2);
  });

  it("should categorize failures correctly", () => {
    const forensics = jsonReport.failureForensics as Record<string, unknown>;
    const categories = forensics.categories as Record<string, number>;
    expect(forensics.totalFailedPhases).toBe(2);
    expect(categories.tooling_failure).toBe(1);
    expect(categories.qa_verdict_not_met).toBe(1);
  });

  it("should segment by label", () => {
    const seg = jsonReport.segmentation as {
      byLabel: { label: string; issues: number; successRate: number }[];
    };
    const enhancement = seg.byLabel.find((s) => s.label === "enhancement");
    const bug = seg.byLabel.find((s) => s.label === "bug");

    expect(enhancement).toBeDefined();
    expect(enhancement!.issues).toBe(2);
    expect(bug).toBeDefined();
    expect(bug!.issues).toBe(1);
    expect(bug!.successRate).toBe(0);
  });

  it("should produce human-readable output", () => {
    expect(humanOutput).toContain("SEQUANT WORKFLOW ANALYSIS");
    expect(humanOutput).toContain("Baselines");
    expect(humanOutput).toContain("QA Analysis");
    expect(humanOutput).toContain("Failure Forensics");
    expect(humanOutput).toContain("Segmentation");
  });

  it("should compute temporal trends in weekly buckets", () => {
    const trends = jsonReport.temporalTrends as {
      week: string;
      runs: number;
    }[];
    expect(trends.length).toBe(2);
    expect(trends[0].runs).toBe(1);
    expect(trends[1].runs).toBe(1);
  });
});
