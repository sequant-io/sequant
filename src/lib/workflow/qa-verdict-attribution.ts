/**
 * The attribution line that ends a QA verdict comment (#1521).
 *
 * Computed from the phase records and the resolved config, never from agent
 * output: a forged "Reviewed by …" string in a phase's text cannot change it.
 * `PhaseResult` carries the model (`resolvedModel`) but not the driver, so the
 * driver comes from `resolvePhaseAgent` (#1150), the single source for it.
 * Caveat: a mid-run fallback to another driver is not visible here.
 */

import { latestPhaseResult } from "./latest-phase.js";
import { resolvePhaseAgent } from "./phase-agent.js";
import type { ExecutionConfig, PhaseResult } from "./types.js";

/** One side of the attribution: a driver and, when reported, its model. */
export interface Attributee {
  agent: string;
  model?: string;
}

const NOT_REPORTED = "model not reported";

function describe(side: Attributee): string {
  return `${side.agent} (${side.model ?? NOT_REPORTED})`;
}

/**
 * Build the italic attribution line. `author` is absent when no exec/loop
 * phase ran in this run (e.g. `--phases qa`); the line then says so instead of
 * guessing.
 */
export function buildQaAttributionLine(
  reviewer: Attributee,
  author?: Attributee,
): string {
  const written = author
    ? `the change was written by ${describe(author)}`
    : "the change author was not recorded";
  return `_Reviewed in a separate session by ${describe(reviewer)}; ${written}._`;
}

function modelOf(
  result: PhaseResult | undefined,
  config: Pick<ExecutionConfig, "phasePolicies">,
  phase: string,
): string | undefined {
  const policy = config.phasePolicies?.[phase];
  return result?.resolvedModel ?? policy?.model ?? policy?.requestedModel;
}

/**
 * Attribution line for the latest qa result against the latest exec/loop
 * result (a loop fix may have written the final change).
 */
export function attributionFromPhases(
  phaseResults: readonly PhaseResult[],
  config: Pick<ExecutionConfig, "agent" | "phasePolicies">,
): string {
  const list = [...phaseResults];
  const qa = latestPhaseResult(list, "qa");
  const exec = latestPhaseResult(list, "exec");
  const loop = latestPhaseResult(list, "loop");
  const authorPhase =
    exec && loop
      ? list.lastIndexOf(loop) > list.lastIndexOf(exec)
        ? loop
        : exec
      : (exec ?? loop);
  const reviewer: Attributee = {
    agent: resolvePhaseAgent(config, "qa"),
    model: modelOf(qa, config, "qa"),
  };
  const author = authorPhase
    ? {
        agent: resolvePhaseAgent(config, authorPhase.phase),
        model: modelOf(authorPhase, config, authorPhase.phase),
      }
    : undefined;
  return buildQaAttributionLine(reviewer, author);
}
