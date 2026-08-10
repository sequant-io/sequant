/**
 * End-to-end wiring test for #915 — proves an escalated effort computed by
 * `withEscalatedEffort` actually reaches the Agent SDK's `query()` call, by
 * chaining the REAL `executePhaseWithRetry`/`executePhase` and the REAL
 * `ClaudeCodeDriver` together, mocking only the SDK boundary itself.
 *
 * This closes a gap the per-hop tests don't: `phase-executor.phase-policy.test.ts`
 * proves `ExecutionConfig.phasePolicies[phase]` reaches `AgentExecutionConfig`
 * (mocked driver); `claude-code.phase-policy.test.ts` proves
 * `AgentExecutionConfig.model`/`.effort` reaches `query()` options (mocked
 * SDK, real driver, config built by hand). Neither drives an escalated value
 * — the actual output of `withEscalatedEffort` — through both hops in one
 * test. A regression at either hop's boundary (e.g. a future refactor that
 * renames `phasePolicies` on one side but not the other) could pass both
 * existing suites while breaking the real end-to-end path; this test would
 * catch that.
 *
 * No subprocess or network call — `query()` itself is mocked, same technique
 * as `claude-code.phase-policy.test.ts`. Plain `.test.ts` (not
 * `.integration.test.ts`) to match that file's precedent: chaining real
 * in-process modules together is not what this repo's `.integration.` suffix
 * is reserved for (see `vitest.config.ts` — that suffix is for
 * subprocess/port-binding tests).
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
import { withEscalatedEffort } from "./effort-escalation.js";
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

const SUCCESS_STREAM = () =>
  mockStream([
    { type: "system", subtype: "init", session_id: "sess-915" },
    { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
    { type: "result", subtype: "success" },
  ]);

function baseConfig(overrides: Partial<ExecutionConfig> = {}): ExecutionConfig {
  return {
    phases: ["qa"],
    phaseTimeout: 60,
    qualityLoop: true,
    maxIterations: 3,
    sequential: false,
    concurrency: 3,
    parallel: false,
    verbose: false,
    noSmartTests: false,
    dryRun: false,
    mcp: false,
    retry: false, // isolate: no cold-start/MCP-fallback retries for this test
    ...overrides,
  };
}

describe("#915 end-to-end: an escalated effort reaches the real SDK query() call", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockReturnValue(SUCCESS_STREAM());
  });

  it("a configured base escalates and the escalated tier — not the base — is what the driver sends to query()", async () => {
    const config = baseConfig({
      effortEscalation: true,
      phasePolicies: { qa: { model: "sonnet", effort: "high" } },
    });

    // The real resolver, called exactly as batch-executor.ts and
    // ready-gate.ts call it at their retry-dispatch sites.
    const { config: escalatedConfig, record } = withEscalatedEffort(
      config,
      "qa",
      /* isRetry */ true,
    );
    expect(record).toEqual({ phase: "qa", base: "high", escalated: "xhigh" });

    await executePhaseWithRetry(915, "qa", escalatedConfig);

    const callOptions = queryMock.mock.calls[0]?.[0]?.options as
      Record<string, unknown> | undefined;
    // The escalated tier reached the SDK call — not the pre-escalation base,
    // and not silently dropped.
    expect(callOptions?.effort).toBe("xhigh");
    expect(callOptions?.model).toBe("sonnet"); // untouched by escalation
  });

  it("an unconfigured phase escalates from the SDK's own default and that default-plus-one-tier is what reaches query()", async () => {
    const config = baseConfig({ effortEscalation: true });

    const { config: escalatedConfig, record } = withEscalatedEffort(
      config,
      "qa",
      true,
    );
    expect(record).toEqual({ phase: "qa", base: "high", escalated: "xhigh" });

    await executePhaseWithRetry(915, "qa", escalatedConfig);

    const callOptions = queryMock.mock.calls[0]?.[0]?.options as
      Record<string, unknown> | undefined;
    expect(callOptions?.effort).toBe("xhigh");
  });

  it("a non-retried dispatch (first attempt) sends no effort override at all, end-to-end", async () => {
    const config = baseConfig({ effortEscalation: true });

    const { config: dispatchConfig, record } = withEscalatedEffort(
      config,
      "qa",
      /* isRetry */ false,
    );
    expect(record).toBeUndefined();

    await executePhaseWithRetry(915, "qa", dispatchConfig);

    const callOptions = queryMock.mock.calls[0]?.[0]?.options as
      Record<string, unknown> | undefined;
    // Key-presence, not truthiness — matches #914's own mutation-verified
    // absence gate (claude-code.phase-policy.test.ts AC-3).
    expect(callOptions ? "effort" in callOptions : false).toBe(false);
  });
});
