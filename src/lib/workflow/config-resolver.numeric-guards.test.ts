/**
 * #833 AC-5 — a malformed numeric option must not survive `config-resolver`'s
 * `?? default` and reach a timer or a loop bound.
 *
 * This is the layer the original bug actually lived at. `bin/cli.ts` now
 * rejects `--timeout abc` at the flag boundary, but that only closes today's
 * door: `resolveRunOptions` spreads `...defined` last, so any `NaN` a caller
 * hands in wins over the settings fallback and lands in `ExecutionConfig`
 * unchanged. These tests assert the `?? default` gap stays closed for
 * programmatic callers too.
 *
 * Consequences being guarded, concretely:
 *   phaseTimeout  → `setTimeout(abort, NaN * 1000)` clamps to 0, so every phase
 *                   aborts on its first tick (phase-executor.ts).
 *   maxIterations → `while (iteration < NaN)` is false on entry, so the issue
 *                   runs zero phases and reports as if it had nothing to do
 *                   (batch-executor.ts).
 */

import { describe, it, expect } from "vitest";
import { buildExecutionConfig, resolveRunOptions } from "./config-resolver.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { RunOptions } from "./types.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import type { SequantSettings } from "../settings.js";

const settings: SequantSettings = DEFAULT_SETTINGS;

/** Resolve exactly as `run.ts` does: CLI options → merged → ExecutionConfig. */
function resolve(cli: Partial<RunOptions>) {
  return buildExecutionConfig(
    resolveRunOptions(cli as RunOptions, settings),
    settings,
    1,
  );
}

/** The values a bare `parseInt` can produce from user input, plus siblings. */
const MALFORMED = [
  ["NaN — `parseInt('abc', 10)`", NaN],
  ["zero", 0],
  ["negative", -5],
  ["Infinity", Infinity],
  ["-Infinity", -Infinity],
] as const;

describe("#833 AC-5: phaseTimeout resolution", () => {
  it("passes a valid timeout through untouched", () => {
    expect(resolve({ timeout: 60 }).phaseTimeout).toBe(60);
  });

  it("falls back to the default when no timeout is given", () => {
    expect(resolve({}).phaseTimeout).toBe(DEFAULT_CONFIG.phaseTimeout);
  });

  it.each(MALFORMED)("falls back to the default on %s", (_label, bad) => {
    const { phaseTimeout } = resolve({ timeout: bad });
    expect(phaseTimeout).toBe(DEFAULT_CONFIG.phaseTimeout);
  });

  it.each(MALFORMED)(
    "never yields a delay that setTimeout would clamp to 0 (%s)",
    (_label, bad) => {
      // The property that actually matters at phase-executor.ts:982.
      const delayMs = resolve({ timeout: bad }).phaseTimeout * 1000;
      expect(Number.isFinite(delayMs)).toBe(true);
      expect(delayMs).toBeGreaterThan(0);
    },
  );

  it("holds when the value arrives already merged, bypassing the CLI", () => {
    // `buildExecutionConfig` is called directly by programmatic callers; the
    // guard must not depend on having gone through `resolveRunOptions`.
    expect(
      buildExecutionConfig({ timeout: NaN } as RunOptions, settings, 1)
        .phaseTimeout,
    ).toBe(DEFAULT_CONFIG.phaseTimeout);
  });
});

describe("#833 AC-5: maxIterations resolution", () => {
  it("passes a valid iteration count through untouched", () => {
    expect(resolve({ maxIterations: 5 }).maxIterations).toBe(5);
  });

  it("falls back to the default when none is given", () => {
    expect(resolve({}).maxIterations).toBe(DEFAULT_CONFIG.maxIterations);
  });

  it.each(MALFORMED)("falls back to the default on %s", (_label, bad) => {
    expect(resolve({ maxIterations: bad }).maxIterations).toBe(
      DEFAULT_CONFIG.maxIterations,
    );
  });

  it.each(MALFORMED)(
    "never yields a bound that skips the quality loop entirely (%s)",
    (_label, bad) => {
      // The property that actually matters at batch-executor.ts:967 —
      // `while (iteration < maxIterations)` must be true on the first pass.
      const { maxIterations } = resolve({ maxIterations: bad });
      expect(0 < maxIterations).toBe(true);
    },
  );
});
