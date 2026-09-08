import { describe, it, expect } from "vitest";
import { getDriver } from "./index.js";
import { OpencodeDriver } from "./opencode.js";

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

  it("862 AC-3 returns OpencodeDriver for 'opencode'", () => {
    const driver = getDriver("opencode");
    expect(driver).toBeInstanceOf(OpencodeDriver);
    expect(driver.name).toBe("opencode");
  });

  it("862 AC-3 opencode resolves skills, so the #813 preflight stays active", () => {
    expect(getDriver("opencode").resolvesSkills).toBe(true);
  });

  it("862 AC-3 accepts opencodeSettings without falling back to a default driver", () => {
    const driver = getDriver("opencode", {
      opencodeSettings: { model: "openrouter/anthropic/claude-sonnet-5" },
    });
    expect(driver).toBeInstanceOf(OpencodeDriver);
  });
});
