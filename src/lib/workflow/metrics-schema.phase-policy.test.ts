/**
 * Test stub for #914 AC-7 — run metrics record the resolved model/effort per
 * phase when set, and omit the fields when inherited.
 *
 * Field-name choice: this stub assumes `MetricRun.phasePolicies:
 * Record<phase, {model?, effort?}>`, mirroring the `phasePolicies` field name
 * used on `ExecutionConfig` (AC-5) for naming consistency across the
 * feature. This is a stub proposal, not a locked contract — /exec is free to
 * rename during implementation as long as the AC-7 behavior (record when
 * set, omit when inherited, enum/alias strings only) holds; update this test
 * to match if so.
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
      // @ts-expect-error — phasePolicies not yet on createMetricRun's options (#914 AC-7)
      phasePolicies: { exec: { model: "sonnet", effort: "medium" } },
    });

    // Then: the metric record carries exec's resolved model/effort
    expect(
      (run as unknown as { phasePolicies?: Record<string, unknown> })
        .phasePolicies?.exec,
    ).toEqual({ model: "sonnet", effort: "medium" });
  });

  it("omits phasePolicies fields for a phase that inherited (nothing configured)", () => {
    const run = createMetricRun({
      issues: [914],
      phases: ["exec", "qa"],
      outcome: "success",
      duration: 120,
      // @ts-expect-error — phasePolicies not yet on createMetricRun's options (#914 AC-7)
      phasePolicies: { exec: { model: "sonnet" } },
    });

    const policies = (
      run as unknown as { phasePolicies?: Record<string, unknown> }
    ).phasePolicies;
    // qa inherited (nothing resolved for it) -> no entry, not an entry with
    // undefined fields — matches AC-3's key-presence discipline.
    expect(policies && "qa" in policies).toBeFalsy();
  });

  it("validates against MetricRunSchema with phasePolicies present", () => {
    const run = createMetricRun({
      issues: [914],
      phases: ["exec"],
      outcome: "success",
      duration: 10,
      // @ts-expect-error — phasePolicies not yet on createMetricRun's options (#914 AC-7)
      phasePolicies: { exec: { model: "sonnet", effort: "high" } },
    });

    expect(() => MetricRunSchema.parse(run)).not.toThrow();
  });
});
