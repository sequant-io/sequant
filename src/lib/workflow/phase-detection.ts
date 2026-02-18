/**
 * GitHub-based workflow phase detection for smart resumption.
 *
 * Reads phase markers from GitHub issue comments to detect workflow state
 * across machines, sessions, and users. Enables skills and `sequant run`
 * to resume from where they left off.
 *
 * Phase markers are embedded as HTML comments in issue comment bodies:
 * ```
 * <!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"..."} -->
 * ```
 */

import { execSync } from "child_process";
import {
  type Phase,
  type PhaseMarker,
  PhaseMarkerSchema,
  WORKFLOW_PHASES,
} from "./state-schema.js";

/** Regex to extract phase marker JSON from HTML comments */
const PHASE_MARKER_REGEX = /<!-- SEQUANT_PHASE: (\{[^}]+\}) -->/g;

/**
 * Regex patterns for markdown code constructs that should be ignored.
 * - Fenced code blocks: 3+ backticks or tildes (CommonMark spec)
 * - Inline code: `...`
 */
const FENCED_CODE_BLOCK_REGEX = /`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}/g;
const INLINE_CODE_REGEX = /`[^`\n]+`/g;

/**
 * Strip markdown code blocks and inline code from text.
 * This prevents phase markers inside code examples from being parsed.
 *
 * @param text - The text to strip code from
 * @returns Text with code blocks and inline code removed
 */
function stripMarkdownCode(text: string): string {
  // First remove fenced code blocks (multi-line)
  let result = text.replace(FENCED_CODE_BLOCK_REGEX, "");
  // Then remove inline code
  result = result.replace(INLINE_CODE_REGEX, "");
  return result;
}

/**
 * Format a phase marker as an HTML comment string for embedding in GitHub comments.
 *
 * @param marker - The phase marker data
 * @returns HTML comment string like `<!-- SEQUANT_PHASE: {...} -->`
 */
export function formatPhaseMarker(marker: PhaseMarker): string {
  return `<!-- SEQUANT_PHASE: ${JSON.stringify(marker)} -->`;
}

/**
 * Parse all phase markers from a single comment body.
 *
 * Phase markers inside fenced code blocks (```...```) or inline code (`...`)
 * are ignored to prevent false positives from documentation examples.
 *
 * @param commentBody - The full body text of a GitHub comment
 * @returns Array of parsed phase markers (empty if none found)
 */
export function parsePhaseMarkers(commentBody: string): PhaseMarker[] {
  const markers: PhaseMarker[] = [];
  // Strip code blocks before matching to avoid false positives
  const strippedBody = stripMarkdownCode(commentBody);
  // Reset regex state for reuse
  PHASE_MARKER_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = PHASE_MARKER_REGEX.exec(strippedBody)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      const result = PhaseMarkerSchema.safeParse(parsed);
      if (result.success) {
        markers.push(result.data);
      }
    } catch {
      // Malformed JSON — skip silently
    }
  }

  return markers;
}

/**
 * Detect the latest phase from an array of comment bodies.
 *
 * Scans all comments for phase markers and returns the most recent one
 * based on the timestamp field.
 *
 * @param comments - Array of objects with a `body` string field
 * @returns The latest phase marker, or null if no markers found
 */
export function detectPhaseFromComments(
  comments: { body: string }[],
): PhaseMarker | null {
  const allMarkers: PhaseMarker[] = [];

  for (const comment of comments) {
    const markers = parsePhaseMarkers(comment.body);
    allMarkers.push(...markers);
  }

  if (allMarkers.length === 0) {
    return null;
  }

  // Sort by timestamp descending, return latest
  allMarkers.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return allMarkers[0];
}

/**
 * Get all phase markers from issue comments, grouped by phase.
 *
 * Returns the latest marker for each phase that has been recorded.
 *
 * @param comments - Array of comment bodies
 * @returns Map of phase → latest marker for that phase
 */
export function getPhaseMap(
  comments: { body: string }[],
): Map<Phase, PhaseMarker> {
  const phaseMap = new Map<Phase, PhaseMarker>();

  for (const comment of comments) {
    const markers = parsePhaseMarkers(comment.body);
    for (const marker of markers) {
      const existing = phaseMap.get(marker.phase);
      if (
        !existing ||
        new Date(marker.timestamp).getTime() >
          new Date(existing.timestamp).getTime()
      ) {
        phaseMap.set(marker.phase, marker);
      }
    }
  }

  return phaseMap;
}

