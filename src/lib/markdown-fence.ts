/**
 * Fenced-code-block tracking for line-oriented markdown scanners.
 *
 * Multiple parsers in this codebase scan an issue/PR body line-by-line
 * looking for patterns (checkbox items, `## Non-Goals` bullets). Without
 * fence awareness, a markdown-authoring example quoted inside a fence
 * — showing what the pattern syntax looks like — gets scanned as if it
 * were real content. See #947 (ac-parser.ts) and its sibling in
 * scope/analyzer.ts's `parseNonGoals`.
 */

/** Matches a fenced-code-block delimiter line (` ``` ` or `~~~`, 3+ repeats). */
const FENCE_DELIMITER_RE = /^\s*(`{3,}|~{3,})/;

/**
 * Compute, for every line of a split markdown body, whether that line falls
 * inside a fenced code block (CommonMark rules: matching delimiter
 * character, closing fence length >= opening fence length; an unclosed
 * fence runs to EOF). The delimiter lines themselves are marked `true` —
 * they're fence syntax, not real content, so patterns should skip them too.
 */
export function computeFenceMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let fenceChar: string | null = null;
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(FENCE_DELIMITER_RE);

    if (fenceChar === null) {
      if (match) {
        fenceChar = match[1][0];
        fenceLen = match[1].length;
        mask[i] = true;
      }
      continue;
    }

    mask[i] = true;
    if (match && match[1][0] === fenceChar && match[1].length >= fenceLen) {
      fenceChar = null;
      fenceLen = 0;
    }
  }

  return mask;
}

/**
 * Blank out every line that falls inside a fenced code block, preserving
 * line count (and therefore `\n`-relative offsets) so callers that locate
 * sections via newline-anchored regexes on the full body are unaffected.
 */
export function stripFencedLines(body: string): string {
  const lines = body.split("\n");
  const mask = computeFenceMask(lines);
  return lines.map((line, i) => (mask[i] ? "" : line)).join("\n");
}
