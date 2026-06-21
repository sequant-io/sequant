import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeDriver } from "./claude-code.js";

// Mock the SDK so executePhase iterates a synthetic stream without invoking
// Claude. The stream yields prior assistant text followed by an
// `error_max_turns` result — the turn-cap path under test (#733, AC-1).
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      yield {
        type: "system",
        subtype: "init",
        session_id: "synthetic-session-733",
      };
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "partial work done" }] },
      };
      yield {
        type: "result",
        subtype: "error_max_turns",
      };
    },
  })),
}));

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

  describe("error_max_turns handling (#733, AC-1)", () => {
    function makeConfig(onStderr?: (text: string) => void) {
      return {
        cwd: "/tmp/fixture/733",
        env: {},
        phaseTimeout: 60,
        verbose: false,
        mcp: false,
        onStderr,
      };
    }

    it("returns partial output flagged capped, with no hard error string", async () => {
      const driver = new ClaudeCodeDriver();

      const result = await driver.executePhase("prompt", makeConfig());

      // Partial work is preserved, not discarded.
      expect(result.output).toBe("partial work done");
      // Flagged so /qa and /exec can treat it as inconclusive/incomplete.
      expect(result.capped).toBe(true);
      // No hard "Max turns reached" error — turn-cap is a soft outcome.
      expect(result.error).toBeUndefined();
    });

    it("warns (not errors) via the onStderr channel", async () => {
      const driver = new ClaudeCodeDriver();
      const warnings: string[] = [];

      await driver.executePhase(
        "prompt",
        makeConfig((t) => warnings.push(t)),
      );

      expect(warnings.join("")).toMatch(/turn cap/i);
    });
  });
});
