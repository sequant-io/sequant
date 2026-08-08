/**
 * Test for #914 AC-2 / AC-8 — `--models`/`--efforts` fail fast at the
 * Commander `.option()` boundary, mirroring `parseWholeNumber`'s
 * `InvalidArgumentError` pattern (#804 class) so malformed specs show up in
 * `--help` behavior and never silently no-op (#305 class).
 *
 * `parsePhaseSpecFlag(flag, phaseNames)` only VALIDATES via
 * `config-resolver.ts`'s `parsePhaseSpec` and converts a thrown error into
 * `InvalidArgumentError`; on success it returns the original raw spec string
 * unchanged (not the parsed map) — `RunOptions.models`/`.efforts` stay plain
 * strings, and `resolvePhasePolicies` re-parses them for real when building
 * `ExecutionConfig.phasePolicies`. This matches how `resolvePhasePolicies`
 * is already exercised in `config-resolver.phase-policy.test.ts` (raw string
 * in, not a pre-parsed map).
 */

import { describe, it, expect } from "vitest";
import { InvalidArgumentError } from "commander";
import { parsePhaseSpecFlag } from "./cli-flags.js";

const PHASE_NAMES = ["spec", "exec", "qa", "test", "loop", "testgen"];

describe("#914 AC-2/AC-8: parsePhaseSpecFlag CLI boundary", () => {
  it("accepts a bare value and returns it unchanged", () => {
    const parse = parsePhaseSpecFlag("--models", PHASE_NAMES);
    expect(parse("sonnet")).toBe("sonnet");
  });

  it("accepts a comma list of phase=value pairs and returns it unchanged", () => {
    const parse = parsePhaseSpecFlag("--efforts", PHASE_NAMES);
    expect(parse("exec=medium,qa=high")).toBe("exec=medium,qa=high");
  });

  it.each(["spec=", "sonnet,exec=fable", "badphase=x"])(
    "rejects a malformed spec with InvalidArgumentError: %j",
    (bad) => {
      const parse = parsePhaseSpecFlag("--models", PHASE_NAMES);
      expect(() => parse(bad)).toThrow(InvalidArgumentError);
    },
  );
});
