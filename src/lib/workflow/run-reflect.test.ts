import { describe, it, expect } from "vitest";
import {
  analyzeRun,
  formatReflection,
  type ReflectionInput,
  type ReflectionOutput,
} from "./run-reflect.js";
import type { IssueResult } from "./types.js";
import type { RunLog } from "./run-log-schema.js";

function makeResult(
  issueNumber: number,
  phases: Array<{
    phase: string;
    success?: boolean;
    durationSeconds?: number;
  }>,
  overrides?: Partial<IssueResult>,
): IssueResult {
  return {
    issueNumber,
    success: overrides?.success ?? true,
    phaseResults: phases.map((p) => ({
      phase: p.phase as IssueResult["phaseResults"][0]["phase"],
      success: p.success ?? true,
      durationSeconds: p.durationSeconds,
    })),
    ...overrides,
  };
}

function makeInput(overrides?: Partial<ReflectionInput>): ReflectionInput {
  return {
    results: [],
    issueInfoMap: new Map(),
    runLog: null,
    config: { phases: ["spec", "exec", "qa"], qualityLoop: false },
    ...overrides,
  };
}

describe("analyzeRun", () => {
  describe("timing patterns", () => {
    it("detects similar spec times across issues", () => {
      const input = makeInput({
        results: [
          makeResult(1, [
            { phase: "spec", durationSeconds: 170 },
            { phase: "exec", durationSeconds: 300 },
          ]),
          makeResult(2, [
            { phase: "spec", durationSeconds: 180 },
            { phase: "exec", durationSeconds: 600 },
          ]),
        ],
      });

      const result = analyzeRun(input);

      expect(
        result.observations.some((o) => o.includes("Spec times similar")),
      ).toBe(true);
      expect(
        result.suggestions.some((s) => s.includes("--phases exec,qa")),
      ).toBe(true);
    });

    it("does not flag timing when only one issue", () => {
      const input = makeInput({
        results: [makeResult(1, [{ phase: "spec", durationSeconds: 170 }])],
      });

      const result = analyzeRun(input);

      expect(
        result.observations.filter((o) => o.includes("Spec times")),
      ).toHaveLength(0);
    });

    it("flags long QA phases", () => {
      const input = makeInput({
        results: [
          makeResult(1, [
            { phase: "spec", durationSeconds: 100 },
            { phase: "qa", durationSeconds: 400 },
          ]),
        ],
      });

      const result = analyzeRun(input);

      expect(result.observations.some((o) => o.includes("QA took"))).toBe(true);
      expect(result.suggestions.some((s) => s.includes("sub-agent"))).toBe(
        true,
      );
    });
  });

  describe("phase mismatches", () => {
    it("detects .tsx changes without test phase via runLog", () => {
      const runLog = {
        version: 1 as const,
        runId: "test-uuid",
        startTime: new Date().toISOString(),
        config: {
          phases: ["spec" as const, "exec" as const, "qa" as const],
          sequential: false,
          qualityLoop: false,
          maxIterations: 3,
        },
        issues: [
          {
            issueNumber: 42,
            title: "Test issue",
            labels: [],
            status: "success" as const,
            totalDurationSeconds: 300,
            phases: [
              {
                phase: "exec" as const,
                issueNumber: 42,
                startTime: new Date().toISOString(),
                endTime: new Date().toISOString(),
                durationSeconds: 200,
                status: "success" as const,
                fileDiffStats: [
                  {
                    path: "src/components/Button.tsx",
                    additions: 10,
                    deletions: 2,
                    status: "modified" as const,
                  },
                ],
              },
              {
                phase: "qa" as const,
                issueNumber: 42,
                startTime: new Date().toISOString(),
                endTime: new Date().toISOString(),
                durationSeconds: 100,
                status: "success" as const,
              },
            ],
          },
        ],
        summary: {
          totalIssues: 1,
          passed: 1,
          failed: 0,
          totalDurationSeconds: 300,
        },
      };

      const input = makeInput({
        results: [makeResult(42, [{ phase: "exec" }, { phase: "qa" }])],
        runLog,
      });

      const result = analyzeRun(input);

      expect(
        result.observations.some(
          (o) => o.includes("#42") && o.includes(".tsx"),
        ),
      ).toBe(true);
      expect(
        result.suggestions.some((s) => s.includes("ui") && s.includes("label")),
      ).toBe(true);
    });

    it("does not flag when test phase was executed", () => {
      const runLog = {
        version: 1 as const,
        runId: "test-uuid",
        startTime: new Date().toISOString(),
        config: {
          phases: [
            "spec" as const,
            "exec" as const,
            "test" as const,
            "qa" as const,
          ],
          sequential: false,
          qualityLoop: false,
          maxIterations: 3,
        },
        issues: [
          {
            issueNumber: 42,
            title: "Test issue",
            labels: [],
            status: "success" as const,
            totalDurationSeconds: 400,
            phases: [
              {
                phase: "exec" as const,
                issueNumber: 42,
                startTime: new Date().toISOString(),
                endTime: new Date().toISOString(),
                durationSeconds: 200,
                status: "success" as const,
                fileDiffStats: [
                  {
                    path: "src/components/Button.tsx",
                    additions: 10,
                    deletions: 2,
                    status: "modified" as const,
                  },
                ],
              },
              {
                phase: "test" as const,
                issueNumber: 42,
                startTime: new Date().toISOString(),
                endTime: new Date().toISOString(),
                durationSeconds: 100,
                status: "success" as const,
              },
              {
                phase: "qa" as const,
                issueNumber: 42,
                startTime: new Date().toISOString(),
                endTime: new Date().toISOString(),
                durationSeconds: 100,
                status: "success" as const,
              },
            ],
          },
        ],
        summary: {
          totalIssues: 1,
          passed: 1,
          failed: 0,
          totalDurationSeconds: 400,
        },
      };

      const input = makeInput({
        results: [
          makeResult(42, [
            { phase: "exec" },
            { phase: "test" },
            { phase: "qa" },
          ]),
        ],
        runLog,
      });

      const result = analyzeRun(input);

      expect(
        result.observations.filter((o) => o.includes(".tsx")),
      ).toHaveLength(0);
    });

    it("falls back to label check when no runLog", () => {
      const issueInfoMap = new Map<
        number,
        { title: string; labels: string[] }
      >();
      issueInfoMap.set(10, { title: "UI Fix", labels: ["ui", "enhancement"] });

      const input = makeInput({
        results: [
          makeResult(10, [
            { phase: "spec" },
            { phase: "exec" },
            { phase: "qa" },
          ]),
        ],
        issueInfoMap,
        runLog: null,
      });

      const result = analyzeRun(input);

      expect(
        result.observations.some(
          (o) => o.includes("#10") && o.includes("UI label"),
        ),
      ).toBe(true);
    });
  });

  describe("workflow improvements", () => {
    it("detects all issues running same phases", () => {
      const input = makeInput({
        results: [
          makeResult(1, [
            { phase: "spec" },
            { phase: "exec" },
            { phase: "qa" },
          ]),
          makeResult(2, [
            { phase: "spec" },
            { phase: "exec" },
            { phase: "qa" },
          ]),
          makeResult(3, [
            { phase: "spec" },
            { phase: "exec" },
            { phase: "qa" },
          ]),
        ],
      });

      const result = analyzeRun(input);

      expect(
        result.observations.some((o) => o.includes("identical phases")),
      ).toBe(true);
    });

    it("detects quality loop triggers", () => {
      const input = makeInput({
        results: [
          makeResult(
            1,
            [{ phase: "spec" }, { phase: "exec" }, { phase: "qa" }],
            {
              loopTriggered: true,
            },
          ),
        ],
      });

      const result = analyzeRun(input);

      expect(
        result.observations.some((o) => o.includes("Quality loop triggered")),
      ).toBe(true);
      expect(result.suggestions.some((s) => s.includes("complex"))).toBe(true);
    });

    it("suggests quality loop when failures occur without it", () => {
      const input = makeInput({
        results: [
          makeResult(
            1,
            [{ phase: "spec" }, { phase: "exec", success: false }],
            {
              success: false,
            },
          ),
          makeResult(2, [
            { phase: "spec" },
            { phase: "exec" },
            { phase: "qa" },
          ]),
        ],
        config: { phases: ["spec", "exec", "qa"], qualityLoop: false },
      });

      const result = analyzeRun(input);

      expect(result.suggestions.some((s) => s.includes("--quality-loop"))).toBe(
        true,
      );
    });

    it("does not suggest quality loop when already enabled", () => {
      const input = makeInput({
        results: [
          makeResult(
            1,
            [{ phase: "spec" }, { phase: "exec", success: false }],
            {
              success: false,
            },
          ),
        ],
        config: { phases: ["spec", "exec", "qa"], qualityLoop: true },
      });

      const result = analyzeRun(input);

      expect(
        result.suggestions.filter((s) => s.includes("--quality-loop")),
      ).toHaveLength(0);
    });
  });
});

