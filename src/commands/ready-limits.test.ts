/**
 * `resolveReadyLimits` — the ready-only `--budget` limit.
 *
 * History: #833 introduced this function to guard `--timeout`/`--max-iterations`
 * on the ready path, which at the time bypassed `buildExecutionConfig` (see the
 * function's doc comment). Since #863 those two limits are resolved by
 * `buildExecutionConfig` — CLI > env > settings > default, `positiveOr`-guarded
 * — and read back from the resolved config; the #833 property ("a bad
 * `settings.run.timeout` never reaches `setTimeout`") is asserted on the ready
 * path in `ready.test.ts` (`#863: a malformed settings timeout…`). Only the
 * budget, which never enters an `ExecutionConfig`, is resolved here.
 */

import { describe, it, expect } from "vitest";
import { resolveReadyLimits } from "./ready.js";

/** Every shape a bad number arrives in. */
const MALFORMED = [
  ["NaN", NaN],
  ["zero", 0],
  ["negative", -30],
  ["Infinity", Infinity],
  ["-Infinity", -Infinity],
] as const;

describe("#833 resolveReadyLimits — budget keeps its optional semantics", () => {
  it("passes a valid budget through", () => {
    expect(resolveReadyLimits({ budget: 50_000 }).tokenBudget).toBe(50_000);
  });

  it("stays undefined when unset — 'no budget' is not 'use a default'", () => {
    expect(resolveReadyLimits({}).tokenBudget).toBeUndefined();
  });

  it.each(MALFORMED)("treats a %s budget as no budget", (_label, bad) => {
    expect(resolveReadyLimits({ budget: bad }).tokenBudget).toBeUndefined();
  });
});
