/**
 * Tests for MetricsWriter
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { MetricsWriter, resetMetricsWriter } from "./metrics-writer.js";
import { createEmptyMetrics, type Metrics } from "./metrics-schema.js";

describe("MetricsWriter", () => {
  let tempDir: string;
  let metricsPath: string;
  let writer: MetricsWriter;

  beforeEach(() => {
    // Create temp directory for test metrics files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-test-"));
    metricsPath = path.join(tempDir, ".sequant", "metrics.json");
    writer = new MetricsWriter({ metricsPath });
    resetMetricsWriter();
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("getMetrics", () => {
    it("should return empty metrics when file does not exist", async () => {
      const metrics = await writer.getMetrics();

      expect(metrics.version).toBe(1);
      expect(metrics.runs).toEqual([]);
    });

    it("should read and parse existing metrics file", async () => {
      // Create metrics file
      const existingMetrics: Metrics = {
        version: 1,
        runs: [
          {
            id: "550e8400-e29b-41d4-a716-446655440000",
            date: "2026-01-20T12:00:00.000Z",
            issues: [42],
            phases: ["exec", "qa"],
            outcome: "success",
            duration: 300,
            model: "opus",
            flags: [],
            metrics: {
              tokensUsed: 0,
              filesChanged: 5,
              linesAdded: 200,
              acceptanceCriteria: 3,
              qaIterations: 1,
            },
          },
        ],
      };

      fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
      fs.writeFileSync(metricsPath, JSON.stringify(existingMetrics));

      const metrics = await writer.getMetrics();

      expect(metrics.runs.length).toBe(1);
      expect(metrics.runs[0].issues).toEqual([42]);
    });

    it("should cache metrics after first read", async () => {
      const metrics1 = await writer.getMetrics();
      const metrics2 = await writer.getMetrics();

      expect(metrics1).toBe(metrics2); // Same object reference
    });

    it("should throw on invalid JSON", async () => {
      fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
      fs.writeFileSync(metricsPath, "not valid json");

      await expect(writer.getMetrics()).rejects.toThrow("Invalid JSON");
    });
  });

  describe("saveMetrics", () => {
    it("should create directory and write metrics file", async () => {
      const metrics = createEmptyMetrics();

      await writer.saveMetrics(metrics);

      expect(fs.existsSync(metricsPath)).toBe(true);

      const content = fs.readFileSync(metricsPath, "utf-8");
      const saved = JSON.parse(content);
      expect(saved.version).toBe(1);
    });

    it("should update cache after save", async () => {
      const metrics = createEmptyMetrics();
      await writer.saveMetrics(metrics);

      // Cache should be updated
      const cached = await writer.getMetrics();
      expect(cached).toEqual(metrics);
    });

    it("should preserve pretty-printed JSON", async () => {
      const metrics = createEmptyMetrics();
      await writer.saveMetrics(metrics);

      const content = fs.readFileSync(metricsPath, "utf-8");
      expect(content).toContain("\n"); // Has newlines (pretty printed)
    });
  });

  describe("recordRun", () => {
    it("should add a new run to metrics", async () => {
      const run = await writer.recordRun({
        issues: [123],
        phases: ["spec", "exec", "qa"],
        outcome: "success",
        duration: 600,
        model: "opus",
      });

      expect(run.id).toBeDefined();
      expect(run.issues).toEqual([123]);

      // Check it was persisted
      const metrics = await writer.getMetrics();
      expect(metrics.runs.length).toBe(1);
      expect(metrics.runs[0].id).toBe(run.id);
    });

    it("should append to existing runs", async () => {
      // Record first run
      await writer.recordRun({
        issues: [1],
        phases: ["exec"],
        outcome: "success",
        duration: 100,
      });

      // Record second run
      await writer.recordRun({
        issues: [2],
        phases: ["exec"],
        outcome: "failed",
        duration: 200,
      });

      const metrics = await writer.getMetrics();
      expect(metrics.runs.length).toBe(2);
      expect(metrics.runs[0].issues).toEqual([1]);
      expect(metrics.runs[1].issues).toEqual([2]);
    });

    it("should handle metrics with flags", async () => {
      const run = await writer.recordRun({
        issues: [123, 124],
        phases: ["spec", "exec", "qa"],
        outcome: "partial",
        duration: 900,
        model: "opus",
        flags: ["--chain", "--sequential", "--qa-gate"],
        metrics: {
          filesChanged: 15,
          linesAdded: 800,
        },
      });

      expect(run.flags).toEqual(["--chain", "--sequential", "--qa-gate"]);
      expect(run.metrics.filesChanged).toBe(15);
      expect(run.metrics.linesAdded).toBe(800);
    });
  });

  describe("getAllRuns", () => {
    it("should return empty array when no runs", async () => {
      const runs = await writer.getAllRuns();
      expect(runs).toEqual([]);
    });

    it("should return all runs", async () => {
      await writer.recordRun({
        issues: [1],
        phases: ["exec"],
        outcome: "success",
        duration: 100,
      });
      await writer.recordRun({
        issues: [2],
        phases: ["exec"],
        outcome: "failed",
        duration: 200,
      });

      const runs = await writer.getAllRuns();
      expect(runs.length).toBe(2);
    });
  });

  describe("getRecentRuns", () => {
    it("should return last N runs", async () => {
      // Record 5 runs
      for (let i = 1; i <= 5; i++) {
        await writer.recordRun({
          issues: [i],
          phases: ["exec"],
          outcome: "success",
          duration: i * 100,
        });
      }

      const recentRuns = await writer.getRecentRuns(3);
      expect(recentRuns.length).toBe(3);
      // Should be the last 3
      expect(recentRuns[0].issues).toEqual([3]);
      expect(recentRuns[1].issues).toEqual([4]);
      expect(recentRuns[2].issues).toEqual([5]);
    });

    it("should return all runs if count exceeds total", async () => {
      await writer.recordRun({
        issues: [1],
        phases: ["exec"],
        outcome: "success",
        duration: 100,
      });

      const recentRuns = await writer.getRecentRuns(10);
      expect(recentRuns.length).toBe(1);
    });
  });

  describe("clearCache", () => {
    it("should clear cached metrics", async () => {
      const metrics1 = await writer.getMetrics();
      writer.clearCache();

      // Should read from file again
      const metrics2 = await writer.getMetrics();
      expect(metrics1).not.toBe(metrics2); // Different object reference
    });
  });

  describe("metricsExists", () => {
    it("should return false when file does not exist", () => {
      expect(writer.metricsExists()).toBe(false);
    });

    it("should return true when file exists", async () => {
      await writer.saveMetrics(createEmptyMetrics());
      expect(writer.metricsExists()).toBe(true);
    });
  });

  describe("deleteMetrics", () => {
    it("should delete metrics file", async () => {
      await writer.saveMetrics(createEmptyMetrics());
      expect(writer.metricsExists()).toBe(true);

      await writer.deleteMetrics();
      expect(writer.metricsExists()).toBe(false);
    });

    it("should clear cache on delete", async () => {
      await writer.saveMetrics(createEmptyMetrics());
      const metrics1 = await writer.getMetrics();
      expect(metrics1.runs).toEqual([]);

      await writer.deleteMetrics();

      // Should return empty metrics (recreated)
      const metrics2 = await writer.getMetrics();
      expect(metrics2.version).toBe(1);
      expect(metrics2.runs).toEqual([]);
    });

    it("should handle delete when file does not exist", async () => {
      // Should not throw
      await expect(writer.deleteMetrics()).resolves.not.toThrow();
    });
  });

  describe("getMetricsPath", () => {
    it("should return the configured path", () => {
      expect(writer.getMetricsPath()).toBe(metricsPath);
    });
  });
});
