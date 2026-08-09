/**
 * Test for #915 AC-8 — run metrics record base+escalated effort for every
 * execution that escalated.
 *
 * `MetricRun.effortEscalations: Array<{phase, base, escalated}>`, a sibling
 * to #914's `phasePolicies` (see `MetricRunSchema.effortEscalations`'s doc
 * comment for why this is a separate array rather than an extension of
 * `phasePolicies` — escalation is a per-execution value, `phasePolicies` a
 * flat per-run map).
 */

import { describe, it, expect } from "vitest";
import { createMetricRun, MetricRunSchema } from "./metrics-schema.js";

describe("#915 AC-8: effort escalations in run metrics", () => {
  it("records one entry per escalated execution", () => {
    const run = createMetricRun({
      issues: [915],
      phases: ["exec", "qa"],
      outcome: "success",
      duration: 120,
      effortEscalations: [
        { phase: "qa", base: "high", escalated: "xhigh" },
        { phase: "exec", base: "high", escalated: "xhigh" },
      ],
    });

    expect(run.effortEscalations).toEqual([
      { phase: "qa", base: "high", escalated: "xhigh" },
      { phase: "exec", base: "high", escalated: "xhigh" },
    ]);
  });

  it("omits effortEscalations entirely when nothing escalated (empty array passed)", () => {
    const run = createMetricRun({
      issues: [915],
      phases: ["exec"],
      outcome: "success",
      duration: 10,
      effortEscalations: [],
    });

    expect("effortEscalations" in run).toBe(false);
  });

  it("omits effortEscalations entirely when not passed at all", () => {
    const run = createMetricRun({
      issues: [915],
      phases: ["exec"],
      outcome: "success",
      duration: 10,
    });

    expect("effortEscalations" in run).toBe(false);
  });

  it("validates against MetricRunSchema with effortEscalations present", () => {
    const run = createMetricRun({
      issues: [915],
      phases: ["exec"],
      outcome: "success",
      duration: 10,
      effortEscalations: [{ phase: "exec", base: "high", escalated: "xhigh" }],
    });

    expect(() => MetricRunSchema.parse(run)).not.toThrow();
  });

  it("coexists independently with #914's phasePolicies on the same record", () => {
    const run = createMetricRun({
      issues: [915],
      phases: ["exec"],
      outcome: "success",
      duration: 10,
      phasePolicies: { exec: { model: "sonnet", effort: "high" } },
      effortEscalations: [{ phase: "exec", base: "high", escalated: "xhigh" }],
    });

    expect(run.phasePolicies?.exec).toEqual({
      model: "sonnet",
      effort: "high",
    });
    expect(run.effortEscalations).toEqual([
      { phase: "exec", base: "high", escalated: "xhigh" },
    ]);
    expect(() => MetricRunSchema.parse(run)).not.toThrow();
  });
});
