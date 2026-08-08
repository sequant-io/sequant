/**
 * Test stub for #914 AC-5 — `ready-gate.ts:buildPhaseConfig` (producer 2)
 * must resolve per-phase model/effort with the SAME precedence as
 * `config-resolver.ts:buildExecutionConfig` (producer 1, see
 * `config-resolver.phase-policy.test.ts`). This is the exact pair that
 * drifted in #833.
 *
 * `buildPhaseConfig` is not exported, so this drives it indirectly through
 * `runReadyGate`'s injectable `runPhase`, mirroring the `scriptedRunner`
 * pattern already used in `ready-gate.test.ts`. `RunReadyGateOptions` does
 * not have a `phasePolicies` field yet — the `as unknown as` cast below is
 * intentional and should be removed once AC-5 adds it to the real type.
 */

import { describe, it, expect } from "vitest";
import { runReadyGate, type RunReadyGateOptions } from "./ready-gate.js";
import type { PhaseResult } from "./types.js";

describe("#914 AC-5: ready-gate buildPhaseConfig resolves phasePolicies (producer 2)", () => {
  it("resolves the qa phase's configured model/effort into the runPhase config", async () => {
    // Given: RunReadyGateOptions carrying a resolved qa policy (as
    // buildExecutionConfig's caller would pass down after CLI>settings>absent
    // resolution)
    const seen: Array<{ model?: string; effort?: string }> = [];

    const opts = {
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
      runPhase: (phase: "qa" | "loop", config: Record<string, unknown>) => {
        seen.push({
          model: config.model as string | undefined,
          effort: config.effort as string | undefined,
        });
        const result: PhaseResult = {
          phase,
          success: true,
          verdict: phase === "qa" ? "READY_FOR_MERGE" : undefined,
        };
        return Promise.resolve(result);
      },
    } as unknown as RunReadyGateOptions;

    // When: runReadyGate dispatches the qa phase
    await runReadyGate(opts);

    // Then: the config handed to runPhase("qa", ...) carries the resolved
    // model/effort — identical resolution to buildExecutionConfig's producer.
    expect(seen[0]?.model).toBe("sonnet");
    expect(seen[0]?.effort).toBe("medium");
  });
});
