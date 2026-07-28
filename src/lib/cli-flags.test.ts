/**
 * #833 — numeric CLI flag coercion.
 *
 * The bug this guards: `bin/cli.ts` coerced `--timeout` with a bare `parseInt`.
 * `parseInt("abc", 10)` is `NaN`, which is not nullish and so survived the
 * `?? default` in `config-resolver.ts`, reaching `setTimeout` in
 * `phase-executor.ts` as a `NaN` delay. The spec clamps that to 0, so every
 * phase aborted the moment it started — and the failure read as a phase/agent
 * problem, not a bad flag. `parseInt("30m", 10)` is the quieter half: the user
 * asks for 30 minutes and silently gets 30 seconds.
 */

import { describe, it, expect } from "vitest";
import { InvalidArgumentError } from "commander";
import { parseWholeNumber, parsePositiveSeconds } from "./cli-flags.js";

describe("#833 parsePositiveSeconds", () => {
  const parse = parsePositiveSeconds("--timeout");

  it("accepts a plain whole number of seconds", () => {
    expect(parse("60")).toBe(60);
    expect(parse("1")).toBe(1);
    expect(parse("1800")).toBe(1800);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parse(" 60 ")).toBe(60);
  });

  // AC-3: non-integer input is rejected instead of coerced to NaN.
  it.each(["abc", "", "   ", "NaN", "Infinity", "1e3", "0x10", "--"])(
    "rejects non-integer input %j",
    (bad) => {
      expect(() => parse(bad)).toThrow(InvalidArgumentError);
      expect(() => parse(bad)).toThrow(
        /--timeout expects a whole number of seconds/,
      );
    },
  );

  // AC-4: the whole string must be digits, so a unit suffix cannot be dropped.
  it.each(["30m", "30s", "5min", "1.5", "2h"])(
    "rejects the silent-misparse form %j rather than reading its numeric prefix",
    (bad) => {
      expect(() => parse(bad)).toThrow(
        /--timeout expects a whole number of seconds/,
      );
    },
  );

  // AC-2: `--timeout 0` has no "no timeout" meaning on `run` (it reaches
  // setTimeout as a 0ms delay) or on `ready` (discarded by a `> 0` guard), so
  // rejecting it removes no working behavior.
  it("rejects 0 and negative values", () => {
    expect(() => parse("0")).toThrow(/--timeout must be at least 1 second/);
    expect(() => parse("-5")).toThrow(
      /--timeout expects a whole number of seconds/,
    );
  });

  it("rejects values beyond the safe-integer range", () => {
    expect(() => parse("9".repeat(20))).toThrow(/must be at least 1 second/);
  });

  it("names the flag it was built for, not a generic one", () => {
    expect(() => parsePositiveSeconds("--interval")("abc")).toThrow(
      /^--interval expects/,
    );
  });

  it("echoes the offending value so the user can see the typo", () => {
    expect(() => parse("30m")).toThrow(/\(got '30m'\)/);
  });
});

describe("#833 parseWholeNumber", () => {
  it("supports min: 0 for flags where 0 is a meaningful 'off' value", () => {
    // `--auto-wait 0` (#804) and `--grace 0` both mean something specific.
    const parse = parseWholeNumber("--auto-wait", {
      min: 0,
      unit: "minutes",
      unitSingular: "minute",
    });
    expect(parse("0")).toBe(0);
    expect(parse("90")).toBe(90);
    expect(() => parse("abc")).toThrow(
      /--auto-wait expects a whole number of minutes/,
    );
    expect(() => parse("30m")).toThrow(/expects a whole number of minutes/);
  });

  it("uses the plural unit when min is not 1", () => {
    const parse = parseWholeNumber("--retries", { min: 2, unit: "attempts" });
    expect(() => parse("1")).toThrow(/--retries must be at least 2 attempts/);
  });

  it("omits the unit entirely when none is given", () => {
    const parse = parseWholeNumber("--concurrency", { min: 1 });
    expect(parse("3")).toBe(3);
    expect(() => parse("abc")).toThrow(
      /--concurrency expects a whole number \(got 'abc'\)/,
    );
    expect(() => parse("0")).toThrow(
      /--concurrency must be at least 1 \(got '0'\)/,
    );
  });

  it("never returns NaN for any input it accepts", () => {
    const parse = parseWholeNumber("--n", { min: 0 });
    for (const good of ["0", "1", "7", "1000000"]) {
      const result = parse(good);
      expect(Number.isSafeInteger(result)).toBe(true);
      expect(Number.isNaN(result)).toBe(false);
    }
  });
});
