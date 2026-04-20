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
