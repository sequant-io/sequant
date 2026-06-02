/**
 * Row cap + frame-height clamp for the Ink TUI (#699 AC-4).
 *
 * Parity with the plain renderer's #624 behavior (`run-renderer.ts`
 * `applyRowCap` / `effectiveRowCap`): N issues must never render more boxes
 * than the terminal can hold. Keep every active (queued/running) issue, fill
 * the remaining slots with the most-recently-completed issues, and roll older
 * completed issues into a single `✔ N done` summary line.
 *
 * The TUI difference is vertical density: each plain-grid issue is ~3 lines,
 * but a full Ink box is ~9–11 lines (round border + 3 cells + 2 dividers +
 * bottom margin). `LINES_PER_BOX` is sized accordingly so the dynamic cap
 * reflects how many boxes actually fit.
 */

import type { IssueRuntimeState } from "../../lib/workflow/run-state.js";

/** Static row cap (matches the plain renderer's default). */
export const DEFAULT_TUI_ROW_CAP = 10;

/**
 * Approximate height of one rendered Ink box, in terminal rows: round border
 * top/bottom (2) + header (1) + two dividers (2) + context cell (~3) +
 * activity cell (~2) + bottom margin (1) ≈ 11.
 */
export const TUI_LINES_PER_BOX = 11;

/**
 * Fixed vertical overhead outside the issue boxes: the Header block plus the
 * rolled-up `✔ N done` summary line.
 */
const FIXED_OVERHEAD = 4;

/** A queued or running issue is "active"; passed/failed are terminal. */
function isActive(issue: IssueRuntimeState): boolean {
  return issue.status === "queued" || issue.status === "running";
}

/**
 * Effective cap: the smaller of the static cap and a dynamic terminal-height
 * ceiling. Mirrors `run-renderer.ts` `effectiveRowCap`, but with a box-height
 * `linesPerBox` rather than the plain grid's 3.
 *
 * When `rows` is unknown (no TTY size), trust the static cap directly rather
 * than guessing a height — the same "don't over-clamp" intent as the plain
 * renderer's tall default, without picking an arbitrary fallback row count.
 *
 * @internal Exported for testing.
 */
export function effectiveTuiRowCap(
  rows: number | undefined,
  staticCap: number = DEFAULT_TUI_ROW_CAP,
  linesPerBox: number = TUI_LINES_PER_BOX,
): number {
  if (!rows || rows <= 0) return staticCap;
  const dynamicCap = Math.max(
    1,
    Math.floor((rows - FIXED_OVERHEAD) / Math.max(1, linesPerBox)),
  );
  return Math.min(staticCap, dynamicCap);
}

export interface VisibleSelection {
  /** Boxes to render, in order: active issues first, then recent done. */
  visible: IssueRuntimeState[];
  /** Older completed issues collapsed into the `✔ N done` summary (0 if none). */
  rolledUpDoneCount: number;
}

/**
 * Select which issue boxes to render so the frame never exceeds the terminal
 * height. Parity with `run-renderer.ts` `applyRowCap`.
 *
 * - Under the cap → render everything, no rollup.
 * - Over the cap → keep all active issues; fill remaining slots (minus one
 *   reserved for the rollup line) with the most-recently-completed issues;
 *   the rest roll up into `rolledUpDoneCount`.
 */
export function selectVisibleIssues(
  issues: IssueRuntimeState[],
  rows: number | undefined,
  staticCap: number = DEFAULT_TUI_ROW_CAP,
  linesPerBox: number = TUI_LINES_PER_BOX,
): VisibleSelection {
  const cap = effectiveTuiRowCap(rows, staticCap, linesPerBox);
  if (issues.length <= cap) {
    return { visible: issues, rolledUpDoneCount: 0 };
  }

  const active = issues.filter(isActive);
  const done = issues
    .filter((i) => !isActive(i))
    .sort(
      (a, b) =>
        (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0),
    );

  // Reserve one slot for the rollup line; the rest go to visible boxes.
  const visibleSlots = Math.max(1, cap - 1);
  const remainingForDone = Math.max(0, visibleSlots - active.length);
  const visibleDone = done.slice(0, remainingForDone);
  const rolledUpDoneCount = done.length - visibleDone.length;

  return {
    visible: [...active, ...visibleDone],
    rolledUpDoneCount,
  };
}
