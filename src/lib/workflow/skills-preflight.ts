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
 * `determinePhasesForIssue`, and the loop skill is added when the quality
 * loop is enabled (it is invoked the same way as any phase skill).
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
  for (const issueNumber of input.issueNumbers) {
    const labels = input.issueInfoMap.get(issueNumber)?.labels ?? [];
    const basePhases = input.autoDetectPhases
      ? detectPhasesFromLabels(labels).phases
      : input.phases;
    for (const phase of determinePhasesForIssue(
      basePhases,
      labels,
      additiveFlags,
    )) {
      requiredPhases.add(phase);
    }
  }
  if (input.qualityLoop) requiredPhases.add("loop");

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
  const driver = getDriver(input.agent, {
    aiderSettings: input.aiderSettings,
  });
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
