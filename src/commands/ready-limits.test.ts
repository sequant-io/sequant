/**
 * #833 — `ready`'s numeric limits, the path the first fix did not cover.
 *
 * `sequant run` resolves its phase timeout through `buildExecutionConfig`,
 * which now guards it. `sequant ready` does NOT: `ready-gate.ts`'s
 * `buildPhaseConfig` assembles its own `ExecutionConfig` and hands it straight
 * to the phase executor. So the guard added to `config-resolver` protected one
 * of the two producers.
 *
 * `ready.ts`'s original `typeof x === "number" && x > 0` checks stopped a bad
 * *CLI* value, but fell through unchecked to `settings.run.*` — user-authored
 * JSON that was itself unconstrained. `"timeout": 0` in settings.json therefore
 * reached `setTimeout` as a 0 ms delay and aborted every ready-gate phase on
 * its first tick, with no warning.
 */

import { describe, it, expect } from "vitest";
import { resolveReadyLimits } from "./ready.js";
import { DEFAULT_CONFIG } from "../lib/workflow/types.js";
import { DEFAULT_SETTINGS } from "../lib/settings.js";
import type { SequantSettings } from "../lib/settings.js";

/** Settings whose numeric values are distinct from DEFAULT_CONFIG's, so the
 *  tests can tell which layer actually won. */
function settingsWith(run: Partial<SequantSettings["run"]>) {
  return {
    ...DEFAULT_SETTINGS,
    run: { ...DEFAULT_SETTINGS.run, ...run },
  } as SequantSettings;
}

/** Every shape a bad number arrives in. */
const MALFORMED = [
  ["NaN", NaN],
  ["zero", 0],
  ["negative", -30],
  ["Infinity", Infinity],
  ["-Infinity", -Infinity],
] as const;

describe("#833 resolveReadyLimits — layering is CLI → settings → default", () => {
  it("prefers a valid CLI value over settings", () => {
    const limits = resolveReadyLimits(
      { timeout: 60, maxIterations: 7 },
      settingsWith({ timeout: 900, maxIterations: 4 }),
    );

    expect(limits.phaseTimeout).toBe(60);
    expect(limits.maxIterations).toBe(7);
  });

  it("falls back to settings when the CLI value is absent", () => {
    const limits = resolveReadyLimits(
      {},
      settingsWith({ timeout: 900, maxIterations: 4 }),
    );

    expect(limits.phaseTimeout).toBe(900);
    expect(limits.maxIterations).toBe(4);
  });

  it.each(MALFORMED)(
    "falls back to settings — not past them — when the CLI value is %s",
    (_label, bad) => {
      const limits = resolveReadyLimits(
        { timeout: bad, maxIterations: bad },
        settingsWith({ timeout: 900, maxIterations: 4 }),
      );

      // The user's configured value wins; the hardcoded default is the last
      // resort, not the first.
      expect(limits.phaseTimeout).toBe(900);
      expect(limits.maxIterations).toBe(4);
    },
  );
});

describe("#833 resolveReadyLimits — a bad settings value cannot reach setTimeout", () => {
  it.each(MALFORMED)(
    "settings.run.timeout of %s falls back to the default",
    (_label, bad) => {
      const limits = resolveReadyLimits({}, settingsWith({ timeout: bad }));

      expect(limits.phaseTimeout).toBe(DEFAULT_CONFIG.phaseTimeout);
    },
  );

  it.each(MALFORMED)(
    "settings.run.timeout of %s never yields a delay setTimeout would clamp to 0",
    (_label, bad) => {
      // The property that actually matters at phase-executor.ts:982, reached
      // via ready-gate.ts's buildPhaseConfig.
      const delayMs =
        resolveReadyLimits({}, settingsWith({ timeout: bad })).phaseTimeout *
        1000;

      expect(Number.isFinite(delayMs)).toBe(true);
      expect(delayMs).toBeGreaterThan(0);
    },
  );

  it.each(MALFORMED)(
    "settings.run.maxIterations of %s never yields a bound that skips every QA pass",
    (_label, bad) => {
      const { maxIterations } = resolveReadyLimits(
        {},
        settingsWith({ maxIterations: bad }),
      );

      expect(maxIterations).toBe(DEFAULT_CONFIG.maxIterations);
      // `while (iteration < maxIterations)` must be true on the first pass.
      expect(0 < maxIterations).toBe(true);
    },
  );

  it("survives BOTH layers being unusable at once", () => {
    const limits = resolveReadyLimits(
      { timeout: NaN, maxIterations: 0 },
      settingsWith({ timeout: -1, maxIterations: NaN }),
    );

    expect(limits.phaseTimeout).toBe(DEFAULT_CONFIG.phaseTimeout);
    expect(limits.maxIterations).toBe(DEFAULT_CONFIG.maxIterations);
  });
});

describe("#833 resolveReadyLimits — budget keeps its optional semantics", () => {
  it("passes a valid budget through", () => {
    expect(
      resolveReadyLimits({ budget: 50_000 }, DEFAULT_SETTINGS).tokenBudget,
    ).toBe(50_000);
  });

  it("stays undefined when unset — 'no budget' is not 'use a default'", () => {
    expect(
      resolveReadyLimits({}, DEFAULT_SETTINGS).tokenBudget,
    ).toBeUndefined();
  });

  it.each(MALFORMED)("treats a %s budget as no budget", (_label, bad) => {
    expect(
      resolveReadyLimits({ budget: bad }, DEFAULT_SETTINGS).tokenBudget,
    ).toBeUndefined();
  });
});
