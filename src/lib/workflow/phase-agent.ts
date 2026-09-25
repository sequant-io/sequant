/**
 * Per-phase agent driver resolution (#1150).
 *
 * `run.agent` picks the driver for a whole run; `run.phases.<phase>.agent`
 * overrides it for one phase. Every site that needs "which driver runs this
 * phase" asks here, so the precedence lives in one function and no call site
 * reads the run-level agent directly.
 */

import type { ExecutionConfig } from "./types.js";

/** The driver a run uses when neither the phase nor the run names one. */
export const DEFAULT_AGENT = "claude-code";

/**
 * The agent driver that runs `phase`: the phase's own `agent`, else the
 * run-level agent, else claude-code.
 */
export function resolvePhaseAgent(
  config: Pick<ExecutionConfig, "agent" | "phasePolicies">,
  phase: string,
): string {
  return config.phasePolicies?.[phase]?.agent ?? config.agent ?? DEFAULT_AGENT;
}

/**
 * The run-level agent: what a phase with no override of its own resolves to.
 */
export function resolveRunAgent(
  config: Pick<ExecutionConfig, "agent">,
): string {
  // With no phase policies, every phase resolves to the run-level agent.
  return resolvePhaseAgent({ ...config, phasePolicies: undefined }, "");
}

/**
 * The distinct drivers `phases` resolve to, run-level agent first.
 */
export function resolvePhaseAgents(
  config: Pick<ExecutionConfig, "agent" | "phasePolicies">,
  phases: readonly string[],
): string[] {
  const agents = new Set<string>([resolveRunAgent(config)]);
  for (const phase of phases) agents.add(resolvePhaseAgent(config, phase));
  return [...agents];
}
