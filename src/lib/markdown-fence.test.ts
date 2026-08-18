/**
 * Tests for markdown-fence.ts
 */

import { describe, it, expect } from "vitest";
import { computeFenceMask, stripFencedLines } from "./markdown-fence.js";

describe("computeFenceMask", () => {
  it("marks lines inside a backtick fence, including the delimiters", () => {
    const lines = ["before", "```", "inside", "```", "after"];
    expect(computeFenceMask(lines)).toEqual([false, true, true, true, false]);
  });

  it("marks lines inside a tilde fence", () => {
    const lines = ["before", "~~~", "inside", "~~~", "after"];
    expect(computeFenceMask(lines)).toEqual([false, true, true, true, false]);
  });

  it("does not close a fence on mismatched fence character", () => {
    const lines = ["```", "content", "~~~", "still inside", "```"];
    expect(computeFenceMask(lines)).toEqual([true, true, true, true, true]);
  });

  it("does not close a longer fence with a shorter same-char delimiter", () => {
    const lines = ["````", "```", "still inside", "````"];
    expect(computeFenceMask(lines)).toEqual([true, true, true, true]);
  });

  it("treats an unclosed fence as running to EOF", () => {
    const lines = ["before", "```", "inside", "still inside"];
    expect(computeFenceMask(lines)).toEqual([false, true, true, true]);
  });
});

describe("stripFencedLines", () => {
  it("blanks fenced lines while preserving line count", () => {
    const body = "before\n```\ninside\n```\nafter";
    expect(stripFencedLines(body)).toBe("before\n\n\n\nafter");
  });
});
