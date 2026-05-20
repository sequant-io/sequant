/**
 * Renderer-aware notice routing (#647 AC-3).
 *
 * Lives in its own module so both `phase-executor` and `run-orchestrator`
 * can import without creating a backwards dependency (orchestrator → executor).
 *
 * @module
 */

import type { PhasePauseHandle } from "./types.js";

/**
 * Print a line to stdout while the renderer is active without breaking
 * log-update's cursor model.
 *
 * `log-update` tracks `previousLineCount` from its own writes only; any
 * out-of-band write to the same pty advances the cursor without its
 * knowledge, so the next `eraseLines(previousLineCount)` undershoots and
 * strands the prior frame's top rows in scrollback as duplicate headers.
 *
 * Routing:
 *   - With a `PhasePauseHandle` (TTY run): route through `appendNotice`,
 *     which clears the live zone, writes through the renderer's own
 *     stdout channel, then redraws. log-update's bookkeeping stays
 *     correct because the clear+redraw goes through the same path as
 *     a normal event line.
 *   - Without a handle (quiet mode / non-TTY / orchestrator): fall back
 *     to `console.log` — there's no live zone to corrupt.
 *
 * Callers in `phase-executor.ts` / `run-orchestrator.ts` must use this
 * helper instead of raw `console.log` — enforced by ESLint
 * `no-restricted-syntax` rule in `eslint.config.js`.
 */
export function bracketedConsoleLog(
  spinner: PhasePauseHandle | undefined,
  message: string,
): void {
  if (spinner) {
    spinner.appendNotice(message);
  } else {
    console.log(message);
  }
}
