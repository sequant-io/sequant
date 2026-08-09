/**
 * Test for #914 AC-5 — `ready-gate.ts:buildPhaseConfig` (producer 2) must
 * resolve per-phase model/effort with the SAME precedence as
 * `config-resolver.ts:buildExecutionConfig` (producer 1, see
 * `config-resolver.phase-policy.test.ts`). This is the exact pair that
 * drifted in #833.
 *
 * `buildPhaseConfig` is not exported, so this drives it indirectly through
 * `runReadyGate`'s injectable `runPhase`, mirroring the `scriptedRunner`
 * pattern already used in `ready-gate.test.ts`. Model/effort resolution
 * happens one layer down from here: `buildPhaseConfig` only carries the
 * resolved `phasePolicies` map onto the `ExecutionConfig`; `phase-executor.ts`
 * is the single site that picks out the entry for the phase actually running
 * and turns it into `AgentExecutionConfig.model`/`.effort` (see
 * `phase-executor.ts`'s `agentConfig` build site). So this test asserts on
 * `config.phasePolicies`, not a flat `config.model`/`config.effort`.
 */

import { describe, it, expect } from "vitest";
import { runReadyGate, type RunReadyGateOptions } from "./ready-gate.js";
import type { PhaseResult } from "./types.js";

describe("#914 AC-5: ready-gate buildPhaseConfig resolves phasePolicies (producer 2)", () => {
  it("carries the resolved phasePolicies map into the runPhase config", async () => {
    // Given: RunReadyGateOptions.phasePolicies already resolved (as
    // commands/ready.ts does via the shared resolvePhasePolicies, CLI >
    // settings > absent — identical to buildExecutionConfig's producer)
    const seen: Array<
      Record<string, { model?: string; effort?: string }> | undefined
    > = [];

    const opts: RunReadyGateOptions = {
      issueNumber: 914,
      worktreePath: "/tmp/worktree-914",
      policy: "ac",
      maxIterations: 1,
      phaseTimeout: 1800,
      mcp: false,
      classifyChangesFn: () => ({ kind: "commits" }),
      readTokensUsed: () => 0,
      snapshotFn: () => ({ sha: "sha-1", dirty: [] }),
      phasePolicies: { qa: { model: "sonnet", effort: "medium" } },
      runPhase: (phase, config) => {
        seen.push(config.phasePolicies);
        const result: PhaseResult = {
          phase,
          success: true,
          verdict: phase === "qa" ? "READY_FOR_MERGE" : undefined,
        };
        return Promise.resolve(result);
      },
    };

    // When: runReadyGate dispatches the qa phase
    await runReadyGate(opts);

    // Then: the ExecutionConfig handed to runPhase("qa", ...) carries the
    // resolved qa policy — identical resolution to buildExecutionConfig's
    // producer (config-resolver.phase-policy.test.ts).
    expect(seen[0]?.qa).toEqual({ model: "sonnet", effort: "medium" });
  });
});
