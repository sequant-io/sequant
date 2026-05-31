/**
 * Tests for the `sequant ready` command shell (#683).
 *
 * - AC-3a: policy resolution precedence (flag > settings > default).
 * - AC-4/AC-5: exit-code mapping (ready → 0, needs-human → 1, no-impl → 2).
 */

import { describe, it, expect } from "vitest";
import {
  resolvePolicy,
  getReadyExitCode,
  type ReadyCommandOptions,
} from "./ready.js";
import type { ReadyResult } from "../lib/workflow/ready-gate.js";

function result(overrides: Partial<ReadyResult>): ReadyResult {
  return {
    issueNumber: 683,
    policy: "ac",
    ready: false,
    reason: "MAX_ITERATIONS",
    issueStatus: "blocked",
    iterations: 1,
    finalVerdict: "AC_NOT_MET",
    autoFixed: [],
    remaining: [],
    tokensUsed: 0,
    report: "",
    ...overrides,
  };
}

describe("resolvePolicy (AC-3a)", () => {
  it("flag wins over settings", () => {
    expect(resolvePolicy("a-plus", "ac")).toBe("a-plus");
    expect(resolvePolicy("ac", "a-plus")).toBe("ac");
  });

  it("falls back to settings when no flag is given", () => {
    expect(resolvePolicy(undefined, "a-plus")).toBe("a-plus");
    expect(resolvePolicy(undefined, "ac")).toBe("ac");
  });

  it("falls back to settings on an invalid flag value", () => {
    expect(resolvePolicy("nonsense", "ac")).toBe("ac");
    expect(resolvePolicy("", "a-plus")).toBe("a-plus");
  });
});

describe("getReadyExitCode (AC-4 / AC-5)", () => {
  it("ready → 0", () => {
    expect(getReadyExitCode(result({ ready: true, reason: "AC_MET" }))).toBe(0);
  });

  it("no-implementation (#534) → 2", () => {
    expect(
      getReadyExitCode(result({ ready: false, reason: "NO_IMPLEMENTATION" })),
    ).toBe(2);
  });

  it("other not-ready (needs human) → 1", () => {
    expect(
      getReadyExitCode(result({ ready: false, reason: "MAX_ITERATIONS" })),
    ).toBe(1);
    expect(
      getReadyExitCode(result({ ready: false, reason: "LOOP_NO_DIFF" })),
    ).toBe(1);
  });
});

describe("ReadyCommandOptions typing", () => {
  it("accepts the documented option shape", () => {
    const opts: ReadyCommandOptions = {
      policy: "a-plus",
      maxIterations: 5,
      budget: 200000,
      timeout: 1800,
      mcp: false,
      json: true,
      verbose: true,
    };
    expect(opts.policy).toBe("a-plus");
  });
});
