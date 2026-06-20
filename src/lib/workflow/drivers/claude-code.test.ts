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
      expect(err.message).toMatch(/^Rate limited — resets at \d{2}:\d{2}$/);
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
