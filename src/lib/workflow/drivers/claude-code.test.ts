import { describe, it, expect } from "vitest";
import { ClaudeCodeDriver } from "./claude-code.js";

describe("ClaudeCodeDriver", () => {
  it("has name 'claude-code'", () => {
    const driver = new ClaudeCodeDriver();
    expect(driver.name).toBe("claude-code");
  });

  it("isAvailable() returns true when SDK is importable", async () => {
    const driver = new ClaudeCodeDriver();
    const available = await driver.isAvailable();
    expect(available).toBe(true);
  });

  it("implements AgentDriver interface", () => {
    const driver = new ClaudeCodeDriver();
    expect(typeof driver.executePhase).toBe("function");
    expect(typeof driver.isAvailable).toBe("function");
    expect(typeof driver.name).toBe("string");
  });
});
