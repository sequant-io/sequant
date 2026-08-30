/**
 * Tests for #975 AC-4: run metrics record requestedModel and resolvedModel
 * per-phase in phasePolicies.
 *
 * AC-4: run metrics and the phase marker record the requested value (role string)
 * and the resolved concrete model ID from `modelUsage` for each phase execution.
 */

import { describe, it, expect } from "vitest";
import { createMetricRun, MetricRunSchema } from "./metrics-schema.js";

describe("#975 AC-4: metrics schema — requestedModel and resolvedModel per phase", () => {
  it("MetricRunSchema accepts requestedModel and resolvedModel in phasePolicies", () => {
    const run = createMetricRun({
      issues: [975],
      phases: ["exec"],
      outcome: "success",
      duration: 120,
      model: "sonnet",
      phasePolicies: {
        exec: {
          model: "sonnet",
          requestedModel: "role:fast",
          resolvedModel: "claude-sonnet-5",
        },
      },
      metrics: { tokensUsed: 1000, filesChanged: 3, linesAdded: 50 },
    });

    // Validate against schema
    const parsed = MetricRunSchema.parse(run);
    expect(parsed.phasePolicies?.exec?.requestedModel).toBe("role:fast");
    expect(parsed.phasePolicies?.exec?.resolvedModel).toBe("claude-sonnet-5");
  });

  it("requestedModel and resolvedModel are optional — existing records without them remain valid", () => {
    const run = createMetricRun({
      issues: [975],
      phases: ["exec"],
      outcome: "success",
      duration: 60,
      model: "sonnet",
      phasePolicies: {
        exec: { model: "sonnet", effort: "medium" },
      },
      metrics: {},
    });

    const parsed = MetricRunSchema.parse(run);
    expect(parsed.phasePolicies?.exec?.requestedModel).toBeUndefined();
    expect(parsed.phasePolicies?.exec?.resolvedModel).toBeUndefined();
    // Existing fields still present
    expect(parsed.phasePolicies?.exec?.model).toBe("sonnet");
    expect(parsed.phasePolicies?.exec?.effort).toBe("medium");
  });

  it("createMetricRun propagates requestedModel and resolvedModel correctly", () => {
    const run = createMetricRun({
      issues: [975],
      phases: ["spec", "exec", "qa"],
      outcome: "success",
      duration: 600,
      model: "sonnet",
      phasePolicies: {
        spec: { requestedModel: "role:fast", resolvedModel: "claude-sonnet-5" },
        exec: {
          requestedModel: "role:strong",
          resolvedModel: "claude-opus-4-8",
        },
      },
    });

    expect(run.phasePolicies?.spec?.requestedModel).toBe("role:fast");
    expect(run.phasePolicies?.spec?.resolvedModel).toBe("claude-sonnet-5");
    expect(run.phasePolicies?.exec?.requestedModel).toBe("role:strong");
    expect(run.phasePolicies?.exec?.resolvedModel).toBe("claude-opus-4-8");
  });

  it("a raw model string (no role: prefix) can be the requestedModel", () => {
    const run = createMetricRun({
      issues: [975],
      phases: ["exec"],
      outcome: "success",
      duration: 90,
      model: "claude-sonnet-5",
      phasePolicies: {
        exec: {
          requestedModel: "claude-sonnet-5",
          resolvedModel: "claude-sonnet-5",
        },
      },
    });

    const parsed = MetricRunSchema.parse(run);
    expect(parsed.phasePolicies?.exec?.requestedModel).toBe("claude-sonnet-5");
    expect(parsed.phasePolicies?.exec?.resolvedModel).toBe("claude-sonnet-5");
  });
});
