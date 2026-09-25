/**
 * Skills pre-flight for `sequant run` (#813, worktree-targeted per #933).
 *
 * The claude-code driver executes phases as slash-command skills loaded from
 * project scope only (`settingSources: ["project"]`, #19/#711). Without
 * `.claude/skills/` the phase agent hunts for a command that can never
 * resolve, does no work, and the run surfaces as a bogus "spec retry"
 * failure. This module computes the skills a run actually needs — from the
 * phases resolved for that run, not a hardcoded triple — and checks them via
 * the same `checkSkillsInstalled` helper `doctor` uses, so the two cannot
 * drift.
 *
 * Drivers whose phase prompts do the work inline (aider's `driverOverrides`
 * templates in phase-registry.ts) never resolve skills, so the pre-flight is
 * skipped for them via `AgentDriver.resolvesSkills`.
 *
 * `run-orchestrator.ts` calls `runSkillsPreflight` once per provisioned
 * worktree (not once against the main checkout) — worktrees only materialize
 * *tracked* files, so an untracked `.claude/skills/` in the main checkout
 * passes here while every worktree phase agents actually run in has none.
 * It calls `driverResolvesSkills` first to skip the per-worktree loop
 * entirely for drivers that never resolve skills, rather than looping and
 * relying on each call's internal `{ok: true}` short-circuit.
 */

import type { AiderSettings } from "../settings.js";
import type { ExecutionConfig, Phase } from "./types.js";
import { getDriver } from "./drivers/index.js";
import {
  detectPhasesFromLabels,
  determinePhasesForIssue,
} from "./phase-mapper.js";
import { phaseRegistry } from "./phase-registry.js";
import { resolvePhaseAgent, resolvePhaseAgents } from "./phase-agent.js";
import { checkSkillsInstalled, SKILLS_DIR } from "../skills-check.js";

export interface SkillsPreflightInput {
  /** Agent driver name (default claude-code). */
  agent?: string;
  /**
   * Resolved per-phase policies (#1150). A phase whose `agent` overrides the
   * run-level one is checked against its own driver.
   */
  phasePolicies?: ExecutionConfig["phasePolicies"];
  /** Aider settings, forwarded to the driver factory. */
  aiderSettings?: AiderSettings;
  /** Base pipeline for explicit-phase runs (`config.phases`). */
  phases: Phase[];
  /** True when phases are auto-detected from labels (no explicit --phases). */
  autoDetectPhases: boolean;
  /** True when the quality loop may invoke the loop skill. */
  qualityLoop: boolean;
  /** Additive phase flags (`--testgen` / `--security-review`). */
  testgen?: boolean;
  securityReview?: boolean;
  /** Issues in the run, with their labels (drives per-issue phase rules). */
  issueNumbers: number[];
  issueInfoMap: Map<number, { title: string; labels: string[] }>;
  /** Project root to check under (default: `process.cwd()`). */
  cwd?: string;
}

export type SkillsPreflightResult =
  | { ok: true }
  | {
      ok: false;
      /** Human-readable cause, e.g. `missing skills: spec, exec, qa`. */
      cause: string;
      /** Missing skill names, in required order. */
      missingSkills: string[];
      /** Driver whose skill resolution triggered the check. */
      driverName: string;
      /** Remedy line for display. */
      remedy: string;
    };

/**
 * Compute the union of skills required by the phases resolved for this run.
 *
 * Explicit-phase runs start from `phases` as given; auto-detect runs start
 * from each issue's label-detected pipeline. Both then apply the additive
 * `--testgen` / `--security-review` / UI-label rules via
 * `determinePhasesForIssue`.
 *
 * Two deliberate over-approximations keep late-added phases covered:
 *
 * - An explicit `--testgen` / `--security-review` flag requires its skill
 *   unconditionally, even when `determinePhasesForIssue` would not insert
 *   the phase because `spec` is absent from the pipeline. On a resume where
 *   spec already completed, batch-executor inserts the phase anyway
 *   (`phases.includes("spec") || specAlreadyRan`), and the pre-flight cannot
 *   cheaply know `specAlreadyRan` — requiring the skill the user asked for
 *   is the safe superset.
 * - The loop skill is required when the quality loop is enabled up front OR
 *   when any issue's labels would auto-enable it (`complex`/`refactor`/...,
 *   via `detectPhasesFromLabels().qualityLoop`), since the loop skill is
 *   invoked the same way as any phase skill.
 *
 * Phases recommended later by spec output (`parseRecommendedWorkflow`)
 * remain unknowable at pre-flight time — the accepted gap documented on
 * #813.
 *
 * Exported for direct unit testing (AC-2).
 */
