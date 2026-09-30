/**
 * Tests for #975 AC-4: phase-executor extracts resolvedModel from the
 * driver's modelUsage map and attaches it to the returned PhaseResult.
 *
 * #1227: the map's first key is NOT the dispatched model — real phases list a
 * Haiku helper call first — so the extraction goes through
 * `selectResolvedModel`. The fixtures below use the SDK's real camelCase field
 * names and put the helper first, which is the shape that exposed the bug; the
 * original fixture (snake_case, main model first) passed with the bug in place.
 * Undefined for drivers that don't populate modelUsage (aider, subprocess).
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import type { Mock } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("./agents-md.js", () => ({
  readAgentsMd: vi.fn().mockResolvedValue(null),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { executePhaseWithRetry } from "./phase-executor.js";
import {
  createExecTempRepo,
  type ExecTempRepo,
} from "./__fixtures__/exec-temp-repo.fixture.js";
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

// #1232: never run the exec guard against the developer's checkout.
let execRepo: ExecTempRepo;
beforeAll(() => {
  execRepo = createExecTempRepo();
});
afterAll(() => {
  execRepo.cleanup();
});
function runInExecRepo(
  issueNumber: number,
  phase: Parameters<typeof executePhaseWithRetry>[1],
  config: Parameters<typeof executePhaseWithRetry>[2],
  resumeHandle?: Parameters<typeof executePhaseWithRetry>[3],
) {
  return executePhaseWithRetry(
    issueNumber,
    phase,
    config,
    resumeHandle,
    execRepo.path,
  );
}

describe("#975 AC-4: phase-executor resolvedModel extraction from modelUsage", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("1227 sets resolvedModel to the main model when a Haiku helper is listed first", async () => {
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
            "claude-haiku-4-5-20251001": {
              inputTokens: 918,
              outputTokens: 16,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              costUSD: 0.001,
            },
            "claude-sonnet-5": {
              inputTokens: 40,
              outputTokens: 9000,
              cacheReadInputTokens: 1200000,
              cacheCreationInputTokens: 90000,
              costUSD: 0.86,
            },
          },
        },
      ]),
    );

    const result = await runInExecRepo(975, "exec", baseConfig());

    expect(result.resolvedModel).toBe("claude-sonnet-5");
  });

  it("1227 prefers the key matching the phase's configured model over an advisor key", async () => {
    queryMock.mockReturnValue(
      mockStream([
        { type: "system", subtype: "init", session_id: "sess-1227" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "done" }] },
        },
        {
          type: "result",
          subtype: "success",
          // Short phase: the advisor's uncached read outweighs the main model.
          modelUsage: {
            "claude-opus-5-5": {
              inputTokens: 4,
              outputTokens: 29,
              cacheReadInputTokens: 20000,
              cacheCreationInputTokens: 0,
              costUSD: 0.2,
            },
            "claude-fable-5-1": {
              inputTokens: 36052,
              outputTokens: 208,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              costUSD: 0.37,
            },
          },
        },
      ]),
    );

    const result = await runInExecRepo(
      975,
      "exec",
      baseConfig({ phasePolicies: { exec: { model: "opus" } } }),
    );

    expect(result.resolvedModel).toBe("claude-opus-5-5");
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

    const result = await runInExecRepo(975, "exec", baseConfig());

    expect(result.resolvedModel).toBeUndefined();
  });

  it("1232 dispatches exec with the temp repo as cwd", async () => {
    queryMock.mockReturnValue(
      mockStream([
        { type: "system", subtype: "init", session_id: "sess-1232" },
        { type: "result", subtype: "success" },
      ]),
    );

    await runInExecRepo(975, "exec", baseConfig());

    const options = queryMock.mock.calls[0]?.[0]?.options as
      Record<string, unknown> | undefined;
    expect(options?.cwd).toBe(execRepo.path);
    expect(options?.cwd).not.toBe(process.cwd());
  });
});
