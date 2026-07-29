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

/**
 * Resolve against settings whose numbers differ from `DEFAULT_CONFIG`'s, so a
 * test can tell *which* layer won. `DEFAULT_SETTINGS` can't: its `timeout` and
 * `maxIterations` are identical to the defaults they fall back to.
 */
function settingsWith(run: Partial<SequantSettings["run"]>): SequantSettings {
  return {
    ...DEFAULT_SETTINGS,
    run: { ...DEFAULT_SETTINGS.run, ...run },
  } as SequantSettings;
}

function resolveWithSettings(
  cli: Partial<RunOptions>,
  run: Partial<SequantSettings["run"]>,
) {
  const custom = settingsWith(run);
  return buildExecutionConfig(
    resolveRunOptions(cli as RunOptions, custom),
    custom,
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
    // Spelled out rather than using the `resolve` helper so the block names the
    // production functions it exercises — see the note on `resolve` above.
    const cfg = buildExecutionConfig(
      resolveRunOptions({ timeout: 60 } as RunOptions, settings),
      settings,
      1,
    );
    expect(cfg.phaseTimeout).toBe(60);
  });

  it("falls back to the default when no timeout is given", () => {
    const cfg = buildExecutionConfig(
      resolveRunOptions({} as RunOptions, settings),
      settings,
      1,
    );
    expect(cfg.phaseTimeout).toBe(DEFAULT_CONFIG.phaseTimeout);
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
    const cfg = buildExecutionConfig(
      resolveRunOptions({ maxIterations: 5 } as RunOptions, settings),
      settings,
      1,
    );
    expect(cfg.maxIterations).toBe(5);
  });

  it("falls back to the default when none is given", () => {
    const cfg = buildExecutionConfig(
      resolveRunOptions({} as RunOptions, settings),
      settings,
      1,
    );
    expect(cfg.maxIterations).toBe(DEFAULT_CONFIG.maxIterations);
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

describe("#833 layering: CLI → settings → default, same as commands/ready.ts", () => {
  it("prefers a valid CLI value over settings", () => {
    const custom = settingsWith({ timeout: 900, maxIterations: 4 });
    const cfg = buildExecutionConfig(
      resolveRunOptions(
        { timeout: 60, maxIterations: 7 } as RunOptions,
        custom,
      ),
      custom,
      1,
    );
    expect(cfg.phaseTimeout).toBe(60);
    expect(cfg.maxIterations).toBe(7);
  });

  it("uses settings when no CLI value is given", () => {
    const custom = settingsWith({ timeout: 900, maxIterations: 4 });
    const cfg = buildExecutionConfig(
      resolveRunOptions({} as RunOptions, custom),
      custom,
      1,
    );
    expect(cfg.phaseTimeout).toBe(900);
    expect(cfg.maxIterations).toBe(4);
  });

  it.each(MALFORMED)(
    "a %s CLI value falls back to settings, not past them to the default",
    (_label, bad) => {
      // `resolveRunOptions` spreads `...defined` last, so a malformed CLI value
      // overwrites the settings-derived one and the settings layer would be
      // lost if `buildExecutionConfig` fell straight to DEFAULT_CONFIG.
      const cfg = resolveWithSettings(
        { timeout: bad, maxIterations: bad },
        { timeout: 900, maxIterations: 4 },
      );
      expect(cfg.phaseTimeout).toBe(900);
      expect(cfg.maxIterations).toBe(4);
    },
  );

  it.each(MALFORMED)(
    "a %s settings value falls back to the default",
    (_label, bad) => {
      const cfg = resolveWithSettings({}, { timeout: bad, maxIterations: bad });
      expect(cfg.phaseTimeout).toBe(DEFAULT_CONFIG.phaseTimeout);
      expect(cfg.maxIterations).toBe(DEFAULT_CONFIG.maxIterations);
    },
  );

  it("survives both layers being unusable at once", () => {
    const cfg = resolveWithSettings(
      { timeout: NaN, maxIterations: 0 },
      { timeout: -1, maxIterations: NaN },
    );
    expect(cfg.phaseTimeout).toBe(DEFAULT_CONFIG.phaseTimeout);
    expect(cfg.maxIterations).toBe(DEFAULT_CONFIG.maxIterations);
    expect(cfg.phaseTimeout * 1000).toBeGreaterThan(0);
    expect(0 < cfg.maxIterations).toBe(true);
  });
});
