/**
 * Parseable mutation-verification markers for `/qa` §6i (#939).
 *
 * CLAUDE.md's testing rule ("Gate tests ship with a recorded mutation
 * result") was honor-system prose — nothing parsed or checked the recorded
 * result, so compliance was invisible (see #830, #834's "prose only, and
 * therefore unenforceable" defect class). This module promotes that record
 * to a parseable PR-body marker:
 *
 * ```
 * <!-- SEQUANT_MUTATION: {"ac":"AC-3","mutation":"removed payload fixture
 * block","failedTest":"injection.test.ts > rejects payload"} -->
 * ```
 *
 * Same durable-marker idiom as `SEQUANT_SPEC` (spec-recommendation.ts) and
 * `SEQUANT_PHASE` (phase-detection.ts): a flat-JSON HTML comment, matched
 * with the `{[^}]+}` regex family. That regex stops at the FIRST `}`, so the
 * payload must stay flat — a nested object would truncate mid-JSON and fail
 * to parse. Unlike those two markers (one recommendation / one status per
 * comment, latest-wins), a PR body carries one `SEQUANT_MUTATION` marker per
 * AC, so all markers are collected, not just the latest.
 */

import { z } from "zod";
import { stripMarkdownCode } from "./phase-detection.js";

/** Regex to extract mutation-verification marker JSON from HTML comments. */
const MUTATION_MARKER_REGEX = /<!-- SEQUANT_MUTATION: (\{[^}]+\}) -->/g;

const MutationMarkerSchema = z.object({
  ac: z.string().min(1),
  mutation: z.string().min(1),
  failedTest: z.string().min(1),
});

export type MutationMarker = z.infer<typeof MutationMarkerSchema>;

/**
 * Parse every `SEQUANT_MUTATION` marker from a PR body.
 *
 * Markers inside fenced code blocks or inline code (e.g. a doc example
 * showing the marker format) are ignored, matching `parsePhaseMarkers`.
 * Malformed JSON or schema-invalid entries are skipped silently rather than
 * thrown — one bad marker must not take down the rest of the PR body's
 * markers.
 *
 * @param prBody - The full PR body text
 * @returns Every valid marker found, in document order
 */
export function parseMutationMarkers(prBody: string): MutationMarker[] {
  const markers: MutationMarker[] = [];
  const stripped = stripMarkdownCode(prBody);
  MUTATION_MARKER_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MUTATION_MARKER_REGEX.exec(stripped)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    const result = MutationMarkerSchema.safeParse(parsed);
    if (result.success) {
      markers.push(result.data);
    }
  }

  return markers;
}

/**
 * Reduce a marker list to one-per-AC, the later marker winning.
 *
 * A re-run's marker (e.g. after amending the PR body) supersedes the
 * earlier one for the same AC — the same "latest wins" idiom
 * `resolveSpecRecommendation` uses for `SEQUANT_SPEC`.
 *
 * @param markers - Markers as returned by {@link parseMutationMarkers}
 * @returns Map keyed by AC id, one marker per key
 */
export function latestMutationMarkerPerAc(
  markers: MutationMarker[],
): Map<string, MutationMarker> {
  const byAc = new Map<string, MutationMarker>();
  for (const marker of markers) {
    byAc.set(marker.ac, marker);
  }
  return byAc;
}

export type MutationMarkerClassification = "valid" | "test_not_in_diff";

/**
 * Classify a marker's `failedTest` against the diff's actual test files.
 *
 * A fabricated marker (naming a test that doesn't exist in the diff) is
 * worse than a missing one — it claims verification that never happened.
 * `failedTest` follows the `<file> > <test name>` shape `/qa` §6i renders
 * in its output table (e.g. `injection.test.ts > rejects payload`); only
 * the file segment is checked, since the suite/test-name portion after
 * ` > ` isn't independently verifiable without executing the test.
 *
 * @param marker - A single parsed marker
 * @param diffTestFiles - Test file paths present in the PR's diff
 * @returns `"valid"` when the named file is in the diff, `"test_not_in_diff"` otherwise
 */
export function classifyMutationMarker(
  marker: MutationMarker,
  diffTestFiles: string[],
): MutationMarkerClassification {
  const namedFile = marker.failedTest.split(">")[0]?.trim() ?? "";
  const found = diffTestFiles.some(
    (file) => file === namedFile || file.endsWith(`/${namedFile}`),
  );
  return found ? "valid" : "test_not_in_diff";
}
