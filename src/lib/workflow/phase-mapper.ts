/**
 * Phase Mapping Module
 *
 * Maps issue labels to workflow phases and parses recommended workflows:
 * - Label-based phase detection
 * - Recommended workflow parsing from spec output
 * - UI/bug/docs/complex label recognition
 *
 * @module phase-mapper
 */

import { spawnSync } from "child_process";
import type { Phase } from "./types.js";
import { getResumablePhasesForIssue } from "./phase-detection.js";

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
 * Options that affect phase determination
 */
interface PhaseOptions {
  testgen?: boolean;
}

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
  options: PhaseOptions,
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

/**
 * Filter phases based on resume status.
 *
 * When `resume` is true, calls `getResumablePhasesForIssue` to determine
 * which phases have already completed (via GitHub issue comment markers)
 * and removes them from the execution list.
 *
 * @param issueNumber - GitHub issue number
 * @param phases - The phases to potentially filter
 * @param resume - Whether the --resume flag is set
 * @returns Object with filtered phases and any skipped phases
 */
export function filterResumedPhases(
  issueNumber: number,
  phases: Phase[],
  resume: boolean,
): { phases: Phase[]; skipped: Phase[] } {
  if (!resume) {
    return { phases: [...phases], skipped: [] };
  }

  const resumable = getResumablePhasesForIssue(issueNumber, phases) as Phase[];
  const skipped = phases.filter((p) => !resumable.includes(p));
  return { phases: resumable, skipped };
}

/**
 * Fetch issue info from GitHub
 */
export async function getIssueInfo(
  issueNumber: number,
): Promise<{ title: string; labels: string[] }> {
  try {
    const result = spawnSync(
      "gh",
      ["issue", "view", String(issueNumber), "--json", "title,labels"],
      { stdio: "pipe" },
    );

    if (result.status === 0) {
      const data = JSON.parse(result.stdout.toString());
      return {
        title: data.title || `Issue #${issueNumber}`,
        labels: Array.isArray(data.labels)
          ? data.labels.map((l: { name: string }) => l.name)
          : [],
      };
    }
  } catch {
    // Ignore errors, use defaults
  }

  return { title: `Issue #${issueNumber}`, labels: [] };
}

/**
 * Parse dependencies from issue body and labels
 * Returns array of issue numbers this issue depends on
 */
export function parseDependencies(issueNumber: number): number[] {
  try {
    const result = spawnSync(
      "gh",
      ["issue", "view", String(issueNumber), "--json", "body,labels"],
      { stdio: "pipe" },
    );

    if (result.status !== 0) return [];

    const data = JSON.parse(result.stdout.toString());
    const dependencies: number[] = [];

    // Parse from body: "Depends on: #123" or "**Depends on**: #123"
    if (data.body) {
      const bodyMatch = data.body.match(
        /\*?\*?depends\s+on\*?\*?:?\s*#?(\d+)/gi,
      );
      if (bodyMatch) {
        for (const match of bodyMatch) {
          const numMatch = match.match(/(\d+)/);
          if (numMatch) {
            dependencies.push(parseInt(numMatch[1], 10));
          }
        }
      }
    }

    // Parse from labels: "depends-on/123" or "depends-on-123"
    if (data.labels && Array.isArray(data.labels)) {
      for (const label of data.labels) {
        const labelName = label.name || label;
        const labelMatch = labelName.match(/depends-on[-/](\d+)/i);
        if (labelMatch) {
          dependencies.push(parseInt(labelMatch[1], 10));
        }
      }
    }

    return [...new Set(dependencies)]; // Remove duplicates
  } catch {
    return [];
  }
}

/**
 * Sort issues by dependencies (topological sort)
 * Issues with no dependencies come first, then issues that depend on them
 */
export function sortByDependencies(issueNumbers: number[]): number[] {
  // Build dependency graph
  const dependsOn = new Map<number, number[]>();
  for (const issue of issueNumbers) {
    const deps = parseDependencies(issue);
    // Only include dependencies that are in our issue list
    dependsOn.set(
      issue,
      deps.filter((d) => issueNumbers.includes(d)),
    );
  }

  // Topological sort using Kahn's algorithm
  const inDegree = new Map<number, number>();
  for (const issue of issueNumbers) {
    inDegree.set(issue, 0);
  }
  for (const deps of dependsOn.values()) {
    for (const dep of deps) {
      inDegree.set(dep, (inDegree.get(dep) || 0) + 1);
    }
  }

  // Note: inDegree counts how many issues depend on each issue
  // We want to process issues that nothing depends on last
  // So we sort by: issues nothing depends on first, then dependent issues
  const sorted: number[] = [];
  const queue: number[] = [];

  // Start with issues that have no dependencies
  for (const issue of issueNumbers) {
    const deps = dependsOn.get(issue) || [];
    if (deps.length === 0) {
      queue.push(issue);
    }
  }

  const visited = new Set<number>();
  while (queue.length > 0) {
    const issue = queue.shift()!;
    if (visited.has(issue)) continue;
    visited.add(issue);
    sorted.push(issue);

    // Find issues that depend on this one
    for (const [other, deps] of dependsOn.entries()) {
      if (deps.includes(issue) && !visited.has(other)) {
        // Check if all dependencies of 'other' are satisfied
        const allDepsSatisfied = deps.every((d) => visited.has(d));
        if (allDepsSatisfied) {
          queue.push(other);
        }
      }
    }
  }

  // Add any remaining issues (circular dependencies or unvisited)
  for (const issue of issueNumbers) {
    if (!visited.has(issue)) {
      sorted.push(issue);
    }
  }

  return sorted;
}
