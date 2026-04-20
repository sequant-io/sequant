/**
 * Theme tokens for the experimental multi-issue dashboard TUI.
 *
 * Palette rotates by start order (cyan → magenta → blue → yellow); issue
 * status (failed / passed) overrides the rotation color where applicable.
 * Respects `NO_COLOR` automatically via `ink`/`chalk`.
 */

import type { IssueStatus, PhaseStatus } from "../../lib/workflow/run-state.js";

/** Border-color palette rotated by issue start order. */
export const BORDER_ROTATION = ["cyan", "magenta", "blue", "yellow"] as const;

export type BorderColor =
  | (typeof BORDER_ROTATION)[number]
  | "green"
  | "red"
  | "gray";

/** Gray used for horizontal dividers inside each box. */
export const DIVIDER_COLOR = "gray" as const;

/**
 * Pick the border color for an issue.
 * Failed / passed states win over rotation; otherwise rotate by slot.
 */
export function borderColorForIssue(
  status: IssueStatus,
  slot: number,
): BorderColor {
  if (status === "failed") return "red";
  if (status === "passed") return "green";
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
  if (status === "done") return "green";
  if (status === "failed") return "red";
  return "gray";
}
