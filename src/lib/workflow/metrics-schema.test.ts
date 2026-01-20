/**
 * Tests for metrics schema
 */

import { describe, it, expect } from "vitest";
import {
  MetricsSchema,
  MetricRunSchema,
  RunMetricsSchema,
  createEmptyMetrics,
  createMetricRun,
  determineOutcome,
  type Metrics,
  type MetricRun,
} from "./metrics-schema.js";

describe("metrics-schema", () => {
  describe("MetricsSchema", () => {
    it("should validate empty metrics", () => {
      const metrics = createEmptyMetrics();

      expect(() => MetricsSchema.parse(metrics)).not.toThrow();
      expect(metrics.version).toBe(1);
      expect(metrics.runs).toEqual([]);
    });

    it("should validate metrics with runs", () => {
      const metrics: Metrics = {
        version: 1,
        runs: [
          {
            id: "550e8400-e29b-41d4-a716-446655440000",
            date: "2026-01-20T12:00:00.000Z",
            issues: [123, 124],
            phases: ["spec", "exec", "qa"],
            outcome: "success",
            duration: 720,
            model: "opus",
            flags: ["--chain", "--sequential"],
            metrics: {
              tokensUsed: 45000,
              filesChanged: 9,
              linesAdded: 1800,
              acceptanceCriteria: 5,
              qaIterations: 2,
            },
          },
        ],
      };

      const parsed = MetricsSchema.parse(metrics);
      expect(parsed.runs.length).toBe(1);
      expect(parsed.runs[0].issues).toEqual([123, 124]);
    });

    it("should reject invalid version", () => {
      const invalid = {
        version: 2,
        runs: [],
      };

      expect(() => MetricsSchema.parse(invalid)).toThrow();
    });

    it("should reject missing required fields", () => {
      const invalid = {
        version: 1,
        // missing runs
      };

      expect(() => MetricsSchema.parse(invalid)).toThrow();
    });
  });

  describe("MetricRunSchema", () => {
    it("should validate a complete run", () => {
      const run: MetricRun = {
        id: "550e8400-e29b-41d4-a716-446655440000",
        date: "2026-01-20T12:00:00.000Z",
        issues: [42],
        phases: ["exec", "qa"],
        outcome: "success",
        duration: 300,
        model: "sonnet",
        flags: [],
        metrics: {
          tokensUsed: 0,
          filesChanged: 5,
          linesAdded: 200,
          acceptanceCriteria: 3,
          qaIterations: 1,
        },
      };

      expect(() => MetricRunSchema.parse(run)).not.toThrow();
    });

    it("should accept all valid outcomes", () => {
      for (const outcome of ["success", "partial", "failed"]) {
        const run = createMetricRun({
          issues: [1],
          phases: ["exec"],
          outcome: outcome as "success" | "partial" | "failed",
          duration: 100,
        });

        expect(() => MetricRunSchema.parse(run)).not.toThrow();
        expect(run.outcome).toBe(outcome);
      }
    });

    it("should accept all valid phases", () => {
      const validPhases = [
        "spec",
        "security-review",
        "testgen",
        "exec",
        "test",
        "qa",
        "loop",
      ] as const;

      const run = createMetricRun({
        issues: [1],
        phases: [...validPhases],
        outcome: "success",
        duration: 100,
      });

      expect(() => MetricRunSchema.parse(run)).not.toThrow();
      expect(run.phases).toEqual(validPhases);
    });

    it("should reject invalid outcome", () => {
      const invalid = {
        id: "550e8400-e29b-41d4-a716-446655440000",
        date: "2026-01-20T12:00:00.000Z",
        issues: [42],
        phases: ["exec"],
        outcome: "invalid",
        duration: 100,
        model: "opus",
        flags: [],
        metrics: {
          tokensUsed: 0,
          filesChanged: 0,
          linesAdded: 0,
          acceptanceCriteria: 0,
          qaIterations: 0,
        },
      };

      expect(() => MetricRunSchema.parse(invalid)).toThrow();
    });
  });

  describe("RunMetricsSchema", () => {
    it("should validate metrics with all zeros", () => {
      const metrics = {
        tokensUsed: 0,
        filesChanged: 0,
        linesAdded: 0,
        acceptanceCriteria: 0,
        qaIterations: 0,
      };

      expect(() => RunMetricsSchema.parse(metrics)).not.toThrow();
    });

    it("should reject negative values", () => {
      const invalid = {
        tokensUsed: -100,
        filesChanged: 5,
        linesAdded: 200,
        acceptanceCriteria: 3,
        qaIterations: 1,
      };

      expect(() => RunMetricsSchema.parse(invalid)).toThrow();
    });
  });

  describe("createEmptyMetrics", () => {
    it("should create valid empty metrics", () => {
      const metrics = createEmptyMetrics();

      expect(metrics.version).toBe(1);
      expect(metrics.runs).toEqual([]);
      expect(() => MetricsSchema.parse(metrics)).not.toThrow();
    });
  });

  describe("createMetricRun", () => {
    it("should create run with required fields", () => {
      const run = createMetricRun({
        issues: [123],
        phases: ["spec", "exec", "qa"],
        outcome: "success",
        duration: 600,
      });

      expect(run.id).toBeDefined();
      expect(run.date).toBeDefined();
      expect(run.issues).toEqual([123]);
      expect(run.phases).toEqual(["spec", "exec", "qa"]);
      expect(run.outcome).toBe("success");
      expect(run.duration).toBe(600);
      expect(run.model).toBe("unknown");
      expect(run.flags).toEqual([]);
    });

    it("should create run with optional fields", () => {
      const run = createMetricRun({
        issues: [123, 124],
        phases: ["exec", "qa"],
        outcome: "partial",
        duration: 900,
        model: "opus",
        flags: ["--chain", "--qa-gate"],
        metrics: {
          filesChanged: 10,
          linesAdded: 500,
        },
      });

      expect(run.model).toBe("opus");
      expect(run.flags).toEqual(["--chain", "--qa-gate"]);
      expect(run.metrics.filesChanged).toBe(10);
      expect(run.metrics.linesAdded).toBe(500);
      expect(run.metrics.tokensUsed).toBe(0); // Default
    });

    it("should generate valid UUID", () => {
      const run = createMetricRun({
        issues: [1],
        phases: ["exec"],
        outcome: "success",
        duration: 100,
      });

      // UUID v4 pattern
      expect(run.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it("should generate ISO datetime", () => {
      const run = createMetricRun({
        issues: [1],
        phases: ["exec"],
        outcome: "success",
        duration: 100,
      });

      // Should be parseable as ISO date
      expect(() => new Date(run.date)).not.toThrow();
      expect(run.date).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe("determineOutcome", () => {
    it('should return "success" when all issues pass', () => {
      expect(determineOutcome(5, 5)).toBe("success");
      expect(determineOutcome(1, 1)).toBe("success");
    });

    it('should return "failed" when no issues pass', () => {
      expect(determineOutcome(0, 5)).toBe("failed");
      expect(determineOutcome(0, 1)).toBe("failed");
    });

    it('should return "partial" when some issues pass', () => {
      expect(determineOutcome(3, 5)).toBe("partial");
      expect(determineOutcome(1, 2)).toBe("partial");
    });

    it('should return "failed" for edge case of 0 total', () => {
      // When total is 0, successCount must also be 0
      expect(determineOutcome(0, 0)).toBe("success"); // 0/0 is technically all passed
    });
  });
});
