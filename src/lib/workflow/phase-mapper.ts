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

/**
 * Minimal options interface for phase mapping.
 * Avoids importing the full RunOptions from run.ts.
 */
interface PhaseMapperOptions {
  testgen?: boolean;
}

/**
 * UI-related labels that trigger automatic test phase
 */
export const UI_LABELS = ["ui", "frontend", "admin", "web", "browser"];

/**
 * Bug-related labels that skip spec phase
 */
export const BUG_LABELS = ["bug", "fix", "hotfix", "patch"];

/**
 * Documentation labels that skip spec phase
 */
export const DOCS_LABELS = ["docs", "documentation", "readme"];

/**
 * Complex labels that enable quality loop
 */
export const COMPLEX_LABELS = ["complex", "refactor", "breaking", "major"];

/**
 * Security-related labels that trigger security-review phase
 */
export const SECURITY_LABELS = [
  "security",
  "auth",
  "authentication",
  "permissions",
  "admin",
];

/**
 * Detect phases based on issue labels (like /solve logic)
 */
export function detectPhasesFromLabels(labels: string[]): {
  phases: Phase[];
  qualityLoop: boolean;
} {
  const lowerLabels = labels.map((l) => l.toLowerCase());

  // Check for bug/fix labels → exec → qa (skip spec)
  const isBugFix = lowerLabels.some((label) =>
    BUG_LABELS.some((bugLabel) => label.includes(bugLabel)),
  );

  // Check for docs labels → exec → qa (skip spec)
  const isDocs = lowerLabels.some((label) =>
    DOCS_LABELS.some((docsLabel) => label.includes(docsLabel)),
  );

  // Check for UI labels → add test phase
  const isUI = lowerLabels.some((label) =>
    UI_LABELS.some((uiLabel) => label.includes(uiLabel)),
  );

  // Check for complex labels → enable quality loop
  const isComplex = lowerLabels.some((label) =>
    COMPLEX_LABELS.some((complexLabel) => label.includes(complexLabel)),
  );

  // Check for security labels → add security-review phase
  const isSecurity = lowerLabels.some((label) =>
    SECURITY_LABELS.some((secLabel) => label.includes(secLabel)),
  );

  // Build phase list
  let phases: Phase[];

  if (isBugFix || isDocs) {
    // Simple workflow: exec → qa
    phases = ["exec", "qa"];
  } else if (isUI) {
    // UI workflow: spec → exec → test → qa
    phases = ["spec", "exec", "test", "qa"];
  } else {
    // Standard workflow: spec → exec → qa
    phases = ["spec", "exec", "qa"];
  }

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

  // Validate and convert to Phase type
  const validPhases: Phase[] = [];
  for (const name of phaseNames) {
    if (
      [
        "spec",
        "security-review",
        "testgen",
        "exec",
        "test",
        "qa",
        "loop",
      ].includes(name)
    ) {
      validPhases.push(name as Phase);
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
 * Check if an issue has UI-related labels
 */
export function hasUILabels(labels: string[]): boolean {
  return labels.some((label) =>
    UI_LABELS.some((uiLabel) => label.toLowerCase().includes(uiLabel)),
  );
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
