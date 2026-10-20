import { describe, it, expect, beforeEach } from "vitest";
import {
  noteSuppressed,
  resetSuppressed,
  suppressedCounts,
} from "./suppressed.js";

beforeEach(() => {
  resetSuppressed();
});

describe("noteSuppressed (#1504 AC-1)", () => {
  it("counts by scope", () => {
    noteSuppressed("state", new Error("a"));
    noteSuppressed("state", new Error("b"), "updatePhaseStatus");
    noteSuppressed("progress", "not an Error");

    expect(suppressedCounts()).toEqual({
      total: 3,
      byScope: { state: 2, progress: 1 },
    });
  });

  it("writes one line per call to the sink", () => {
    const lines: string[] = [];
    resetSuppressed((line) => lines.push(line));

    noteSuppressed("cleanup", new Error("EACCES"), "deactivateRelay spec");

    expect(lines).toEqual(["suppressed[cleanup] deactivateRelay spec: EACCES"]);
  });

  it("never throws, even when the sink or the error throws, and still counts", () => {
    resetSuppressed(() => {
      throw new Error("sink down");
    });
    const hostile = {
      toString() {
        throw new Error("hostile");
      },
    };

    expect(() => noteSuppressed("state", new Error("x"))).not.toThrow();
    expect(() => noteSuppressed("other", hostile)).not.toThrow();
    expect(suppressedCounts()).toEqual({
      total: 2,
      byScope: { state: 1, other: 1 },
    });
  });

  it("resets per run", () => {
    noteSuppressed("platform", new Error("gh"));
    expect(suppressedCounts().total).toBe(1);

    resetSuppressed();

    expect(suppressedCounts()).toEqual({ total: 0, byScope: {} });
  });

  it("returns a copy, not the live counter", () => {
    const snapshot = suppressedCounts();
    noteSuppressed("state", new Error("later"));
    expect(snapshot).toEqual({ total: 0, byScope: {} });
  });
});
