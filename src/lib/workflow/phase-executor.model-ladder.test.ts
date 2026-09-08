/**
 * #971 — end-to-end wiring: an escalated model rung reaches the real SDK
 * `query()` call, and the recording half lands on the `PhaseResult`.
 *
 * Same technique and rationale as `phase-executor.effort-escalation.test.ts`
 * (#915): chain the REAL `executePhaseWithRetry`/`executePhase` and the REAL
 * `ClaudeCodeDriver` together, mocking only the SDK boundary. The per-hop
 * tests each prove one half — `model-ladder.test.ts` proves
 * `withEscalatedModel` puts the rung on `ExecutionConfig.phasePolicies`, and
 * `claude-code.phase-policy.test.ts` proves `AgentExecutionConfig.model`
 * reaches `query()` options — but neither drives an ESCALATED value through
 * both hops, which is what a rename on one side of that boundary would break
 * while leaving both suites green.
 *
 * Also carries AC-13: the #973 result shape (`subtype: "success"` with
 * `is_error: true`) must enter the retry path rather than count as
 * convergence. That matters most here — an escalated dispatch to a model
 * string the API rejects would otherwise report a zero-work "success" and the
 * ladder would read it as having converged.
 *
 * Plain `.test.ts` (not `.integration.test.ts`): `query()` is mocked, so no
 * subprocess and no port binding — matching the #915 file's precedent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
vi.mock("./agents-md.js", () => ({
  readAgentsMd: vi.fn().mockResolvedValue(null),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { executePhaseWithRetry } from "./phase-executor.js";
import { withEscalatedModel, createLadderState } from "./model-ladder.js";
import type { ExecutionConfig } from "./types.js";

const queryMock = query as unknown as Mock;

function mockStream(messages: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m;
    },
  };
}

const SUCCESS_STREAM = () =>
  mockStream([
    { type: "system", subtype: "init", session_id: "sess-971" },
    { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
    { type: "result", subtype: "success" },
  ]);

/** The #973 shape: a `success` subtype that is actually an API error. */
const API_ERROR_AS_SUCCESS_STREAM = () =>
  mockStream([
    { type: "system", subtype: "init", session_id: "sess-971" },
    {
      type: "result",
      subtype: "success",
      is_error: true,
      result: "model: unrecognized model 'not-a-real-model'",
      api_error_status: 400,
    },
  ]);

function baseConfig(overrides: Partial<ExecutionConfig> = {}): ExecutionConfig {
  return {
    phases: ["exec"],
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
    retry: false, // isolate: no cold-start/MCP-fallback retries
    ...overrides,
  };
}

function callOptions(index = 0): Record<string, unknown> | undefined {
  return queryMock.mock.calls[index]?.[0]?.options as
    Record<string, unknown> | undefined;
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockReturnValue(SUCCESS_STREAM());
});

describe("971 AC-2 end-to-end: the escalated rung reaches the real SDK query() call", () => {
  it("dispatches the NEXT rung's model, not the base, after a capability-bound trigger", async () => {
    const config = baseConfig({ modelLadder: ["sonnet", "opus", "fable"] });

    const { config: dispatchConfig, record } = withEscalatedModel(
      config,
      "exec",
      "LOOP_NO_DIFF",
      createLadderState(),
    );
    expect(record?.escalated).toBe("opus");

    await executePhaseWithRetry(971, "exec", dispatchConfig);

    expect(callOptions()?.model).toBe("opus");
  });

  it("with no ladder configured, no model override reaches query() at all", async () => {
    const config = baseConfig({});
    const { config: dispatchConfig } = withEscalatedModel(
      config,
      "exec",
      "LOOP_NO_DIFF",
      createLadderState(),
    );

    await executePhaseWithRetry(971, "exec", dispatchConfig);

    // Key-presence, not truthiness — matches #914's mutation-verified
    // absence gate (claude-code.phase-policy.test.ts AC-3).
    const opts = callOptions();
    expect(opts ? "model" in opts : false).toBe(false);
  });
});

describe("971 AC-10 end-to-end: the dispatch-time facts land on the PhaseResult", () => {
  it("attaches rung, base, escalated and trigger to the returned PhaseResult", async () => {
    const config = baseConfig({ modelLadder: ["sonnet", "opus"] });
    const { config: dispatchConfig } = withEscalatedModel(
      config,
      "exec",
      "LOOP_NO_DIFF",
      createLadderState(),
    );

    const result = await executePhaseWithRetry(971, "exec", dispatchConfig);

    expect(result.escalatedModel).toMatchObject({
      rung: 1,
      base: "sonnet",
      escalated: "opus",
      trigger: "LOOP_NO_DIFF",
    });
  });

  it("threads the facts into the phase env for the marker-emitting skill prose", async () => {
    const config = baseConfig({ modelLadder: ["sonnet", "opus"] });
    const { config: dispatchConfig } = withEscalatedModel(
      config,
      "exec",
      "LOOP_NO_DIFF",
      createLadderState(),
    );

    await executePhaseWithRetry(971, "exec", dispatchConfig);

    const env = callOptions()?.env as Record<string, string> | undefined;
    expect(env?.SEQUANT_MODEL_RUNG).toBe("1");
    expect(env?.SEQUANT_MODEL_BASE).toBe("sonnet");
    expect(env?.SEQUANT_MODEL_ESCALATED).toBe("opus");
    expect(env?.SEQUANT_ESCALATION_TRIGGER).toBe("LOOP_NO_DIFF");
    // Last rung of a two-rung ladder.
    expect(env?.SEQUANT_MODEL_TOP_OF_LADDER).toBe("1");
  });

  it("sets no escalation env vars on a non-escalated dispatch", async () => {
    await executePhaseWithRetry(971, "exec", baseConfig({}));

    const env = callOptions()?.env as Record<string, string> | undefined;
    expect(env && "SEQUANT_MODEL_RUNG" in env).toBe(false);
    expect(env && "SEQUANT_ESCALATION_TRIGGER" in env).toBe(false);
  });
});

