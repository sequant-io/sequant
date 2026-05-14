/**
 * Phase detection and mapping utilities.
 *
 * Extracts label-to-phase detection logic and workflow parsing
 * from the run command so it can be reused by batch-executor
 * and other consumers.
 *
 * @module phase-mapper
 */

import type { Phase } from "./types.js";
import { phaseRegistry } from "./phase-registry.js";

/**
 * Minimal options interface for phase mapping.
 * Avoids importing the full RunOptions from run.ts.
 */
interface PhaseMapperOptions {
  testgen?: boolean;
  securityReview?: boolean;
}

/**
 * Bug-related labels (used by downstream metadata consumers).
 *
 * Issue-type metadata — NOT phase-trigger rules. The registry-driven
 * `detectPhasesFromLabels` below does not consult this list. It stays
 * here because `batch-executor.ts` and other modules read it for
 * `issueType` propagation and similar non-phase concerns.
 */
export const BUG_LABELS = ["bug", "fix", "hotfix", "patch"];

/**
 * Documentation labels (used for issueType propagation and downstream metadata).
 *
 * Issue-type metadata — NOT phase-trigger rules. See BUG_LABELS comment.
 */
export const DOCS_LABELS = ["docs", "documentation", "readme"];

/**
 * Complex labels that enable quality loop.
 *
 * Quality-loop trigger — NOT a phase-trigger rule (does not add the loop
 * *phase*; only flips the `qualityLoop` flag on the run config). Kept
 * out of the phase registry by design.
 */
export const COMPLEX_LABELS = ["complex", "refactor", "breaking", "major"];

/**
 * Look up label-based detect rules from the registry, returning the set
 * of phases whose `detect.labels` intersect the issue's labels. Comparison
 * is case-insensitive (labels lowercased at the call site).
 */
function detectPhasesFromRegistry(lowerLabels: string[]): Set<string> {
  const matched = new Set<string>();
  for (const def of phaseRegistry.list()) {
    const triggers = def.detect?.labels;
    if (!triggers || triggers.length === 0) continue;
    const hit = triggers.some((t) => lowerLabels.includes(t.toLowerCase()));
    if (hit) matched.add(def.name);
  }
  return matched;
}

/**
 * Detect phases based on issue labels (like /assess logic).
 *
 * Label → phase mapping now lives in `PhaseDefinition.detect.labels`. Only
 * the *insertion position* of detected phases remains baked in here, because
 * pipeline ordering depends on the phase's role (security-review goes after
 * spec; test goes before qa).
 */
export function detectPhasesFromLabels(labels: string[]): {
  phases: Phase[];
  qualityLoop: boolean;
} {
  const lowerLabels = labels.map((l) => l.toLowerCase());

  // Quality loop is a registry-independent label trigger (see COMPLEX_LABELS).
  const isComplex = lowerLabels.some((label) =>
    COMPLEX_LABELS.some((complexLabel) => label === complexLabel),
  );

  const matched = detectPhasesFromRegistry(lowerLabels);
  const isUI = matched.has("test");
  const isSecurity = matched.has("security-review");

  // Build phase list — spec is always included by default (#533).
  // Bug/docs labels no longer short-circuit spec; downstream consumers
  // (e.g. `issueType: "docs"` propagation) still use DOCS_LABELS for
  // metadata purposes, not for phase selection.
  const phases: Phase[] = isUI
    ? ["spec", "exec", "test", "qa"]
    : ["spec", "exec", "qa"];

  // Add security-review phase after spec if security labels detected
  if (isSecurity && phases.includes("spec")) {
    const specIndex = phases.indexOf("spec");
    phases.splice(specIndex + 1, 0, "security-review");
  }

  return { phases, qualityLoop: isComplex };
}

/**
 * Parse recommended workflow from /spec output
 *
 * Looks for:
 * ## Recommended Workflow
 * **Phases:** exec → qa
 * **Quality Loop:** enabled|disabled
 */
export function parseRecommendedWorkflow(output: string): {
  phases: Phase[];
  qualityLoop: boolean;
} | null {
  // Find the Recommended Workflow section
  const workflowMatch = output.match(
    /## Recommended Workflow[\s\S]*?\*\*Phases:\*\*\s*([^\n]+)/i,
  );

  if (!workflowMatch) {
    return null;
  }

  // Parse phases from "exec → qa" or "spec → exec → test → qa" format
  const phasesStr = workflowMatch[1].trim();
  const phaseNames = phasesStr
    .split(/\s*→\s*|\s*->\s*|\s*,\s*/)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);

  // Validate against the registry — accepts any registered phase.
  const validPhases: Phase[] = [];
  for (const name of phaseNames) {
    if (phaseRegistry.has(name)) {
      validPhases.push(name);
    }
  }

  if (validPhases.length === 0) {
    return null;
  }

  // Parse quality loop setting
  const qualityLoopMatch = output.match(
    /\*\*Quality Loop:\*\*\s*(enabled|disabled|true|false|yes|no)/i,
  );
  const qualityLoop = qualityLoopMatch
    ? ["enabled", "true", "yes"].includes(qualityLoopMatch[1].toLowerCase())
    : false;

  return { phases: validPhases, qualityLoop };
}

/**
 * Check if an issue has UI-related labels.
 *
 * Sources the label list from the `test` phase's `detect.labels` entry in
 * the registry — same data as `detectPhasesFromLabels` consults, just
 * exposed as a boolean for callers that only need the yes/no answer
 * (e.g. test phase insertion in `determinePhasesForIssue`).
 */
export function hasUILabels(labels: string[]): boolean {
  const testTriggers = phaseRegistry.has("test")
    ? (phaseRegistry.get("test").detect?.labels ?? [])
    : [];
  if (testTriggers.length === 0) return false;
  const lowered = new Set(testTriggers.map((t) => t.toLowerCase()));
  return labels.some((label) => lowered.has(label.toLowerCase()));
}

/**
 * Determine phases to run based on options and issue labels
 */
export function determinePhasesForIssue(
  basePhases: Phase[],
  labels: string[],
  options: PhaseMapperOptions,
): Phase[] {
  const phases = [...basePhases];

  // Add testgen phase after spec if requested
  if (options.testgen && phases.includes("spec")) {
    const specIndex = phases.indexOf("spec");
    if (!phases.includes("testgen")) {
      phases.splice(specIndex + 1, 0, "testgen");
    }
  }

  // Add security-review phase after spec if requested.
  // Idempotent vs label-based auto-detection in detectPhasesFromLabels.
  if (options.securityReview && phases.includes("spec")) {
    const specIndex = phases.indexOf("spec");
    if (!phases.includes("security-review")) {
      phases.splice(specIndex + 1, 0, "security-review");
    }
  }

  // Auto-detect UI issues and add test phase
  if (hasUILabels(labels) && !phases.includes("test")) {
    // Add test phase before qa if present, otherwise at the end
    const qaIndex = phases.indexOf("qa");
    if (qaIndex !== -1) {
      phases.splice(qaIndex, 0, "test");
    } else {
      phases.push("test");
    }
  }

  return phases;
}
