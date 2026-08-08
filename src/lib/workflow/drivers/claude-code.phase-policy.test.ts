/**
 * Test stubs for #914 AC-3 and AC-4 — ClaudeCodeDriver forwards configured
 * `model`/`effort` into the SDK `query()` options object, and omits both
 * keys entirely when unset (mutation-verified absence gate: key-presence via
 * `in`, not truthiness — see the spec's AC-3 assumptions).
 *
 * `AgentExecutionConfig` does not have `model`/`effort` fields yet, and
 * `ClaudeCodeDriver.executePhase` does not forward them — these tests are RED
 * until /exec adds both. `baseConfig()` + mocked `query()` mirror the
 * existing `claude-code.test.ts` fixtures exactly so this file exercises the
 * real driver, not a reimplementation of it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { ClaudeCodeDriver } from "./claude-code.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentExecutionConfig } from "./agent-driver.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

const queryMock = query as unknown as Mock;

function mockStream(messages: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of messages) {
        yield m;
      }
    },
  };
}

const SUCCESS_STREAM = () =>
  mockStream([
    { type: "system", subtype: "init", session_id: "sess-914" },
    { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
    { type: "result", subtype: "success" },
  ]);

function baseConfig(): AgentExecutionConfig {
  return {
    cwd: "/tmp/wt-914",
    env: {},
    phaseTimeout: 60,
    verbose: false,
    mcp: false,
  };
}

describe("#914 AC-3/AC-4: ClaudeCodeDriver model/effort forwarding", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockReturnValue(SUCCESS_STREAM());
  });

  it("AC-3: omits both model and effort from query() options when unset", async () => {
    const driver = new ClaudeCodeDriver();
    await driver.executePhase("prompt", baseConfig());

    const callOptions = queryMock.mock.calls[0]?.[0]?.options as
      Record<string, unknown> | undefined;
    expect(callOptions).toBeDefined();
    // Key-presence assertion, not truthiness — this is the mutation-verified
    // absence gate the spec calls out for AC-3.
    expect("model" in (callOptions as object)).toBe(false);
    expect("effort" in (callOptions as object)).toBe(false);
  });

  it("AC-4: forwards configured model and effort into query() options", async () => {
    const driver = new ClaudeCodeDriver();
    const config: AgentExecutionConfig = {
      ...baseConfig(),
      // @ts-expect-error — model/effort not yet declared on AgentExecutionConfig (#914 AC-4)
      model: "sonnet",
      // @ts-expect-error — model/effort not yet declared on AgentExecutionConfig (#914 AC-4)
      effort: "medium",
    };

    await driver.executePhase("prompt", config);

    const callOptions = queryMock.mock.calls[0]?.[0]?.options as
      Record<string, unknown> | undefined;
    expect(callOptions?.model).toBe("sonnet");
    expect(callOptions?.effort).toBe("medium");
  });
});
