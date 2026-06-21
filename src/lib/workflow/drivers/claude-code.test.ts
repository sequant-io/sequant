import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeCodeDriver } from "./claude-code.js";

// Mutable controller for the mocked SDK result. `vi.hoisted` runs before the
// `vi.mock` factory below so the factory can close over it; each test sets the
// result subtype it needs. Defaults to `error_max_turns` (the #733 turn-cap
// path); reset in `beforeEach`.
const mockResult = vi.hoisted(() => ({
  subtype: "error_max_turns" as string,
  errors: undefined as string[] | undefined,
}));

// Mock the SDK so executePhase iterates a synthetic stream without invoking
// Claude. The stream yields prior assistant text followed by a result whose
// subtype is driven by `mockResult`.
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
        subtype: mockResult.subtype,
        ...(mockResult.errors ? { errors: mockResult.errors } : {}),
      };
    },
  })),
}));

beforeEach(() => {
  mockResult.subtype = "error_max_turns";
  mockResult.errors = undefined;
});

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

    // FAILURE PATH (regression guard): the turn-cap branch must be NARROW.
    // Other error subtypes still fail hard — `success: false`, a real error
    // string, and NO `capped` flag — so the soft-cap handling can't mask a
    // genuine execution failure. Guards the riskiest part of #733's change.
    it("does not flag non-capped error subtypes as capped", async () => {
      mockResult.subtype = "error_during_execution";
      mockResult.errors = ["boom"];
      const driver = new ClaudeCodeDriver();

      const result = await driver.executePhase("prompt", makeConfig());

      expect(result.success).toBe(false);
      expect(result.capped).toBeUndefined();
      expect(result.error).toContain("boom");
    });
  });
});
