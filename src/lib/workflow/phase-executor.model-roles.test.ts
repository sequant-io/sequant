/**
 * Tests for #975 AC-4: phase-executor extracts resolvedModel from the
 * driver's modelUsage map and attaches it to the returned PhaseResult.
 *
 * Coverage edge: the extraction at phase-executor.ts:1381-1386 — first key
 * of modelUsage is the primary dispatched model; undefined for drivers that
 * don't populate modelUsage (aider, subprocess paths).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("./agents-md.js", () => ({
  readAgentsMd: vi.fn().mockResolvedValue(null),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { executePhaseWithRetry } from "./phase-executor.js";
import type { ExecutionConfig } from "./types.js";

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

function baseConfig(overrides: Partial<ExecutionConfig> = {}): ExecutionConfig {
  return {
    phases: ["exec"],
    phaseTimeout: 60,
    qualityLoop: false,
    maxIterations: 1,
    sequential: false,
    concurrency: 1,
    parallel: false,
    verbose: false,
    noSmartTests: false,
    dryRun: false,
    mcp: false,
    retry: false,
    ...overrides,
  };
}

describe("#975 AC-4: phase-executor resolvedModel extraction from modelUsage", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("sets resolvedModel to the first key of modelUsage on a successful phase", async () => {
    queryMock.mockReturnValue(
      mockStream([
        { type: "system", subtype: "init", session_id: "sess-975" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "done" }] },
        },
        {
          type: "result",
          subtype: "success",
          modelUsage: {
            "claude-sonnet-5": { input_tokens: 200, output_tokens: 80 },
            "claude-haiku-4-5-20251001": { input_tokens: 10, output_tokens: 5 },
          },
        },
      ]),
    );

    const result = await executePhaseWithRetry(975, "exec", baseConfig());

    // First key is the primary dispatched model
    expect(result.resolvedModel).toBe("claude-sonnet-5");
  });

  it("leaves resolvedModel undefined when the driver returns no modelUsage (subprocess/aider paths)", async () => {
    queryMock.mockReturnValue(
      mockStream([
        { type: "system", subtype: "init", session_id: "sess-975b" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "done" }] },
        },
        { type: "result", subtype: "success" },
      ]),
    );

    const result = await executePhaseWithRetry(975, "exec", baseConfig());

    expect(result.resolvedModel).toBeUndefined();
  });
});