export function resolveRequiredSkills(input: RequiredPhasesInput): string[] {
  return resolveRequiredPhases(input).map(
    (phase) => phaseRegistry.get(phase).skill,
  );
}

type RequiredPhasesInput = Pick<
  SkillsPreflightInput,
  | "phases"
  | "autoDetectPhases"
  | "qualityLoop"
  | "testgen"
  | "securityReview"
  | "issueNumbers"
  | "issueInfoMap"
>;

/** The phases behind {@link resolveRequiredSkills}, in required order. */
function resolveRequiredPhases(input: RequiredPhasesInput): string[] {
  const additiveFlags = {
    testgen: input.testgen,
    securityReview: input.securityReview,
  };
  const requiredPhases = new Set<string>();
  let qualityLoop = input.qualityLoop;
  for (const issueNumber of input.issueNumbers) {
    const labels = input.issueInfoMap.get(issueNumber)?.labels ?? [];
    const detected = input.autoDetectPhases
      ? detectPhasesFromLabels(labels)
      : null;
    if (detected?.qualityLoop) qualityLoop = true;
    const basePhases = detected ? detected.phases : input.phases;
    for (const phase of determinePhasesForIssue(
      basePhases,
      labels,
      additiveFlags,
    )) {
      requiredPhases.add(phase);
    }
  }
  if (input.testgen) requiredPhases.add("testgen");
  if (input.securityReview) requiredPhases.add("security-review");
  if (qualityLoop) requiredPhases.add("loop");

  return [...requiredPhases];
}

/**
 * True when the selected driver resolves phases from `.claude/skills/` at
 * all. Callers use this to skip the pre-flight loop entirely for drivers
 * like aider (#933 AC-3: zero pre-flight calls, not a per-call short-circuit).
 * An unknown driver name defaults to `true` so it still reaches
 * `runSkillsPreflight`, which owns the safe fallback for that case.
 */
export function driverResolvesSkills(
  agent: string | undefined,
  aiderSettings: AiderSettings | undefined,
): boolean {
  try {
    return getDriver(agent, { aiderSettings }).resolvesSkills;
  } catch {
    return true;
  }
}

/**
 * True when ANY driver the run's phases resolve to reads `.claude/skills/`
 * (#1150): an aider run whose exec phase is overridden to claude-code still
 * needs the exec skill installed.
 */
export function runResolvesSkills(
  config: Pick<ExecutionConfig, "agent" | "phasePolicies" | "aiderSettings">,
): boolean {
  const phases = Object.keys(config.phasePolicies ?? {});
  return resolvePhaseAgents(config, phases).some((agent) =>
    driverResolvesSkills(agent, config.aiderSettings),
  );
}

/**
 * Run the skills pre-flight. Returns `{ok: true}` when the run may proceed:
 * either every required skill is installed, or the selected driver does not
 * resolve skills at all (AC-3).
 */
export async function runSkillsPreflight(
  input: SkillsPreflightInput,
): Promise<SkillsPreflightResult> {
  // #1150: each required phase is checked against the driver IT runs on.
  // Only phases on a skill-resolving driver need their skill installed. A
  // phase whose driver name is unknown is skipped — phase-executor surfaces
  // the unknown-driver error through its normal per-issue failure path, and
  // the pre-flight must not be what crashes the run with a raw throw.
  const policyConfig = {
    agent: input.agent,
    phasePolicies: input.phasePolicies,
  };
  const required: { skill: string; driverName: string }[] = [];
  for (const phase of resolveRequiredPhases(input)) {
    let driver;
    try {
      driver = getDriver(resolvePhaseAgent(policyConfig, phase), {
        aiderSettings: input.aiderSettings,
      });
    } catch {
      continue;
    }
    if (!driver.resolvesSkills) continue;
    required.push({
      skill: phaseRegistry.get(phase).skill,
      driverName: driver.name,
    });
  }
  if (required.length === 0) return { ok: true };

  const { skillsDirExists, missingSkills } = await checkSkillsInstalled(
    required.map((r) => r.skill),
    input.cwd,
  );
  if (missingSkills.length === 0) return { ok: true };

  // Name the driver of the first phase whose skill is missing, so a mixed
  // run reports the driver that actually needs it.
  const driverName =
    required.find((r) => missingSkills.includes(r.skill))?.driverName ??
    required[0].driverName;
  const cause = skillsDirExists
    ? `missing skills: ${missingSkills.join(", ")}`
    : `missing ${SKILLS_DIR}/ directory (needs: ${missingSkills.join(", ")})`;
  return {
    ok: false,
    cause,
    missingSkills,
    driverName,
    remedy:
      `The ${driverName} driver resolves phases from ${SKILLS_DIR}/ — ` +
      `run \`sequant sync\` to install them, then re-run.`,
  };
}
