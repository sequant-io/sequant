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
 * live/active phase and success — while issue-distinction (border rotation)
 * and failure (red) stay on robust named ANSI colors. The muted gray for
 * secondary chrome is a fixed mid-gray (`DIVIDER_COLOR`) chosen for WCAG
 * contrast rather than the too-dim ANSI bright-black.
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

/**
 * Muted gray for secondary chrome: dividers, field labels (`branch`/`now`/
 * `log`), the `phase N/total` + elapsed line, the `last activity` stamp, and
 * the terminal status line.
 *
 * Lifted off ANSI `"gray"` (bright-black), which the brand's own dark theme
 * renders at ~2.4:1 — below WCAG AA (4.5) and even the 3.0 large-text/UI floor.
 * This fixed mid-gray clears AA (~4.9:1) on the dark theme while staying above
 * 3.0 on light terminals (~3.4:1). It still degrades gracefully: chalk
 * downsamples the hex to the nearest ANSI color on non-truecolor terminals, and
 * `NO_COLOR` strips it entirely. The not-yet-started phase glyph stays on ANSI
 * `"gray"` (see `phaseStatusColor`) so pending work remains the most recessed.
 */
export const DIVIDER_COLOR = "#8B8B9A" as const;

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
