/**
 * Unit tests for #915 — evidence-based effort escalation on quality-loop
 * retries. Covers the ladder resolver (`resolveEscalatedEffort`) and the
 * per-execution dispatch wrapper (`withEscalatedEffort`) against the
 * boundary-condition table in the /spec plan's AC-2/3/5/6/7.
 */

import { describe, it, expect } from "vitest";
import {
  resolveEscalatedEffort,
  withEscalatedEffort,
  DEFAULT_ESCALATION_BASE,
} from "./effort-escalation.js";
import type { ExecutionConfig } from "./types.js";

function baseConfig(overrides: Partial<ExecutionConfig> = {}): ExecutionConfig {
  return {
    phases: ["exec"],
    phaseTimeout: 600,
    qualityLoop: true,
    maxIterations: 3,
    sequential: false,
    concurrency: 3,
    parallel: false,
    verbose: false,
    noSmartTests: false,
    dryRun: false,
    mcp: false,
    retry: true,
    ...overrides,
  };
}

describe("resolveEscalatedEffort — the ladder (AC-2, AC-3, AC-5, AC-6)", () => {
  it("AC-2: disabled → returns base unchanged, even on a retry", () => {
    expect(resolveEscalatedEffort("high", true, false)).toBe("high");
  });

  it("AC-2: disabled + unconfigured base (undefined) → stays undefined, not the default", () => {
    // The disabled path must be indistinguishable from #915 never existing —
    // it must NOT substitute DEFAULT_ESCALATION_BASE for an absent base.
    expect(resolveEscalatedEffort(undefined, true, false)).toBeUndefined();
  });

  it("AC-7: enabled but not a retry (first attempt) → returns base unchanged", () => {
    expect(resolveEscalatedEffort("high", false, true)).toBe("high");
    expect(resolveEscalatedEffort(undefined, false, true)).toBeUndefined();
  });

  it("AC-3: enabled + retry + base high → escalates to xhigh", () => {
    expect(resolveEscalatedEffort("high", true, true)).toBe("xhigh");
  });

  it("AC-5: enabled + retry + unconfigured base → treats base as the default and escalates one tier", () => {
    expect(DEFAULT_ESCALATION_BASE).toBe("high");
    expect(resolveEscalatedEffort(undefined, true, true)).toBe("xhigh");
  });

  it("AC-6: base max + retry → stays max (capped, never exceeds the ladder top)", () => {
    expect(resolveEscalatedEffort("max", true, true)).toBe("max");
  });

  it("AC-6: base high on a 3rd loop iteration is xhigh, not max (escalates from the CONFIGURED base, never cumulatively)", () => {
    // Simulates batch-executor calling this fresh on every retried dispatch —
    // never chaining the previous call's return value back in as `base`.
    const configuredBase = "high";
    expect(resolveEscalatedEffort(configuredBase, true, true)).toBe("xhigh");
    expect(resolveEscalatedEffort(configuredBase, true, true)).toBe("xhigh");
  });

  it("ladder table: every tier escalates exactly one step", () => {
    expect(resolveEscalatedEffort("low", true, true)).toBe("medium");
    expect(resolveEscalatedEffort("medium", true, true)).toBe("high");
    expect(resolveEscalatedEffort("high", true, true)).toBe("xhigh");
    expect(resolveEscalatedEffort("xhigh", true, true)).toBe("max");
    expect(resolveEscalatedEffort("max", true, true)).toBe("max");
  });
});

describe("withEscalatedEffort — per-execution dispatch (AC-2, AC-7)", () => {
  it("AC-2: escalation disabled → returns the SAME config reference (unconfigured phase stays key-absent)", () => {
    const config = baseConfig({ effortEscalation: false });
    const outcome = withEscalatedEffort(config, "exec", true);
    expect(outcome.config).toBe(config); // same reference — no clone
    expect(outcome.record).toBeUndefined();
    expect(outcome.config.phasePolicies?.exec?.effort).toBeUndefined();
  });

  it("AC-2: escalation disabled + a CONFIGURED phase → carries the unescalated configured value unchanged", () => {
    const config = baseConfig({
      effortEscalation: false,
      phasePolicies: { exec: { effort: "medium" } },
    });
    const outcome = withEscalatedEffort(config, "exec", true);
    expect(outcome.config).toBe(config);
    expect(outcome.config.phasePolicies?.exec?.effort).toBe("medium");
  });

  it("AC-7: not a retry (first attempt) → returns the SAME config reference even when enabled", () => {
    const config = baseConfig({
      effortEscalation: true,
      phasePolicies: { exec: { effort: "high" } },
    });
    const outcome = withEscalatedEffort(config, "exec", false);
    expect(outcome.config).toBe(config);
    expect(outcome.record).toBeUndefined();
  });

  it("enabled + retry + configured effort → clones config, escalates ONLY the target phase's effort, preserves its model", () => {
    const config = baseConfig({
      effortEscalation: true,
      phasePolicies: { exec: { model: "sonnet", effort: "high" } },
    });
    const outcome = withEscalatedEffort(config, "exec", true);
    expect(outcome.config).not.toBe(config); // cloned, not mutated
    expect(outcome.config.phasePolicies?.exec).toEqual({
      model: "sonnet",
      effort: "xhigh",
    });
    expect(outcome.record).toEqual({
      phase: "exec",
      base: "high",
      escalated: "xhigh",
    });
    // The input config itself is untouched (no mutation).
    expect(config.phasePolicies?.exec?.effort).toBe("high");
  });

  it("enabled + retry + unconfigured phase → escalates from DEFAULT_ESCALATION_BASE, adds a phasePolicies entry", () => {
    const config = baseConfig({ effortEscalation: true });
    const outcome = withEscalatedEffort(config, "exec", true);
    expect(outcome.config.phasePolicies?.exec?.effort).toBe("xhigh");
    expect(outcome.record).toEqual({
      phase: "exec",
      base: "high",
      escalated: "xhigh",
    });
  });

  it("AC-6: enabled + retry + already at max → no-op (same reference, no record) since nothing changed", () => {
    const config = baseConfig({
      effortEscalation: true,
      phasePolicies: { exec: { effort: "max" } },
    });
    const outcome = withEscalatedEffort(config, "exec", true);
    expect(outcome.config).toBe(config);
    expect(outcome.record).toBeUndefined();
  });

  it("AC-7: escalating one phase does not affect other phases' policies on the SAME config", () => {
    const config = baseConfig({
      effortEscalation: true,
      phasePolicies: {
        exec: { effort: "high" },
        qa: { effort: "medium" },
      },
    });
    const outcome = withEscalatedEffort(config, "exec", true);
    expect(outcome.config.phasePolicies?.exec?.effort).toBe("xhigh");
    expect(outcome.config.phasePolicies?.qa?.effort).toBe("medium"); // untouched
    // And the shared input config's qa entry is never mutated either.
    expect(config.phasePolicies?.qa?.effort).toBe("medium");
  });
});
