import { describe, it, expect } from "vitest";
import {
  BORDER_ROTATION,
  borderColorForIssue,
  phaseStatusColor,
} from "./theme.js";

describe("borderColorForIssue", () => {
  it("rotates through palette by slot", () => {
    expect(borderColorForIssue("queued", 0)).toBe(BORDER_ROTATION[0]);
    expect(borderColorForIssue("queued", 1)).toBe(BORDER_ROTATION[1]);
    expect(borderColorForIssue("queued", 2)).toBe(BORDER_ROTATION[2]);
    expect(borderColorForIssue("queued", 3)).toBe(BORDER_ROTATION[3]);
    // 5th box wraps back to slot 0 — cyan
    expect(borderColorForIssue("queued", 4)).toBe(BORDER_ROTATION[0]);
  });

  it("status overrides rotation for failed and passed", () => {
    expect(borderColorForIssue("failed", 0)).toBe("red");
    expect(borderColorForIssue("failed", 7)).toBe("red");
    expect(borderColorForIssue("passed", 2)).toBe("green");
  });

  it("running state uses rotation", () => {
    expect(borderColorForIssue("running", 1)).toBe(BORDER_ROTATION[1]);
  });
});

describe("phaseStatusColor", () => {
  it("green for done, red for failed, gray otherwise", () => {
    expect(phaseStatusColor("done")).toBe("green");
    expect(phaseStatusColor("failed")).toBe("red");
    expect(phaseStatusColor("pending")).toBe("gray");
    expect(phaseStatusColor("running")).toBe("gray");
  });
});
