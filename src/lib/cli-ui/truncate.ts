/**
 * Display-width-aware truncation for terminal output.
 *
 * Uses `string-width` so wide glyphs (CJK, emoji) and ANSI escapes are
 * counted correctly. Cheaper than ink's own truncation in hot paths.
 */

import stringWidth from "string-width";

/**
 * Truncate `text` so its visible width does not exceed `max` columns.
 * If truncation happens, appends a single `…` (which itself counts as 1 col).
 */
export function truncateToWidth(text: string, max: number): string {
  if (max <= 0) return "";
  const width = stringWidth(text);
  if (width <= max) return text;
  if (max === 1) return "…";

  let acc = "";
  let accWidth = 0;
  const budget = max - 1; // reserve one column for the ellipsis
  for (const ch of text) {
    const w = stringWidth(ch);
    if (accWidth + w > budget) break;
    acc += ch;
    accWidth += w;
  }
  return `${acc}…`;
}

/**
 * Below this fraction of the available width, a word-boundary truncation wastes
 * too many columns to be worth it and we cut mid-word instead. Keeps
 * `CI billing-lockout misclassified…` from collapsing to `CI billing-lockout…`.
 */
const WORD_BOUNDARY_MIN_FILL = 0.7;

const ELLIPSIS = "…";

/**
 * Truncate `text` to `width` display columns, appending `…`.
 *
 * Prefers a word boundary, but only when the boundary retains at least
 * {@link WORD_BOUNDARY_MIN_FILL} of the available width — otherwise a single
 * long final word would leave a ragged gap before the `Run` column.
 * Width-aware throughout, so wide glyphs cannot push the result past `width`.
 */
export function truncateAtWord(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  if (width <= 1) return ELLIPSIS.slice(0, Math.max(0, width));

  const budget = width - stringWidth(ELLIPSIS);
  const chars = Array.from(text);
  let hard = "";
  let used = 0;
  let consumed = 0;
  for (const ch of chars) {
    const chWidth = stringWidth(ch);
    if (used + chWidth > budget) break;
    hard += ch;
    used += chWidth;
    consumed += 1;
  }

  // The hard cut already landed on a word boundary — the next character is the
  // space that would have separated the following word. Backing off to the
  // *previous* space here would drop a word that fit perfectly.
  if (/\s/.test(chars[consumed] ?? "")) {
    return hard.trimEnd() + ELLIPSIS;
  }

  const lastSpace = hard.lastIndexOf(" ");
  if (lastSpace > 0) {
    const wordCut = hard.slice(0, lastSpace).trimEnd();
    if (stringWidth(wordCut) >= Math.floor(budget * WORD_BOUNDARY_MIN_FILL)) {
      return wordCut + ELLIPSIS;
    }
  }
  return hard.trimEnd() + ELLIPSIS;
}
