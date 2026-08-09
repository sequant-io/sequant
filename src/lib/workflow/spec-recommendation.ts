/**
 * Structured resolution of the spec→run phase recommendation (#921).
 *
 * `parseRecommendedWorkflow` (phase-mapper.ts) regexes the spec agent's
 * *ephemeral chat text* for a `## Recommended Workflow` section. When the
 * spec agent posts its plan via a body file instead of restating it in
 * chat, that regex has nothing to match and the run silently falls back to
 * label-based phase detection — dropping any recommended phase the label
 * fallback can never produce (e.g. `testgen`). See #814.
 *
 * This module resolves the recommendation through an ordered chain, each
 * step falling through loudly to the next on failure:
 *
 *   1. `marker`         — the durable `<!-- SEQUANT_SPEC: {json} --> `
 *                          comment marker (this issue's fix)
 *   2. `comment-prose`  — the same regex as `chat`, applied to the spec
 *                          plan's GitHub comment body instead of chat text
 *   3. `chat`           — `parseRecommendedWorkflow` over the agent's
 *                          captured chat output (existing behavior)
 *   4. `label-fallback` — `detectPhasesFromLabels` (existing behavior)
 *
 * The durable comment marker is the system's existing idiom — see
 * `SEQUANT_PHASE` in `phase-detection.ts` and the `/assess` HTML markers in
 * `assess-comment-parser.ts`.
 */

import chalk from "chalk";
import { z } from "zod";
import type { Phase } from "./types.js";
import { phaseRegistry } from "./phase-registry.js";
import { GitHubProvider } from "./platforms/github.js";
import { stripMarkdownCode } from "./phase-detection.js";
import {
  parseRecommendedWorkflow,
  detectPhasesFromLabels,
} from "./phase-mapper.js";
import type { SpecRecommendationSource } from "./run-log-schema.js";

/** Regex to extract the SEQUANT_SPEC marker JSON from an HTML comment. */
const SPEC_MARKER_REGEX = /<!-- SEQUANT_SPEC: (\{[^}]+\}) -->/g;

/**
 * Structural shape of the marker JSON, before phase names are checked
 * against the phase registry. `qualityLoop` defaults to `false` when
 * omitted, matching `parseRecommendedWorkflow`'s prose-parsing default.
 */
const SpecMarkerJsonSchema = z.object({
  phases: z.array(z.string()).min(1),
  qualityLoop: z.boolean().optional().default(false),
});

export interface ResolvedSpecRecommendation {
  phases: Phase[];
  qualityLoop: boolean;
  source: SpecRecommendationSource;
}

/**
 * Extract and validate the latest `SEQUANT_SPEC` marker across a set of
 * comment bodies (oldest-to-newest order, matching `gh`'s natural order).
 *
 * Returns `null` when no marker is present at all. Returns `null` and logs a
 * visible warning when the latest marker is malformed JSON, fails schema
 * validation, or names a phase the registry doesn't recognize — per AC-2,
 * an invalid marker falls through to the next resolution step rather than
 * silently dropping the recommendation or silently ignoring the bad phase.
 *
 * Only the *latest* marker is considered (last comment, last match within
 * it) — a re-spec's marker supersedes an earlier one, matching how a human
 * reader would interpret the thread.
 */
export function parseSpecMarker(
  commentBodies: string[],
): { phases: Phase[]; qualityLoop: boolean } | null {
  let latestRaw: string | null = null;

  for (const body of commentBodies) {
    const stripped = stripMarkdownCode(body);
    SPEC_MARKER_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SPEC_MARKER_REGEX.exec(stripped)) !== null) {
      latestRaw = match[1];
    }
  }

  if (latestRaw === null) {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(latestRaw);
  } catch {
    console.log(
      chalk.yellow(
        `    ⚠ SEQUANT_SPEC marker is not valid JSON — falling through to comment prose`,
      ),
    );
    return null;
  }

  const result = SpecMarkerJsonSchema.safeParse(parsedJson);
  if (!result.success) {
    console.log(
      chalk.yellow(
        `    ⚠ SEQUANT_SPEC marker failed schema validation — falling through to comment prose`,
      ),
    );
    return null;
  }

  const unknownPhases = result.data.phases.filter(
    (name) => !phaseRegistry.has(name),
  );
  if (unknownPhases.length > 0) {
    console.log(
      chalk.yellow(
        `    ⚠ SEQUANT_SPEC marker names unknown phase(s): ${unknownPhases.join(", ")} — falling through to comment prose`,
      ),
    );
    return null;
  }

  return { phases: result.data.phases, qualityLoop: result.data.qualityLoop };
}

/**
 * Find the most recently posted comment containing a `## Recommended
 * Workflow` section and parse it with the existing prose regex.
 *
 * Scans newest-to-oldest so a later spec re-run's comment takes precedence
 * over an earlier one — same intuition as the marker step.
 */
function parseCommentProse(
  commentBodies: string[],
): { phases: Phase[]; qualityLoop: boolean } | null {
  for (let i = commentBodies.length - 1; i >= 0; i--) {
    const parsed = parseRecommendedWorkflow(commentBodies[i]);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

export interface ResolveSpecRecommendationInput {
  /** The spec agent's captured chat output (existing `chat` fallback). */
  chatOutput: string;
  /** GitHub issue number, used to fetch its comments for the marker/prose steps. */
  issueNumber: number;
  /** Issue labels, used for the final label-based fallback. */
  labels: string[];
  /**
   * Injectable for tests — defaults to a real `GitHubProvider`. Comment
   * fetch failures are already handled by `fetchIssueCommentBodiesSync`
   * (returns `[]`), so the chain degrades to `chat`/`label-fallback`
   * gracefully when GitHub is unreachable.
   */
  githubProvider?: Pick<GitHubProvider, "fetchIssueCommentBodiesSync">;
}

/**
 * Resolve the spec→run phase recommendation through the ordered chain:
 * comment-marker → comment-prose → chat-text → label-fallback.
 */
export function resolveSpecRecommendation(
  input: ResolveSpecRecommendationInput,
): ResolvedSpecRecommendation {
  const github = input.githubProvider ?? new GitHubProvider();
  const commentBodies = github.fetchIssueCommentBodiesSync(
    String(input.issueNumber),
  );

  let phases: Phase[];
  let qualityLoop: boolean;
  let source: SpecRecommendationSource;

  const marker = parseSpecMarker(commentBodies);
  const prose = marker ? null : parseCommentProse(commentBodies);
  const chat =
    marker || prose || !input.chatOutput
      ? null
      : parseRecommendedWorkflow(input.chatOutput);

  if (marker) {
    ({ phases, qualityLoop } = marker);
    source = "marker";
  } else if (prose) {
    ({ phases, qualityLoop } = prose);
    source = "comment-prose";
  } else if (chat) {
    ({ phases, qualityLoop } = chat);
    source = "chat";
  } else {
    const fallback = detectPhasesFromLabels(input.labels);
    phases = fallback.phases;
    qualityLoop = fallback.qualityLoop;
    source = "label-fallback";
  }

  // Spec already ran by the time this resolves — never re-include it,
  // regardless of which step in the chain produced the result.
  return { phases: phases.filter((p) => p !== "spec"), qualityLoop, source };
}
