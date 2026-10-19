/**
 * Tests for #929: `source` discriminator on MetricRun.
 *
 * - AC-4: a record with no `source` reads back as "run".
 * - AC-5: the run-orchestrator call shape (no `source`) is recorded as "run".
 *
 * Run with: npm test -- src/lib/workflow/metrics-schema.source.test.ts
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MetricsSchema, createMetricRun } from "./metrics-schema.js";
import { MetricsWriter } from "./metrics-writer.js";

/** A run exactly as written before #929 — note: no `source` key. */
function legacyRun(): Record<string, unknown> {
  return {
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
}

describe("MetricRun source (#929)", () => {
  describe("AC-4: legacy records read as source 'run'", () => {
    it("parses a metrics file whose run has no source into runs[0].source === 'run'", () => {
      const legacy = { version: 1, runs: [legacyRun()] };
      expect("source" in legacy.runs[0]).toBe(false);

      const parsed = MetricsSchema.parse(legacy);

      expect(parsed.runs[0].source).toBe("run");
    });

    it("rejects an unknown source value", () => {
      const bad = {
        version: 1,
        runs: [{ ...legacyRun(), source: "bogus" }],
      };

      expect(MetricsSchema.safeParse(bad).success).toBe(false);
    });

    it("round-trips source: 'ready' unchanged", () => {
      const file = { version: 1, runs: [{ ...legacyRun(), source: "ready" }] };

      expect(MetricsSchema.parse(file).runs[0].source).toBe("ready");
    });
  });

  describe("AC-5: run --ready-gate recording shape unchanged", () => {
    let dir: string | undefined;

    afterEach(() => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    it("createMetricRun called without source (orchestrator shape) yields source 'run'", () => {
      const run = createMetricRun({
        issues: [1],
        phases: ["exec"],
        outcome: "success",
        duration: 10,
      });

      expect(run.source).toBe("run");
    });

    it("MetricsWriter.recordRun without source persists source 'run'", async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-929-"));
      const metricsPath = path.join(dir, "metrics.json");
      const writer = new MetricsWriter({ metricsPath });

      await writer.recordRun({
        issues: [1],
        phases: ["exec"],
        outcome: "success",
        duration: 10,
      });
      await writer.recordRun({
        issues: [2],
        phases: ["qa"],
        outcome: "failed",
        duration: 5,
        source: "ready",
      });

      const onDisk = JSON.parse(fs.readFileSync(metricsPath, "utf-8"));
      expect(onDisk.runs.map((r: { source: string }) => r.source)).toEqual([
        "run",
        "ready",
      ]);
    });
  });
});
