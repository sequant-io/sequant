/**
 * Run flag normalization (#705) — keeps run.ts thin (#503 AC-2: <200 LOC).
 *
 * Two pure resolvers for the `run` command's flag surface:
 *   - `normalizeQualityLoop`: ORs the hidden `-q` alias into `--quality-loop`.
 *   - `resolveTuiEnabled`: decides whether the boxed Ink TUI mounts.
 *
 * Extracted as pure functions so the flag behavior is unit-testable without
 * driving the full `runCommand` side effects.
 */

import type { RunOptions } from "../lib/workflow/types.js";

/**
 * #705: `-q` is a hidden alias for the quality loop (it no longer maps to
 * `--quiet`, which moved to `-s`). Returns the effective quality-loop flag so
 * `-q` and `-Q` produce identical behavior. Must run before any consumer reads
 * `options.qualityLoop`.
 */
export function normalizeQualityLoop(options: RunOptions): boolean {
  return Boolean(options.qualityLoop || options.qualityLoopAlias);
}

/**
 * #705: the boxed Ink TUI is the default on a TTY.
 *
 * - `--no-tui` (Commander surfaces `options.tui === false`) opts out to the
 *   line-based phase-matrix renderer.
 * - Non-TTY / piped output auto-degrades (`isTTY === false`), so no Ink writes
 *   corrupt pipes.
 * - `--quiet`/`-s` suppresses the renderer entirely (heartbeat-only),
 *   regardless of the TUI default (AC-2).
 * - `--experimental-tui` is a hidden no-op alias — the default already covers
 *   it, so it is intentionally not consulted here.
 */
export function resolveTuiEnabled(
  options: RunOptions,
  isTTY: boolean,
): boolean {
  return options.tui !== false && isTTY && !options.quiet;
}
