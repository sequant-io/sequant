/**
 * Tests ensuring Phase type definitions are unified across all schema files.
 *
 * These tests prevent regression where Phase is defined independently
 * in multiple files with divergent values.
 */

import { describe, it, expect } from "vitest";
import { PhaseSchema } from "./types.js";
import {
  PhaseSchema as StatePhaseSchema,
  WORKFLOW_PHASES,
} from "./state-schema.js";
import { PhaseSchema as RunLogPhaseSchema } from "./run-log-schema.js";
import {
  CheckVerdictSchema,
  BatchVerdictSchema,
  CHECK_VERDICTS,
  BATCH_VERDICTS,
} from "../merge-check/types.js";

describe("Phase type unification", () => {
  it("state-schema PhaseSchema is the same object as types PhaseSchema", () => {
    expect(StatePhaseSchema).toBe(PhaseSchema);
  });

  it("run-log-schema PhaseSchema is the same object as types PhaseSchema", () => {
    expect(RunLogPhaseSchema).toBe(PhaseSchema);
  });

  it("WORKFLOW_PHASES matches PhaseSchema options", () => {
    expect(WORKFLOW_PHASES).toBe(PhaseSchema.options);
  });

  it("PhaseSchema includes all expected phases", () => {
    const phases = PhaseSchema.options;
    expect(phases).toContain("spec");
    expect(phases).toContain("security-review");
    expect(phases).toContain("exec");
    expect(phases).toContain("testgen");
    expect(phases).toContain("test");
    expect(phases).toContain("verify");
    expect(phases).toContain("qa");
    expect(phases).toContain("loop");
    expect(phases).toContain("merger");
  });

  it("PhaseSchema validates known phases", () => {
    expect(PhaseSchema.safeParse("spec").success).toBe(true);
    expect(PhaseSchema.safeParse("verify").success).toBe(true);
    expect(PhaseSchema.safeParse("merger").success).toBe(true);
  });

  it("PhaseSchema rejects unknown phases", () => {
    expect(PhaseSchema.safeParse("unknown").success).toBe(false);
    expect(PhaseSchema.safeParse("").success).toBe(false);
  });
});

describe("Merge-check verdict schemas", () => {
  it("CheckVerdictSchema validates all CHECK_VERDICTS", () => {
    for (const v of CHECK_VERDICTS) {
      expect(CheckVerdictSchema.safeParse(v).success).toBe(true);
    }
  });

  it("CheckVerdictSchema rejects invalid verdicts", () => {
    expect(CheckVerdictSchema.safeParse("INVALID").success).toBe(false);
  });

  it("BatchVerdictSchema validates all BATCH_VERDICTS", () => {
    for (const v of BATCH_VERDICTS) {
      expect(BatchVerdictSchema.safeParse(v).success).toBe(true);
    }
  });

  it("BatchVerdictSchema rejects invalid verdicts", () => {
    expect(BatchVerdictSchema.safeParse("INVALID").success).toBe(false);
  });
});
