/**
 * Skills pre-flight for `sequant run` (#813).
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
 */

import type { AiderSettings } from "../settings.js";
import type { Phase } from "./types.js";
import { getDriver } from "./drivers/index.js";
import {
  detectPhasesFromLabels,
  determinePhasesForIssue,
} from "./phase-mapper.js";
import { phaseRegistry } from "./phase-registry.js";
import { checkSkillsInstalled, SKILLS_DIR } from "../skills-check.js";

export interface SkillsPreflightInput {
  /** Agent driver name (default claude-code). */
  agent?: string;
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
export function resolveRequiredSkills(
  input: Pick<
    SkillsPreflightInput,
    | "phases"
    | "autoDetectPhases"
    | "qualityLoop"
    | "testgen"
    | "securityReview"
    | "issueNumbers"
    | "issueInfoMap"
  >,
): string[] {
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

  return [...requiredPhases].map((phase) => phaseRegistry.get(phase).skill);
}

/**
 * Run the skills pre-flight. Returns `{ok: true}` when the run may proceed:
 * either every required skill is installed, or the selected driver does not
 * resolve skills at all (AC-3).
 */
export async function runSkillsPreflight(
  input: SkillsPreflightInput,
): Promise<SkillsPreflightResult> {
  let driver;
  try {
    driver = getDriver(input.agent, {
      aiderSettings: input.aiderSettings,
    });
  } catch {
    // Unknown driver name (bad `settings.run.agent`). Don't let the
    // pre-flight be the thing that crashes the run with a raw throw —
    // skip it and let phase-executor surface the unknown-driver error
    // through its normal per-issue failure path.
    return { ok: true };
  }
  if (!driver.resolvesSkills) return { ok: true };

  const requiredSkills = resolveRequiredSkills(input);
  const { skillsDirExists, missingSkills } = await checkSkillsInstalled(
    requiredSkills,
    input.cwd,
  );
  if (missingSkills.length === 0) return { ok: true };

  const cause = skillsDirExists
    ? `missing skills: ${missingSkills.join(", ")}`
    : `missing ${SKILLS_DIR}/ directory (needs: ${missingSkills.join(", ")})`;
  return {
    ok: false,
    cause,
    missingSkills,
    driverName: driver.name,
    remedy:
      `The ${driver.name} driver resolves phases from ${SKILLS_DIR}/ — ` +
      `run \`sequant sync\` to install them, then re-run.`,
  };
}
