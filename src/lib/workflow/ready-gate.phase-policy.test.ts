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

describe("#915 AC-1/AC-3/AC-7: ready-gate resolves + applies effortEscalation (producer 2)", () => {
  it("carries opts.effortEscalation onto every dispatched ExecutionConfig", async () => {
    const seen: Array<boolean | undefined> = [];
    const opts: RunReadyGateOptions = {
      issueNumber: 915,
      worktreePath: "/tmp/worktree-915",
      policy: "ac",
      maxIterations: 1,
      phaseTimeout: 1800,
      mcp: false,
      classifyChangesFn: () => ({ kind: "commits" }),
      readTokensUsed: () => 0,
      snapshotFn: () => ({ sha: "sha-1", dirty: [] }),
      effortEscalation: true,
      runPhase: (phase, config) => {
        seen.push(config.effortEscalation);
        const result: PhaseResult = {
          phase,
          success: true,
          verdict: phase === "qa" ? "READY_FOR_MERGE" : undefined,
        };
        return Promise.resolve(result);
      },
    };
    await runReadyGate(opts);
    expect(seen[0]).toBe(true);
  });

  it("escalates the qa dispatch on the SECOND QA pass, not the first (AC-7: no retry, no escalation)", async () => {
    const seenEfforts: Array<string | undefined> = [];
    let qaCalls = 0;
    // Each snapshot call returns a fresh sha, so the before/after pair taken
    // around every `loop` dispatch always shows a diff — simulating a loop
    // that commits a real fix each time.
    let snapshotCalls = 0;
    const opts: RunReadyGateOptions = {
      issueNumber: 915,
      worktreePath: "/tmp/worktree-915",
      policy: "ac",
      maxIterations: 3,
      phaseTimeout: 1800,
      mcp: false,
      classifyChangesFn: () => ({ kind: "commits" }),
      readTokensUsed: () => 0,
      snapshotFn: () => ({ sha: `sha-${snapshotCalls++}`, dirty: [] }),
      effortEscalation: true,
      phasePolicies: { qa: { effort: "high" } },
      runPhase: (phase, config) => {
        if (phase === "qa") {
          qaCalls++;
          seenEfforts.push(config.phasePolicies?.qa?.effort);
          const result: PhaseResult = {
            phase,
            success: true,
            // First pass: not ready, so the loop retries. Second pass: ready.
            verdict: qaCalls === 1 ? "AC_NOT_MET" : "READY_FOR_MERGE",
            summary: { gaps: qaCalls === 1 ? ["fix the thing"] : [] },
          };
          return Promise.resolve(result);
        }
        // loop phase — succeed and let compareLoopProgress report progress
        // via the differing snapshot sha above.
        return Promise.resolve({ phase, success: true });
      },
    };

    const result = await runReadyGate(opts);

    expect(seenEfforts).toEqual(["high", "xhigh"]);
    expect(result.effortEscalations).toEqual([
      { phase: "qa", base: "high", escalated: "xhigh" },
    ]);
    expect(result.reason).toBe("READY_FOR_MERGE");
  });
});
