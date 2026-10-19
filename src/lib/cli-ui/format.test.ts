import { describe, it, expect } from "vitest";
import { formatTimestamp } from "./format.js";

describe("formatTimestamp", () => {
  const iso = "2026-10-19T08:05:09.000Z";

  it("formats a Date as hh:mm:ss", () => {
    expect(formatTimestamp(new Date(iso))).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("returns the same text for a Date and its ISO string", () => {
    expect(formatTimestamp(iso)).toBe(formatTimestamp(new Date(iso)));
  });

  it("returns an unparsable string unchanged", () => {
    expect(formatTimestamp("garbage")).toBe("garbage");
  });
});
