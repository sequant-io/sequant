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
import {
  parseWholeNumber,
  parsePositiveSeconds,
  type WholeNumberOptions,
} from "./cli-flags.js";

// Each test calls `parsePositiveSeconds` directly rather than through a
// describe-scope alias. Hoisting it would read fine but hides which production
// symbol the block actually exercises — from a reader and from the tautology
// detector, which counts a block with no directly-imported call as vacuous.
describe("#833 parsePositiveSeconds", () => {
  it("accepts a plain whole number of seconds", () => {
    expect(parsePositiveSeconds("--timeout")("60")).toBe(60);
    expect(parsePositiveSeconds("--timeout")("1")).toBe(1);
    expect(parsePositiveSeconds("--timeout")("1800")).toBe(1800);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parsePositiveSeconds("--timeout")(" 60 ")).toBe(60);
  });

  // AC-3: non-integer input is rejected instead of coerced to NaN.
  it.each(["abc", "", "   ", "NaN", "Infinity", "1e3", "0x10", "--"])(
    "rejects non-integer input %j",
    (bad) => {
      const parse = parsePositiveSeconds("--timeout");
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
      expect(() => parsePositiveSeconds("--timeout")(bad)).toThrow(
        /--timeout expects a whole number of seconds/,
      );
    },
  );

  // AC-2: `--timeout 0` has no "no timeout" meaning on `run` (it reaches
  // setTimeout as a 0ms delay) or on `ready` (discarded by a `> 0` guard), so
  // rejecting it removes no working behavior.
  it("rejects 0 and negative values", () => {
    expect(() => parsePositiveSeconds("--timeout")("0")).toThrow(
      /--timeout must be at least 1 second/,
    );
    expect(() => parsePositiveSeconds("--timeout")("-5")).toThrow(
      /--timeout expects a whole number of seconds/,
    );
  });

  it("rejects values beyond the safe-integer range", () => {
    expect(() => parsePositiveSeconds("--timeout")("9".repeat(20))).toThrow(
      /must be at least 1 second/,
    );
  });

  it("names the flag it was built for, not a generic one", () => {
    expect(() => parsePositiveSeconds("--interval")("abc")).toThrow(
      /^--interval expects/,
    );
  });

  it("echoes the offending value so the user can see the typo", () => {
    expect(() => parsePositiveSeconds("--timeout")("30m")).toThrow(
      /\(got '30m'\)/,
    );
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

// #845 — the eight sites `bin/cli.ts` migrated off bare `parseInt`. This table
// mirrors the exact `parseWholeNumber(...)` configs wired in `bin/cli.ts`; it
// documents the intended coercion per flag and pins each boundary that AC-4
// requires to keep parsing. That the flags are actually *attached* to these
// configs (and not silently reverted to `parseInt`) is proven separately by
// numeric-flags.integration.test.ts, which spawns the real CLI.
describe("#845 the eight migrated flags", () => {
  type FlagCase = {
    site: string;
    flag: string;
    opts: WholeNumberOptions;
    // A unit-suffixed value that `parseInt` would have silently truncated.
    suffixed: string;
    reject: RegExp;
    // A boundary that currently parses and must keep parsing (AC-4).
    boundary: string;
    expected: number;
  };

  const CASES: FlagCase[] = [
    {
      site: "status [issue]",
      flag: "issue",
      opts: { min: 1 },
      suffixed: "999999x",
      reject: /issue expects a whole number \(got '999999x'\)/,
      boundary: "123",
      expected: 123,
    },
    {
      site: "status --max-age",
      flag: "--max-age",
      opts: { min: 1, unit: "days" },
      suffixed: "1w",
      reject: /--max-age expects a whole number of days \(got '1w'\)/,
      boundary: "7",
      expected: 7,
    },
    {
      site: "prompt --wait",
      flag: "--wait",
      opts: { min: 0, unit: "seconds", unitSingular: "second" },
      suffixed: "30m",
      reject: /--wait expects a whole number of seconds \(got '30m'\)/,
      // The critical boundary: 0 = "don't block" (prompt.ts:259), so min:0.
      boundary: "0",
      expected: 0,
    },
    {
      site: "logs --last",
      flag: "--last",
      opts: { min: 1 },
      suffixed: "30m",
      reject: /--last expects a whole number \(got '30m'\)/,
      boundary: "30",
      expected: 30,
    },
    {
      site: "logs --issue",
      flag: "--issue",
      opts: { min: 1 },
      suffixed: "817x",
      reject: /--issue expects a whole number \(got '817x'\)/,
      boundary: "817",
      expected: 817,
    },
    {
      site: "dashboard --port",
      flag: "--port",
      opts: { min: 1 },
      suffixed: "3100x",
      reject: /--port expects a whole number \(got '3100x'\)/,
      boundary: "3100",
      expected: 3100,
    },
    {
      site: "serve --port",
      flag: "--port",
      opts: { min: 1 },
      suffixed: "3199x",
      reject: /--port expects a whole number \(got '3199x'\)/,
      boundary: "3199",
      expected: 3199,
    },
    {
      site: "state clean --max-age",
      flag: "--max-age",
      opts: { min: 1, unit: "days" },
      suffixed: "1w",
      reject: /--max-age expects a whole number of days \(got '1w'\)/,
      boundary: "7",
      expected: 7,
    },
  ];

  // AC-1: the unit-suffixed value is rejected, not read as its numeric prefix.
  it.each(CASES)(
    "$site rejects the suffixed value $suffixed",
    ({ flag, opts, suffixed, reject }) => {
      const parse = parseWholeNumber(flag, opts);
      expect(() => parse(suffixed)).toThrow(InvalidArgumentError);
      expect(() => parse(suffixed)).toThrow(reject);
    },
  );

  // AC-4: the boundary value that already parsed keeps parsing, unchanged.
  it.each(CASES)(
    "$site preserves the boundary value $boundary",
    ({ flag, opts, boundary, expected }) => {
      expect(parseWholeNumber(flag, opts)(boundary)).toBe(expected);
    },
  );
});
