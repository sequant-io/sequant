import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { ClaudeCodeDriver } from "./claude-code.js";
import {
  RateLimitError,
  BillingError,
  type SequantError,
} from "../../errors.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentExecutionConfig } from "./agent-driver.js";

// Mock the SDK so we can drive arbitrary message streams through the driver
// loop (#732). Only `query` is exercised by executePhase().
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

const queryMock = query as unknown as Mock;

/** Build an async iterable that yields the given messages, like the SDK does. */
function mockStream(messages: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of messages) {
        yield m;
      }
    },
  };
}

function baseConfig(): AgentExecutionConfig {
  return {
    cwd: "/tmp/wt",
    env: {},
    phaseTimeout: 60,
    verbose: false,
    mcp: false,
  };
}

const INIT = { type: "system", subtype: "init", session_id: "sess-1" };
const RESULT_ERROR = {
  type: "result",
  subtype: "error_during_execution",
  errors: ["generic failure"],
};

describe("ClaudeCodeDriver", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

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

    // Prior assistant text the agent produced before hitting the turn cap.
    const PARTIAL_ASSISTANT = {
      type: "assistant",
      message: { content: [{ type: "text", text: "partial work done" }] },
    };

    it("returns partial output flagged capped, with no hard error string", async () => {
      queryMock.mockReturnValue(
        mockStream([
          INIT,
          PARTIAL_ASSISTANT,
          { type: "result", subtype: "error_max_turns" },
        ]),
      );
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
      queryMock.mockReturnValue(
        mockStream([
          INIT,
          PARTIAL_ASSISTANT,
          { type: "result", subtype: "error_max_turns" },
        ]),
      );
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
      queryMock.mockReturnValue(
        mockStream([
          INIT,
          PARTIAL_ASSISTANT,
          {
            type: "result",
            subtype: "error_during_execution",
            errors: ["boom"],
          },
        ]),
      );
      const driver = new ClaudeCodeDriver();

      const result = await driver.executePhase("prompt", makeConfig());

      expect(result.success).toBe(false);
      expect(result.capped).toBeUndefined();
      expect(result.error).toContain("boom");
    });
  });

  // === AC-1 / AC-6: stream loop reads rate_limit_event + assistant error ===

  describe("structured rate-limit / billing capture (#732)", () => {
    it("captures a billing rate_limit_event into a BillingError (AC-1, AC-6, AC-7)", async () => {
      queryMock.mockReturnValue(
        mockStream([
          INIT,
          {
            type: "rate_limit_event",
            rate_limit_info: {
              status: "rejected",
              overageDisabledReason: "out_of_credits",
              errorCode: "credits_required",
              canUserPurchaseCredits: true,
            },
            uuid: "u1",
            session_id: "sess-1",
          },
          {
            type: "assistant",
            message: { content: [] },
            error: "billing_error",
          },
          RESULT_ERROR,
        ]),
      );

      const driver = new ClaudeCodeDriver();
      const result = await driver.executePhase("prompt", baseConfig());

      expect(result.success).toBe(false);
      const err = result.structuredError as SequantError;
      expect(err).toBeInstanceOf(BillingError);
      expect(err.isRetryable).toBe(false);
      // Real cause surfaced in both the typed error and the result.error string.
      expect(err.message).toBe("Out of credits — purchasable");
      expect(result.error).toBe("Out of credits — purchasable");
    });

    it("captures a transient rate_limit_event into a retryable RateLimitError (AC-6, AC-7)", async () => {
      queryMock.mockReturnValue(
        mockStream([
          INIT,
          {
            type: "rate_limit_event",
            rate_limit_info: {
              status: "rejected",
              resetsAt: 1_700_000_000,
              rateLimitType: "five_hour",
            },
            uuid: "u1",
            session_id: "sess-1",
          },
          RESULT_ERROR,
        ]),
      );

      const driver = new ClaudeCodeDriver();
      const result = await driver.executePhase("prompt", baseConfig());

      expect(result.success).toBe(false);
      const err = result.structuredError as SequantError;
      expect(err).toBeInstanceOf(RateLimitError);
      expect(err.isRetryable).toBe(true);
      // Past timestamp → date-qualified reset.
      expect(err.message).toMatch(
        /^Rate limited — resets at \d{2}-\d{2} \d{2}:\d{2}$/,
      );
    });

    it("prefers billing over a transient rate_limit_event when the assistant reports billing_error (#732)", async () => {
      // A transient (non-billing) throttle event AND a separate billing_error:
      // the non-retryable billing cause must win so the MCP fallback is skipped.
      queryMock.mockReturnValue(
        mockStream([
          INIT,
          {
            type: "rate_limit_event",
            rate_limit_info: {
              status: "rejected",
              resetsAt: 1_700_000_000,
              rateLimitType: "five_hour",
            },
            uuid: "u1",
            session_id: "sess-1",
          },
          {
            type: "assistant",
            message: { content: [] },
            error: "billing_error",
          },
          RESULT_ERROR,
        ]),
      );

      const driver = new ClaudeCodeDriver();
      const result = await driver.executePhase("prompt", baseConfig());

      const err = result.structuredError as SequantError;
      expect(err).toBeInstanceOf(BillingError);
      expect(err.isRetryable).toBe(false);
      expect(result.error).toBe("Billing error");
    });

    it("falls back to the assistant error field when no rate_limit_event is present (AC-1, AC-6)", async () => {
      queryMock.mockReturnValue(
        mockStream([
          INIT,
          { type: "assistant", message: { content: [] }, error: "rate_limit" },
          RESULT_ERROR,
        ]),
      );

      const driver = new ClaudeCodeDriver();
      const result = await driver.executePhase("prompt", baseConfig());

      expect(result.structuredError).toBeInstanceOf(RateLimitError);
      expect(result.error).toBe("Rate limited");
    });

    it("captures api_retry diagnostics as a fallback signal (AC-6, optional)", async () => {
      queryMock.mockReturnValue(
        mockStream([
          INIT,
          {
            type: "system",
            subtype: "api_retry",
            attempt: 1,
            max_retries: 3,
            retry_delay_ms: 500,
            error_status: 429,
            error: "overloaded",
            uuid: "u1",
            session_id: "sess-1",
          },
          RESULT_ERROR,
        ]),
      );

      const driver = new ClaudeCodeDriver();
      const result = await driver.executePhase("prompt", baseConfig());

      expect(result.structuredError).toBeInstanceOf(RateLimitError);
      expect(result.error).toBe("API overloaded");
    });

    it("does NOT attach a structured error for an informational allowed_warning event", async () => {
      queryMock.mockReturnValue(
        mockStream([
          INIT,
          {
            type: "rate_limit_event",
            rate_limit_info: { status: "allowed_warning", utilization: 0.8 },
            uuid: "u1",
            session_id: "sess-1",
          },
          RESULT_ERROR,
        ]),
      );

      const driver = new ClaudeCodeDriver();
      const result = await driver.executePhase("prompt", baseConfig());

      expect(result.success).toBe(false);
      expect(result.structuredError).toBeUndefined();
      // Generic subtype text preserved when no structured cause exists.
      expect(result.error).toBe("generic failure");
    });

    it("attaches structuredError when the stream throws after a rejected rate_limit_event (#732)", async () => {
      // SDK surfaces a billing rejection, then the stream throws mid-iteration.
      queryMock.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield INIT;
          yield {
            type: "rate_limit_event",
            rate_limit_info: {
              status: "rejected",
              overageDisabledReason: "out_of_credits",
            },
            uuid: "u1",
            session_id: "sess-1",
          };
          throw new Error("stream connection reset");
        },
      });

      const driver = new ClaudeCodeDriver();
      const result = await driver.executePhase("prompt", baseConfig());

      expect(result.success).toBe(false);
      expect(result.structuredError).toBeInstanceOf(BillingError);
      // Real cause preferred over the raw thrown message.
      expect(result.error).toBe("Out of credits");
    });

    it("does NOT mask a genuine timeout/abort with a prior rate-limit signal (#732)", async () => {
      // A rejected event was seen, but the throw is an abort → timeout wins.
      queryMock.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield INIT;
          yield {
            type: "rate_limit_event",
            rate_limit_info: {
              status: "rejected",
              overageDisabledReason: "out_of_credits",
            },
            uuid: "u1",
            session_id: "sess-1",
          };
          throw new Error("AbortError: operation aborted");
        },
      });

      const driver = new ClaudeCodeDriver();
      const result = await driver.executePhase("prompt", baseConfig());

      expect(result.success).toBe(false);
      // Abort path returns first — no structuredError, timeout message intact.
      expect(result.structuredError).toBeUndefined();
      expect(result.error).toMatch(/^Timeout after \d+s$/);
    });

    it("leaves structuredError undefined on success", async () => {
      queryMock.mockReturnValue(
        mockStream([
          INIT,
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "done" }] },
          },
          { type: "result", subtype: "success" },
        ]),
      );

      const driver = new ClaudeCodeDriver();
      const result = await driver.executePhase("prompt", baseConfig());

      expect(result.success).toBe(true);
      expect(result.structuredError).toBeUndefined();
      expect(result.output).toBe("done");
    });
  });
});
