/**
 * The one Non-Goals scanner (#1474).
 *
 * Both the ready gate (`workflow/ready-gate.ts`, report-only gap
 * classification) and the scope analyzer (`scope/analyzer.ts`, SCOPE_WARNING)
 * read "the issue's Non-Goals" through this module, so a fix to the rules
 * reaches both entry points. The heading rules are the gate's (D-7):
 *
 * - any ATX heading (`#` to `######`) whose text starts with `non-goals`,
 *   `non-goal`, `nongoals` or `out of scope` opens a section — trailing text
 *   after the keyword is allowed (`## Out of scope (deferred)`);
 * - any other heading closes it;
 * - several sections are unioned in document order;
 * - every `-`/`*` bullet in a section is an item, indented ones included,
 *   and an item may start with `#` (`#1297 (exec summary …)`).
 *
 * Fenced code blocks are blanked first (#947), so a Non-Goals example quoted
 * inside a fence is neither a heading nor an item.
 */

import { stripFencedLines } from "./markdown-fence.js";

const HEADING_RE = /^#{1,6}\s+(.*)$/;
const NON_GOAL_HEADING_RE = /^(non-?goals?|out[ -]of[ -]scope)\b/i;
const BULLET_RE = /^\s*[-*]\s+(.+)$/;
const CHECKBOX_RE = /^\[[ xX]\]\s*/;

/** Result of scanning an issue body for Non-Goals sections. */
export interface NonGoalsScan {
  /** Bullet items from every Non-Goals section, checkbox and `` ` ``/`*` stripped. */
  items: string[];
  /** True once any Non-Goals heading is seen, even with zero items. */
  found: boolean;
}

/**
 * Scan an issue body for its Non-Goals sections.
 *
 * @param issueBody - Full issue body markdown
 */
export function scanNonGoals(issueBody: string): NonGoalsScan {
  if (!issueBody) return { items: [], found: false };
  const lines = stripFencedLines(issueBody).split("\n");
  const items: string[] = [];
  let found = false;
  let inSection = false;
  for (const line of lines) {
    const heading = line.match(HEADING_RE);
    if (heading) {
      inSection = NON_GOAL_HEADING_RE.test(heading[1].trim());
      if (inSection) found = true;
      continue;
    }
    if (!inSection) continue;
    const bullet = line.match(BULLET_RE);
    if (bullet) {
      // Strip a task-list checkbox, then markdown emphasis/backticks for
      // cleaner token matching.
      const text = bullet[1]
        .replace(CHECKBOX_RE, "")
        .replace(/[`*]/g, "")
        .trim();
      if (text) items.push(text);
    }
  }
  return { items, found };
}

/**
 * Parse the issue body's Non-Goals sections into a list of bullet items.
 * Returns `[]` when no section is present.
 */
export function parseNonGoals(issueBody: string): string[] {
  return scanNonGoals(issueBody).items;
}