describe("formatReflection", () => {
  it("returns empty string when no observations or suggestions", () => {
    const output: ReflectionOutput = { observations: [], suggestions: [] };
    expect(formatReflection(output)).toBe("");
  });

  it("formats observations and suggestions in a box", () => {
    const output: ReflectionOutput = {
      observations: ["Issue #1 was slow"],
      suggestions: ["Try --fast mode"],
    };

    const formatted = formatReflection(output);

    expect(formatted).toContain("Run Analysis");
    expect(formatted).toContain("Observations:");
    expect(formatted).toContain("Issue #1 was slow");
    expect(formatted).toContain("Suggestions:");
    expect(formatted).toContain("Try --fast mode");
  });

  it("truncates output to max 10 lines", () => {
    const output: ReflectionOutput = {
      observations: Array.from({ length: 6 }, (_, i) => `Observation ${i + 1}`),
      suggestions: Array.from({ length: 6 }, (_, i) => `Suggestion ${i + 1}`),
    };

    const formatted = formatReflection(output);

    // Should contain "... and N more" truncation indicator
    expect(formatted).toContain("... and");
    expect(formatted).toContain("more");

    // Count bullet points (content lines) — should be <= 10
    const bulletLines = formatted
      .split("\n")
      .filter((l) => l.includes("\u2022"));
    expect(bulletLines.length).toBeLessThanOrEqual(10);
  });

  it("handles only observations (no suggestions)", () => {
    const output: ReflectionOutput = {
      observations: ["Something noteworthy"],
      suggestions: [],
    };

    const formatted = formatReflection(output);

    expect(formatted).toContain("Observations:");
    expect(formatted).not.toContain("Suggestions:");
  });

  it("handles only suggestions (no observations)", () => {
    const output: ReflectionOutput = {
      observations: [],
      suggestions: ["Try this improvement"],
    };

    const formatted = formatReflection(output);

    expect(formatted).not.toContain("Observations:");
    expect(formatted).toContain("Suggestions:");
  });
});
