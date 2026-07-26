/**
 * Run flag normalization (#705) — keeps run.ts thin (#503 AC-2: <200 LOC).
 *
 * Pure resolvers for the `run` command's flag surface:
 *   - `normalizeQualityLoop`: ORs the hidden `-q` alias into `--quality-loop`.
 *   - `resolveTuiEnabled`: decides whether the boxed Ink TUI mounts.
 *   - `deprecatedFlagNotices`: messages for flags kept only for compatibility.
 *
 * Extracted as pure functions so the flag behavior is unit-testable without
 * driving the full `runCommand` side effects.
 */

import chalk from "chalk";
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

/**
 * #795: notices for flags that still parse but no longer do anything.
 *
 * `--qa-gate` promised to "wait for QA pass before starting the next issue in
 * chain", but the chain loop halts on any failed link unconditionally, so the
 * flag never changed behavior and no runtime path ever wrote the
 * `waiting_for_qa_gate` status it advertised. It is kept parseable so existing
 * scripts do not hard-error — the previous `--qa-gate requires --chain` check
 * aborted the whole run, which is exactly the breakage a deprecation window
 * exists to avoid — and it no longer requires `--chain`.
 *
 * Returned rather than printed so the wording is unit-testable without driving
 * `runCommand`'s side effects.
 */
export function deprecatedFlagNotices(options: RunOptions): string[] {
  const notices: string[] = [];
  if (options.qaGate) {
    notices.push(
      "--qa-gate is deprecated and has no effect (#795). --chain already halts the chain on any failed issue, QA included. Remove the flag; it will be deleted in a future major release.",
    );
  }
  return notices;
}

/**
 * Prints every notice from {@link deprecatedFlagNotices}.
 *
 * Lives here rather than inline in `run.ts` to keep that adapter under the
 * #503 AC-2 200-LOC budget, alongside the pure resolver it wraps.
 *
 * Two deliberate choices, both flagged because a future reader may mistake
 * them for oversights:
 *
 * 1. **stderr, not stdout.** Deprecation notices are warnings, and warnings
 *    go on stderr (same as `abort.ts`). This keeps a script's piped stdout
 *    clean while still surfacing the notice on a terminal.
 * 2. **Not gated on `options.quiet`.** `--quiet` suppresses progress and
 *    version chatter; it is not a warning switch. The scripts most likely to
 *    still pass `--qa-gate` are CI scripts, which are also the most likely to
 *    pass `--quiet` — suppressing there would defeat the deprecation window
 *    for exactly its target audience. Silencing warnings should be an
 *    explicit opt-out, not a side effect of asking for less progress output.
 *
 * `runCommand` calls this immediately after the header box, ahead of the
 * manifest and settings checks: a dead flag is a fact about argv, not about
 * project state, so it should be reported even from an uninitialized
 * directory where those checks would return early.
 */
export function warnDeprecatedFlags(options: RunOptions): void {
  for (const notice of deprecatedFlagNotices(options)) {
    console.error(chalk.yellow(`  !  ${notice}`));
  }
}