/**
 * Get list of phases that have been completed for an issue.
 *
 * @param comments - Array of comment bodies
 * @returns Array of phase names that have status "completed"
 */
export function getCompletedPhasesFromComments(
  comments: { body: string }[],
): Phase[] {
  const phaseMap = getPhaseMap(comments);
  const completed: Phase[] = [];

  for (const phase of WORKFLOW_PHASES) {
    const marker = phaseMap.get(phase);
    if (marker && marker.status === "completed") {
      completed.push(phase);
    }
  }

  return completed;
}

/**
 * Determine which phases to run based on completed phases and requested phases.
 *
 * Filters out phases that are already completed. If a phase failed,
 * it is kept in the list (for retry).
 *
 * @param requestedPhases - The phases the user wants to run
 * @param comments - Array of comment bodies from the issue
 * @returns Filtered array of phases that still need to run
 */
export function getResumablePhases(
  requestedPhases: readonly string[],
  comments: { body: string }[],
): string[] {
  const completedPhases = new Set(getCompletedPhasesFromComments(comments));

  return requestedPhases.filter(
    (phase) => !completedPhases.has(phase as Phase),
  );
}

/**
 * Check if a specific phase has been reached or passed.
 *
 * Uses WORKFLOW_PHASES ordering to determine if the target phase
 * is at or before the latest completed phase.
 *
 * @param targetPhase - The phase to check
 * @param comments - Array of comment bodies
 * @returns true if targetPhase has been completed or a later phase has been completed
 */
export function isPhaseCompletedOrPast(
  targetPhase: Phase,
  comments: { body: string }[],
): boolean {
  const phaseMap = getPhaseMap(comments);
  const targetIndex = WORKFLOW_PHASES.indexOf(targetPhase);

  // Check if target phase itself is completed
  const targetMarker = phaseMap.get(targetPhase);
  if (targetMarker && targetMarker.status === "completed") {
    return true;
  }

  // Check if any later phase is completed (implies target was completed)
  for (let i = targetIndex + 1; i < WORKFLOW_PHASES.length; i++) {
    const laterPhase = WORKFLOW_PHASES[i];
    const laterMarker = phaseMap.get(laterPhase);
    if (laterMarker && laterMarker.status === "completed") {
      return true;
    }
  }

  return false;
}

/**
 * Get the current phase status for an issue from GitHub comments.
 *
 * Calls `gh` CLI to fetch comments and parse phase markers.
 *
 * @param issueNumber - GitHub issue number
 * @returns Latest phase marker, or null if no markers found or on error
 */
export function getIssuePhase(issueNumber: number): PhaseMarker | null {
  try {
    const output = execSync(
      `gh issue view ${issueNumber} --json comments --jq '[.comments[].body]'`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );

    const bodies: string[] = JSON.parse(output);
    const comments = bodies.map((body) => ({ body }));
    return detectPhaseFromComments(comments);
  } catch {
    // GitHub CLI failure — fall through to normal execution
    return null;
  }
}

/**
 * Get completed phases for an issue from GitHub comments.
 *
 * Calls `gh` CLI to fetch comments and extract completed phases.
 *
 * @param issueNumber - GitHub issue number
 * @returns Array of completed phase names, or empty array on error
 */
export function getCompletedPhases(issueNumber: number): Phase[] {
  try {
    const output = execSync(
      `gh issue view ${issueNumber} --json comments --jq '[.comments[].body]'`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );

    const bodies: string[] = JSON.parse(output);
    const comments = bodies.map((body) => ({ body }));
    return getCompletedPhasesFromComments(comments);
  } catch {
    return [];
  }
}

/**
 * Get resumable phases for an issue from GitHub comments.
 *
 * Convenience wrapper that fetches comments via `gh` CLI and
 * filters requested phases by completed status.
 *
 * @param issueNumber - GitHub issue number
 * @param requestedPhases - The phases the user wants to run
 * @returns Filtered phases that still need to run
 */
export function getResumablePhasesForIssue(
  issueNumber: number,
  requestedPhases: readonly string[],
): string[] {
  try {
    const output = execSync(
      `gh issue view ${issueNumber} --json comments --jq '[.comments[].body]'`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );

    const bodies: string[] = JSON.parse(output);
    const comments = bodies.map((body) => ({ body }));
    return getResumablePhases(requestedPhases, comments);
  } catch {
    // On error, return all phases (no filtering)
    return [...requestedPhases];
  }
}