describe("971 AC-13: the #973 result shape is retry-eligible, never convergence", () => {
  // No production change is needed for this AC — `claude-code.ts` already
  // converts the shape into `success: false` (landed with #973). This is a
  // labelled REGRESSION guard: an escalated dispatch to a model string the API
  // rejects must surface as a phase failure, or the ladder would read a
  // zero-work turn as having converged and stop escalating.
  it("a subtype:'success' result with is_error:true returns success:false", async () => {
    queryMock.mockReturnValue(API_ERROR_AS_SUCCESS_STREAM());

    const config = baseConfig({ modelLadder: ["sonnet", "not-a-real-model"] });
    const { config: dispatchConfig } = withEscalatedModel(
      config,
      "exec",
      "LOOP_NO_DIFF",
      createLadderState(),
    );

    const result = await executePhaseWithRetry(971, "exec", dispatchConfig);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unrecognized model/);
  });

  it("the failed escalated dispatch still records which rung it ran at", async () => {
    queryMock.mockReturnValue(API_ERROR_AS_SUCCESS_STREAM());

    const config = baseConfig({ modelLadder: ["sonnet", "not-a-real-model"] });
    const { config: dispatchConfig } = withEscalatedModel(
      config,
      "exec",
      "LOOP_NO_DIFF",
      createLadderState(),
    );

    const result = await executePhaseWithRetry(971, "exec", dispatchConfig);

    // A failed phase still spent its rung — the record must not be lost, or
    // the escalation history in the eventual handoff is wrong.
    expect(result.escalatedModel?.escalated).toBe("not-a-real-model");
  });
});

// ---------------------------------------------------------------------------
// #995 AC-D3 — the retry-path leak the quality plan flagged as most likely.
//
// AC-4's "halts without escalating" has to hold against the RETRY path, not
// only against the ladder: a cold-start re-spawn or the MCP fallback would
// re-dispatch the phase and hand the ladder a second observation to escalate
// on. Asserted on the DISPATCH COUNT — the real `query()` call — rather than
// on the final status, which a leak would not change.
// ---------------------------------------------------------------------------

/** A `qa` turn that declared the spec impossible and emitted no verdict. */
const SPEC_DIVERGENCE_STREAM = () =>
  mockStream([
    { type: "system", subtype: "init", session_id: "sess-995" },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: 'AC-2 cannot be satisfied.\n<!-- SEQUANT_PHASE: {"phase":"qa","status":"failed","timestamp":"2026-09-08T00:00:00.000Z","outcome":"SPEC_DIVERGENCE","divergenceAcs":"AC-2","error":"AC-2 requires the file to both exist and not exist"} -->',
          },
        ],
      },
    },
    { type: "result", subtype: "success" },
  ]);

describe("995 AC-D3: a SPEC_DIVERGENCE result is dispatched exactly once", () => {
  it("skips every cold-start retry and the MCP fallback", async () => {
    queryMock.mockReturnValue(SPEC_DIVERGENCE_STREAM());

    // `retry: true` + `mcp: true` is the maximally retry-happy configuration:
    // the mocked stream returns instantly, so the sub-second duration reads as
    // a cold-start failure and would normally buy 2 re-spawns plus an MCP
    // fallback. This is the configuration a leak would show up in.
    const result = await executePhaseWithRetry(
      995,
      "qa",
      baseConfig({ retry: true, mcp: true }),
    );

    expect(result.specDivergence).toEqual({
      acs: "AC-2",
      message: "AC-2 requires the file to both exist and not exist",
    });
    // The whole assertion: ONE dispatch. Not "it failed" — a leak fails too.
    expect(queryMock.mock.calls).toHaveLength(1);
  });

  it("a failing qa turn WITHOUT the marker still retries — the guard is the marker, not the failure", async () => {
    // The control arm. Without it, an early return that fired on every failing
    // qa phase would pass the test above while breaking cold-start recovery
    // for everyone.
    queryMock.mockReturnValue(
      mockStream([
        { type: "system", subtype: "init", session_id: "sess-995" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "no verdict here" }] },
        },
        { type: "result", subtype: "success" },
      ]),
    );

    const result = await executePhaseWithRetry(
      995,
      "qa",
      baseConfig({ retry: true, mcp: true }),
    );

    expect(result.specDivergence).toBeUndefined();
    expect(queryMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("a marker shown inside a fenced code block does not halt the run", async () => {
    // `parsePhaseMarkers` strips code blocks before matching, and this test is
    // what keeps that dependency honest: an agent that DOCUMENTS the escape
    // hatch (as the skills' own instructions do) must not thereby declare one.
    queryMock.mockReturnValue(
      mockStream([
        { type: "system", subtype: "init", session_id: "sess-995" },
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: 'To declare divergence, emit:\n```markdown\n<!-- SEQUANT_PHASE: {"phase":"qa","status":"failed","timestamp":"2026-09-08T00:00:00.000Z","outcome":"SPEC_DIVERGENCE","divergenceAcs":"AC-2"} -->\n```\nVerdict: AC_NOT_MET',
              },
            ],
          },
        },
        { type: "result", subtype: "success" },
      ]),
    );

    const result = await executePhaseWithRetry(995, "qa", baseConfig({}));
    expect(result.specDivergence).toBeUndefined();
  });
});
