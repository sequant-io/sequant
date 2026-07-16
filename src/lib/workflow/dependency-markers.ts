/**
 * Shared parser for line-leading dependency markers in an issue body (#767).
 *
 * Two callers extract issue numbers from `depends on #N` / `blocked by #N`
 * declarations:
 *
 *   - `chain-preflight.ts:parseDeclaredBlockers` — warn-only pre-flight, honors
 *     BOTH `depends on` and `blocked by`.
 *   - `batch-executor.ts:parseDependencies` — feeds `sortByDependencies`, which
 *     *silently reorders the run*, so it honors ONLY `depends on`.
 *
 * The hardened mechanics (line anchoring, required `#`, code/comment stripping)
 * were introduced for the pre-flight in #762/PR #764 and lived only in
 * `chain-preflight.ts`. #767 promotes them here so the sorter can adopt the same
 * hardening without the two regexes drifting — while keeping the **marker set
 * per-caller** so sharing the parser does NOT make the sorter start reordering
 * on `blocked by` (a new, unrequested silent-reorder class; #762 Open Q #3).
 */

/** A dependency-declaration marker a caller opts into honoring. */
export type DepMarker = "depends on" | "blocked by";

/**
 * Build the anchored marker regex for the requested marker set.
 *
 * Matches a declared marker, optionally bold-wrapped, colon-separated, and/or
 * written as a list item, e.g. `- **Depends on**: #123`.
 *
 * Anchored to line start because a *declaration* is a line about the issue's
 * own dependencies, whereas prose that merely mentions the marker mid-sentence
 * is not. #762's own body is the motivating case: it contains both `...when #39
 * says blocked by #38` and `...real markers like "Blocked by #36"` as examples,
 * and an unanchored match reported #762 as blocked by #38 and #36 — exactly the
 * false inference #604 says is worse than none. That matters most under
 * `--strict-preflight`, where a bogus warning hard-aborts a legitimate chain.
 *
 * The `#` is required (unlike the historic looser `#?` in `parseDependencies`)
 * so a line such as `Blocked by 5 days of review` — or the prose
 * `Issue 14 depends on 12+13` — cannot parse as an issue number.
 */
function buildMarkerRegex(markers: DepMarker[]): RegExp {
  const alternation = markers.map((m) => m.split(/\s+/).join("\\s+")).join("|");
  return new RegExp(
    `^\\s*(?:[-*]\\s*)?\\*?\\*?(?:${alternation})\\*?\\*?:?\\s*#(\\d+)`,
    "gim",
  );
}

/**
 * Strip fenced code blocks, inline code spans, and HTML comments so markers
 * inside quoted shell snippets, documentation examples, or commented-out drafts
 * don't count as real declarations. Inline spans are matched within a single
 * line so an unbalanced backtick cannot swallow the rest of the body.
 *
 * Deliberately diverges from `assess-collision-detect.ts:stripCodeBlocksAndComments`,
 * which keeps inline spans: its PATH_REGEX only matches backtick-wrapped paths,
 * so stripping them there would find nothing. Same syntax, opposite meaning —
 * a backticked marker here is an example, a backticked path there is the target.
 * Keep the two separate (see PR #770).
 */
function stripCodeAndComments(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/`[^`\n]*`/g, "");
}

/**
 * Parse the issue numbers a body declares itself dependent on / blocked by,
 * honoring only the requested `markers`. Deduped, order-preserving.
 *
 * Only line-leading markers count as declarations — see `buildMarkerRegex` for
 * why mid-sentence prose mentions are deliberately ignored. Code blocks, inline
 * code spans, and HTML comments are stripped first.
 */
export function parseBodyDependencyMarkers(
  body: string,
  markers: DepMarker[],
): number[] {
  if (markers.length === 0) return [];
  const cleaned = stripCodeAndComments(body);
  const regex = buildMarkerRegex(markers);
  const found: number[] = [];
  for (const m of cleaned.matchAll(regex)) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && !found.includes(n)) found.push(n);
  }
  return found;
}
