/**
 * Theme tokens for the experimental multi-issue dashboard TUI.
 *
 * Palette rotates by start order (cyan → magenta → blue → yellow); issue
 * status (failed / passed) overrides the rotation color where applicable.
 * Respects `NO_COLOR` automatically via `ink`/`chalk`.
 */

import type { IssueStatus, PhaseStatus } from "../../lib/workflow/run-state.js";

/**
 * Sequant brand accents, sourced from sequant-landing `src/styles/tokens.css`:
 *   - `BRAND_ORANGE` is the primary brand color (`--color-primary` dark mode).
 *   - `BRAND_GREEN` is the accent/success green (`--color-accent`).
 *
 * Used to brand the two color signals that matter most at a glance — the
 * live/active phase and success — while issue-distinction (border rotation),
 * failure (red), and dividers (gray) stay on robust named ANSI colors.
 *
 * Ink/chalk auto-downsamples hex to the nearest ANSI color on terminals
 * without truecolor, and `NO_COLOR` still strips all color, so these degrade
 * gracefully without a manual capability check.
 */
export const BRAND_ORANGE = "#FF8012" as const;
export const BRAND_GREEN = "#10b981" as const;

/** Border-color palette rotated by issue start order. */
export const BORDER_ROTATION = ["cyan", "magenta", "blue", "yellow"] as const;

export type BorderColor =
  | (typeof BORDER_ROTATION)[number]
  | typeof BRAND_GREEN
  | typeof BRAND_ORANGE
  | "red"
  | "gray";

/** Gray used for horizontal dividers inside each box. */
export const DIVIDER_COLOR = "gray" as const;

/** Brand orange for the live/active phase spinner — the one element the eye
 *  tracks. Border rotation still distinguishes concurrent issues. */
export const ACTIVE_PHASE_COLOR = BRAND_ORANGE;

/** Brand green for the rolled-up `✔ N done` summary line (#699, parity with the
 *  plain renderer's #624 rollup). */
export const ROLLUP_COLOR = BRAND_GREEN;

/**
 * Pick the border color for an issue.
 * Failed / passed states win over rotation; otherwise rotate by slot.
 */
export function borderColorForIssue(
  status: IssueStatus,
  slot: number,
): BorderColor {
  if (status === "failed") return "red";
  if (status === "passed") return BRAND_GREEN;
  const idx =
    ((slot % BORDER_ROTATION.length) + BORDER_ROTATION.length) %
    BORDER_ROTATION.length;
  return BORDER_ROTATION[idx];
}

/** Glyphs for the phase progression row. */
export const PHASE_GLYPHS = {
  pending: "○",
  done: "✓",
  failed: "✗",
  separator: "▸",
} as const;

/** Braille spinner frames — 10 Hz rotation looks smooth at ~100ms tick. */
export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

/** Color for a phase glyph based on its status. Active phase uses border color. */
export function phaseStatusColor(status: PhaseStatus): BorderColor {
  if (status === "done") return BRAND_GREEN;
  if (status === "failed") return "red";
  return "gray";
}
