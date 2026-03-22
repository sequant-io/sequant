import { describe, it, expect } from "vitest";
import { getDriver } from "./index.js";

describe("driver registry", () => {
  it("returns ClaudeCodeDriver for 'claude-code'", () => {
    const driver = getDriver("claude-code");
    expect(driver.name).toBe("claude-code");
  });

  it("defaults to 'claude-code' when no name provided", () => {
    const driver = getDriver();
    expect(driver.name).toBe("claude-code");
  });

  it("throws on unknown driver name", () => {
    expect(() => getDriver("unknown-driver")).toThrow(
      /Unknown agent driver "unknown-driver"/,
    );
  });

  it("error message lists available drivers", () => {
    expect(() => getDriver("nonexistent")).toThrow(/claude-code/);
  });
});
