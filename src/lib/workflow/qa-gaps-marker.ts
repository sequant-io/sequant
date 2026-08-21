/**
 * Parseable structured gap-finding markers for `/qa` (#937).
 *
 * `parseQaSummary`'s prose scrape (`parseListSection` against a
 * `**Issues:**`/`**Gaps**` header) is lossy — it misses AC-table NOT_MET
 * rows, §6d Adversarial Re-Read findings, and §5 Risk Assessment. QA output
 * templates now end with a structured marker:
 *
 * ```
 * <!-- SEQUANT_QA_GAPS: {"findings":[{"category":"test_gap","evidence":"...",
 * "description":"...","recommendedAction":"fix_now"}]} -->
 * ```
 *
 * Same durable-marker idiom as `SEQUANT_SPEC` (spec-recommendation.ts),
 * `SEQUANT_PHASE` (phase-detection.ts), and `SEQUANT_MUTATION`
 * (mutation-marker.ts) — but unlike those three, this marker's payload is
 * an array of objects, not a flat record, so it cannot reuse their
 * `{[^}]+}` regex (that stops at the FIRST `}`, truncating mid-JSON on any
 * nested object). Instead this matches lazily up to the closing `-->`,
 * which the emitting template guarantees appears on the same line as the
 * marker (single-line JSON, no `-->` inside string values).
 */

import { z } from "zod";
import { GapFindingSchema, type GapFinding } from "./run-log-schema.js";
import { stripMarkdownCode } from "./phase-detection.js";

/** Regex to extract the SEQUANT_QA_GAPS marker JSON from an HTML comment. */
const QA_GAPS_MARKER_REGEX = /<!-- SEQUANT_QA_GAPS: (\{[\s\S]*?\}) -->/g;

const QaGapsMarkerPayloadSchema = z.object({
  findings: z.array(GapFindingSchema),
});

/**
 * Parse every `SEQUANT_QA_GAPS` marker from a QA comment/output and return
 * the findings from the last valid one (latest-wins, matching
 * `resolveSpecRecommendation`'s idiom for `SEQUANT_SPEC`).
 *
 * Markers inside fenced code blocks or inline code (e.g. a doc example
 * showing the marker format) are ignored. Malformed JSON or a
 * schema-invalid payload is skipped rather than thrown — an unparseable
 * marker degrades to "no marker found", not a crash.
 *
 * @param output - QA comment body or agent output text
 * @returns The findings array from the last valid marker, or `null` if no
 *   valid marker was found
 */
export function parseQaGapsMarker(output: string): GapFinding[] | null {
  if (!output) return null;

  const stripped = stripMarkdownCode(output);
  QA_GAPS_MARKER_REGEX.lastIndex = 0;

  let latest: GapFinding[] | null = null;
  let match: RegExpExecArray | null;
  while ((match = QA_GAPS_MARKER_REGEX.exec(stripped)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    const result = QaGapsMarkerPayloadSchema.safeParse(parsed);
    if (result.success) {
      latest = result.data.findings;
    }
  }

  return latest;
}
