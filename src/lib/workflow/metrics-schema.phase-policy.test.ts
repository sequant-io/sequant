/**
 * Test for #914 AC-7 — run metrics record the resolved model/effort per
 * phase when set, and omit the fields when inherited.
 *
 * `MetricRun.phasePolicies: Record<phase, {model?, effort?}>`, mirroring the
 * `phasePolicies` field name used on `ExecutionConfig` (AC-5) for naming
 * consistency across the feature.
 */

import { describe, it, expect } from "vitest";
import { createMetricRun, MetricRunSchema } from "./metrics-schema.js";

describe("#914 AC-7: per-phase model/effort in run metrics", () => {
  it("records resolved model/effort for a phase that had one configured", () => {
    // Given: exec resolved to {model: "sonnet", effort: "medium"}, qa inherited
    const run = createMetricRun({
      issues: [914],
      phases: ["exec", "qa"],
      outcome: "success",
      duration: 120,
      phasePolicies: { exec: { model: "sonnet", effort: "medium" } },
    });

    // Then: the metric record carries exec's resolved model/effort
    expect(run.phasePolicies?.exec).toEqual({
      model: "sonnet",
      effort: "medium",
    });
  });

  it("omits phasePolicies fields for a phase that inherited (nothing configured)", () => {
    const run = createMetricRun({
      issues: [914],
      phases: ["exec", "qa"],
      outcome: "success",
      duration: 120,
      phasePolicies: { exec: { model: "sonnet" } },
    });

    // qa inherited (nothing resolved for it) -> no entry, not an entry with
    // undefined fields — matches AC-3's key-presence discipline.
    expect(run.phasePolicies && "qa" in run.phasePolicies).toBeFalsy();
  });

  it("omits phasePolicies entirely when nothing was configured for any phase", () => {
    const run = createMetricRun({
      issues: [914],
      phases: ["exec"],
      outcome: "success",
      duration: 10,
    });

    expect("phasePolicies" in run).toBe(false);
  });

  it("validates against MetricRunSchema with phasePolicies present", () => {
    const run = createMetricRun({
      issues: [914],
      phases: ["exec"],
      outcome: "success",
      duration: 10,
      phasePolicies: { exec: { model: "sonnet", effort: "high" } },
    });

    expect(() => MetricRunSchema.parse(run)).not.toThrow();
  });
});
