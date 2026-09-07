/**
 * Producer parity guard (#863 AC-4).
 *
 * `ExecutionConfig` is meant to have exactly ONE producer:
 * `buildExecutionConfig` in `config-resolver.ts`. `ready-gate.ts`'s
 * `buildPhaseConfig` is a derivation of it, not a second producer — it spreads
 * the caller's resolved config and applies only the six gate-semantic
 * overrides in `GATE_CONFIG_OVERRIDES`.
 *
 * That was not true before #863. `buildPhaseConfig` used to build its own
 * literal from a flat bag of primitives, which meant every field the resolver
 * grew afterwards silently defaulted in the gate path: `agent`/`aiderSettings`
 * (so an aider-configured project ran its gate on claude-code), plus `retry`,
 * `skipVerification`, `noSmartTests`, `autoWaitMinutes`, `relayEnabled`,
 * `isolateParallel` and `issueType`. #914, #915 and #936 each patched one
 * instance of that drift by hand.
 *
 * This test is the standing guard against a fourth instance. It compares the
 * two producers over the UNION of their keys — so a field added to only one of
 * them is caught, not skipped — and permits a difference only for keys in
 * {@link GATE_OVERRIDES}, each carrying a reason.
 *
 * Per #863 OQ-12, `noSmartTests` and `retry` are plumbed (`skipVerification`
 * is declared on `ExecutionConfig` but no producer sets it and nothing reads
 * it, so there is no behaviour to assert — see the PR)
 * (inherited from the parent config) and therefore deliberately NOT allowlisted.
 */

import { describe, it, expect } from "vitest";
import { buildExecutionConfig, resolveRunOptions } from "./config-resolver.js";
import {
  buildPhaseConfig,
  GATE_CONFIG_OVERRIDES,
  type RunReadyGateOptions,
} from "./ready-gate.js";
import type { ExecutionConfig, RunOptions } from "./types.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import type { SequantSettings } from "../settings.js";

/**
 * Keys the ready gate is PERMITTED to differ on, with the reason each one is
 * the gate's own judgement rather than inherited configuration.
 *
 * Read as "permitted to differ", not "required to differ" — a future gate that
 * legitimately inherits one of these must not fail this test.
 *
 * Adding a key here is the explicit act this test exists to force: it means
 * declaring, in review, that the gate overriding it is intentional.
 */
const GATE_OVERRIDES: Record<string, string> = {
  phases: "The gate dispatches qa/loop itself; it never runs a phase list.",
  qualityLoop: "The gate IS the quality loop — it must not nest another.",
  sequential: "One phase at a time against one worktree, by construction.",
  concurrency: "The gate is never the concurrency layer (always 1).",
  parallel: "Single-issue by construction, so never the parallel-output mode.",
  dryRun:
    "The gate's phases are the work it was asked to do; a dry gate would " +
    "certify nothing. (Pre-existing behaviour, see #863 OQ-2.)",
};

function settingsWith(run: Partial<SequantSettings["run"]>): SequantSettings {
  return {
    ...DEFAULT_SETTINGS,
    run: { ...DEFAULT_SETTINGS.run, ...run },
  } as SequantSettings;
}

/** Everything `buildPhaseConfig` needs besides the config under test. */
function gateOpts(config: ExecutionConfig): RunReadyGateOptions {
  return {
    issueNumber: 863,
    worktreePath: "/tmp/worktree-863",
    policy: "ac",
    maxIterations: config.maxIterations,
    config,
    runPhase: () => {
      throw new Error("not dispatched in this test");
    },
  };
}

/**
 * Compare the two producers over the union of their keys.
 * Returns the keys that differ and are NOT allowlisted.
 */
function unallowedDiffs(
  resolved: ExecutionConfig,
  gate: ExecutionConfig,
): string[] {
  const keys = new Set([...Object.keys(resolved), ...Object.keys(gate)]);
  const offenders: string[] = [];
  for (const key of keys) {
    if (key in GATE_OVERRIDES) continue;
    const a = (resolved as Record<string, unknown>)[key];
    const b = (gate as Record<string, unknown>)[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) offenders.push(key);
  }
  return offenders;
}

