/**
 * #1647: pre-3.0 metrics records keep loading after the ladder's removal.
 *
 * #915 wrote `effortEscalations` and #971 wrote `modelEscalations` plus the
 * ladder columns on `phaseUsage` rows. Nothing writes them since #1647, but
 * `.sequant/metrics.json` files written before 3.0 carry them, and
 * `sequant stats` reads those files through `MetricRunSchema` (I-2).
 */

import { describe, it, expect } from "vitest";
import { createMetricRun, MetricRunSchema } from "./metrics-schema.js";

function legacyRun(): Record<string, unknown> {
  const base = createMetricRun({
    issues: [971],
    phases: ["exec", "qa"],
    outcome: "failed",
    duration: 120,
  });
  return {
    ...base,
    effortEscalations: [{ phase: "qa", base: "high", escalated: "xhigh" }],
    modelEscalations: [
      {
        phase: "exec",
        rung: 1,
        base: "sonnet",
        escalated: "opus",
        trigger: "LOOP_NO_DIFF",
        requestedModel: "role:strong",
        topOfLadder: true,
      },
    ],
    metrics: {
      ...base.metrics,
      phaseUsage: [
        {
          phase: "exec",
          model: "claude-opus-4",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUSD: 0.01,
          ladderRung: 1,
          baseModel: "sonnet",
          escalatedModel: "opus",
          escalationTrigger: "LOOP_NO_DIFF",
          topOfLadder: true,
        },
      ],
    },
  };
}

describe("#1647: pre-3.0 metrics records with escalation data", () => {
  it("parse, and keep both escalation arrays", () => {
    const parsed = MetricRunSchema.parse(legacyRun());

    expect(parsed.effortEscalations).toEqual([
      { phase: "qa", base: "high", escalated: "xhigh" },
    ]);
    expect(parsed.modelEscalations?.[0]).toMatchObject({
      rung: 1,
      escalated: "opus",
      topOfLadder: true,
    });
  });

  it("keep the ladder columns on their phaseUsage rows", () => {
    const parsed = MetricRunSchema.parse(legacyRun());

    expect(parsed.metrics.phaseUsage?.[0]).toMatchObject({
      ladderRung: 1,
      escalatedModel: "opus",
      escalationTrigger: "LOOP_NO_DIFF",
    });
  });

  it("a record written today carries neither array", () => {
    const run = createMetricRun({
      issues: [1647],
      phases: ["exec"],
      outcome: "success",
      duration: 10,
    });

    expect("effortEscalations" in run).toBe(false);
    expect("modelEscalations" in run).toBe(false);
    expect(() => MetricRunSchema.parse(run)).not.toThrow();
  });
});
