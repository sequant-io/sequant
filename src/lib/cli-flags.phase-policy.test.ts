/**
 * Test stub for #914 AC-2 / AC-8 — `--models`/`--efforts` fail fast at the
 * Commander `.option()` boundary, mirroring `parseWholeNumber`'s
 * `InvalidArgumentError` pattern (#804 class) so malformed specs show up in
 * `--help` behavior and never silently no-op (#305 class).
 *
 * Assumes a `parsePhaseSpecFlag(flag, phaseNames)` wrapper added to
 * `cli-flags.ts` around `config-resolver.ts`'s `parsePhaseSpec` (see
 * `config-resolver.phase-policy.test.ts`), converting its thrown errors into
 * `InvalidArgumentError` the way `parseWholeNumber` does. This is a stub
 * proposal for the wiring shape, not a locked contract.
 */

import { describe, it, expect } from "vitest";
import { InvalidArgumentError } from "commander";
import { parsePhaseSpecFlag } from "./cli-flags.js";

const PHASE_NAMES = ["spec", "exec", "qa", "test", "loop", "testgen"];

describe("#914 AC-2/AC-8: parsePhaseSpecFlag CLI boundary", () => {
  it("accepts a bare value applied to all phases", () => {
    const parse = parsePhaseSpecFlag("--models", PHASE_NAMES);
    expect(parse("sonnet")).toEqual({ "*": "sonnet" });
  });

  it("accepts a comma list of phase=value pairs", () => {
    const parse = parsePhaseSpecFlag("--efforts", PHASE_NAMES);
    expect(parse("exec=medium,qa=high")).toEqual({
      exec: "medium",
      qa: "high",
    });
  });

  it.each(["spec=", "sonnet,exec=fable", "badphase=x"])(
    "rejects a malformed spec with InvalidArgumentError: %j",
    (bad) => {
      const parse = parsePhaseSpecFlag("--models", PHASE_NAMES);
      expect(() => parse(bad)).toThrow(InvalidArgumentError);
    },
  );
});
