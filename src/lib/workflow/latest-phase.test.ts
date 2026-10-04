import { describe, it, expect } from "vitest";
import { latestPhaseResult, latestWhere } from "./latest-phase.js";

describe("latest-phase (#1245)", () => {
  const looped = [
    { phase: "qa", verdict: "AC_NOT_MET", ok: false },
    { phase: "loop", verdict: undefined, ok: true },
    { phase: "qa", verdict: "NEEDS_VERIFICATION", ok: true },
  ];

  it("latestPhaseResult returns the last entry for the phase", () => {
    expect(latestPhaseResult(looped, "qa")?.verdict).toBe("NEEDS_VERIFICATION");
  });

  it("latestPhaseResult returns undefined for a phase that never ran", () => {
    expect(latestPhaseResult(looped, "spec")).toBeUndefined();
  });

  it("latestWhere returns the last match and does not mutate the input", () => {
    const copy = [...looped];
    expect(latestWhere(looped, (p) => !p.ok)?.verdict).toBe("AC_NOT_MET");
    expect(latestWhere(looped, (p) => p.ok)?.phase).toBe("qa");
    expect(looped).toEqual(copy);
    expect(latestWhere([], () => true)).toBeUndefined();
  });
});
