import { describe, it, expect } from "vitest";
import { truncateToWidth } from "./truncate.js";

describe("truncateToWidth", () => {
  it("returns input unchanged when within budget", () => {
    expect(truncateToWidth("hello", 10)).toBe("hello");
  });

  it("truncates with ellipsis when over budget", () => {
    const out = truncateToWidth("abcdefghij", 5);
    expect(out).toBe("abcd…");
  });

  it("handles width 0 by returning empty", () => {
    expect(truncateToWidth("anything", 0)).toBe("");
  });

  it("handles width 1 by returning ellipsis when truncation needed", () => {
    expect(truncateToWidth("abc", 1)).toBe("…");
  });

  it("counts wide glyphs as two columns", () => {
    // CJK glyph "中" is width 2; budget 3 allows only one glyph + ellipsis.
    expect(truncateToWidth("中中中", 3)).toBe("中…");
  });

  it("passes short input through even with wide glyphs", () => {
    expect(truncateToWidth("中", 2)).toBe("中");
  });
});
