/**
 * Commander argument coercions for numeric CLI flags.
 *
 * Lives here rather than inline in `bin/cli.ts` so it can be unit-tested
 * directly — `bin/cli.ts` calls `program.parse()` at import time and cannot be
 * imported from a test.
 *
 * @module
 */

import { InvalidArgumentError } from "commander";
import { parsePhaseSpec } from "./workflow/config-resolver.js";

/** Error-text shaping for a numeric flag. Affects messages only, not parsing. */
export interface WholeNumberOptions {
  /** Smallest accepted value. Use 0 where 0 is a meaningful "off" setting. */
  min: number;
  /** Plural unit, e.g. `"seconds"`. Omit for a flag that reads better bare. */
  unit?: string;
  /** Singular unit, used when `min` is 1 ("at least 1 second"). */
  unitSingular?: string;
}

/**
 * Build a commander coercion for a whole-number flag.
 *
 * A bare `parseInt` is unsafe for these: `parseInt("abc", 10)` is `NaN`, which
 * is not nullish and so survives a `?? default`, and `parseInt("30m", 10)`
 * silently yields `30` — the user asked for 30 minutes and got 30 seconds.
 * Requiring the whole string to be digits rejects both instead of accepting a
 * value that is unusable or quietly wrong (#818, #833).
 */
export function parseWholeNumber(
  flag: string,
  opts: WholeNumberOptions,
): (value: string) => number {
  const { min, unit, unitSingular } = opts;
  const ofUnit = unit ? ` of ${unit}` : "";
  const minUnit = min === 1 ? (unitSingular ?? unit) : unit;
  const minSuffix = minUnit ? ` ${minUnit}` : "";
  return (value: string): number => {
    if (!/^\d+$/.test(value.trim())) {
      throw new InvalidArgumentError(
        `${flag} expects a whole number${ofUnit} (got '${value}').`,
      );
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min) {
      throw new InvalidArgumentError(
        `${flag} must be at least ${min}${minSuffix} (got '${value}').`,
      );
    }
    return parsed;
  };
}

/**
 * A positive-integer *seconds* flag — the #831 shape, preserved verbatim so the
 * `merge --watch` messages this originally shipped with do not change.
 */
export function parsePositiveSeconds(flag: string): (value: string) => number {
  return parseWholeNumber(flag, {
    min: 1,
    unit: "seconds",
    unitSingular: "second",
  });
}

/**
 * Build a commander coercion for a `--models`/`--efforts`-shaped flag (#914).
 *
 * Validates the spec via `config-resolver.ts`'s `parsePhaseSpec` — a bare
 * value applies to every phase, a comma list of `phase=value` pairs applies
 * per phase, and a malformed spec (empty segment, mixed bare/pair form, or
 * an unrecognized phase name) fails fast here rather than reaching
 * `resolvePhasePolicies` silently. On success, returns the ORIGINAL raw spec
 * string unchanged (not the parsed map) — `RunOptions.models`/`.efforts`
 * stay plain strings, and `resolvePhasePolicies` re-parses for real when
 * building `ExecutionConfig.phasePolicies`, so parsing has exactly one
 * source of truth even though it runs twice.
 */
export function parsePhaseSpecFlag(
  flag: string,
  phaseNames: string[],
): (value: string) => string {
  return (value: string): string => {
    try {
      parsePhaseSpec(value, phaseNames);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InvalidArgumentError(`${flag}: ${message}`);
    }
    return value;
  };
}