/** The scenarios worth diffing — each exercises a different slice of the resolver. */
const SCENARIOS: Array<{
  name: string;
  options: Partial<RunOptions>;
  run: Partial<SequantSettings["run"]>;
}> = [
  { name: "defaults", options: {}, run: {} },
  {
    name: "aider configured (the #863 motivating case)",
    options: {},
    run: { agent: "aider", aider: { model: "gpt-4o" } },
  },
  {
    name: "retry disabled + verification skipped (OQ-12 siblings)",
    options: { noRetry: true, noSmartTests: true },
    run: {},
  },
  {
    name: "mcp off with an allowlist, escalation + policies on",
    options: { noMcp: true, models: "qa=sonnet", escalateEffort: true },
    run: { mcpAllowlist: ["stripe", "notion"], effortEscalation: true },
  },
  {
    name: "auto-wait, relay off, isolate-parallel",
    options: { autoWaitMinutes: 45, relay: false, isolateParallel: true },
    run: {},
  },
];

describe("#863 AC-4: ExecutionConfig producer parity", () => {
  it.each(SCENARIOS)(
    "buildPhaseConfig differs from buildExecutionConfig only on the allowlist — $name",
    ({ options, run }) => {
      const settings = settingsWith(run);
      const resolved = buildExecutionConfig(
        resolveRunOptions(options as RunOptions, settings),
        settings,
        1,
      );
      const gate = buildPhaseConfig(gateOpts(resolved), {});

      expect(unallowedDiffs(resolved, gate)).toEqual([]);
    },
  );

  it("inherits the driver settings the gate used to drop (#863's actual bug)", () => {
    const settings = settingsWith({
      agent: "aider",
      aider: { model: "gpt-4o" },
    });
    const resolved = buildExecutionConfig(
      resolveRunOptions({} as RunOptions, settings),
      settings,
      1,
    );
    const gate = buildPhaseConfig(gateOpts(resolved), {});

    expect(gate.agent).toBe("aider");
    expect(gate.aiderSettings).toEqual({ model: "gpt-4o" });
  });

  it("inherits the OQ-12 sibling fields rather than hardcoding them", () => {
    const settings = settingsWith({});
    const resolved = buildExecutionConfig(
      resolveRunOptions(
        {
          noRetry: true,
          noSmartTests: true,
        } as RunOptions,
        settings,
      ),
      settings,
      1,
    );
    const gate = buildPhaseConfig(gateOpts(resolved), {});

    // Each of these was a hardcoded literal in buildPhaseConfig before #863.
    expect(gate.retry).toBe(resolved.retry);
    expect(gate.retry).toBe(false);
    expect(gate.noSmartTests).toBe(resolved.noSmartTests);
  });

  it("keeps the gate's override set to exactly the documented allowlist", () => {
    // Guards the other direction: a seventh override added to the gate without
    // a reason string in GATE_OVERRIDES fails here rather than silently
    // widening what the parity check above is allowed to ignore.
    expect(Object.keys(GATE_CONFIG_OVERRIDES).sort()).toEqual(
      Object.keys(GATE_OVERRIDES).sort(),
    );
  });

  it("allowlist entries are permitted to differ, not required to differ", () => {
    // A gate that starts inheriting an allowlisted key must not fail parity.
    const settings = settingsWith({});
    const resolved = buildExecutionConfig(
      resolveRunOptions({} as RunOptions, settings),
      settings,
      1,
    );
    // `dryRun` happens to match already (both false) — parity still passes.
    const gate = buildPhaseConfig(gateOpts(resolved), {});
    expect(gate.dryRun).toBe(resolved.dryRun);
    expect(unallowedDiffs(resolved, gate)).toEqual([]);
  });
});
