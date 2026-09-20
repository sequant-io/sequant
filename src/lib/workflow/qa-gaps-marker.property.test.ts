/**
 * Round-trip property tests for `SEQUANT_QA_GAPS` markers (#1095).
 *
 * No production formatter exists (the emitter is skill prose), so `format`
 * here mirrors the documented shape. Generators encode the marker contract:
 * single-line JSON, no `-->`/`} -->` sequence and no backtick inside string
 * values; a boundary test pins the known-lossy `} -->` input.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseQaGapsMarker } from "./qa-gaps-marker.js";
import type { GapFinding } from "./run-log-schema.js";

const seedParam = (): { seed?: number } =>
  process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {};

const format = (findings: GapFinding[]) =>
  `<!-- SEQUANT_QA_GAPS: ${JSON.stringify({ findings })} -->`;

const text = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => !/[`\n\r]/.test(s) && !s.includes("-->"));

const finding: fc.Arbitrary<GapFinding> = fc.record(
  {
    category: fc.constantFrom(
      "requirement_gap",
      "dependency_gap",
      "test_gap",
      "repository_gap",
      "risk_gap",
      "execution_gap",
    ),
    evidence: text,
    description: text,
    recommendedAction: fc.constantFrom(
      "fix_now",
      "document",
      "pause_for_human",
    ),
    affectedAcs: fc.array(
      fc.integer({ min: 1, max: 99 }).map((n) => `AC-${n}`),
      { maxLength: 3 },
    ),
    nonGoal: fc.boolean(),
  },
  {
    requiredKeys: ["category", "evidence", "description", "recommendedAction"],
  },
) as fc.Arbitrary<GapFinding>;

describe("SEQUANT_QA_GAPS marker (property)", () => {
  it("property: parse(format(x)) round-trips", () => {
    fc.assert(
      fc.property(fc.array(finding, { maxLength: 5 }), (xs) => {
        expect(parseQaGapsMarker(`prose\n${format(xs)}\nmore`)).toEqual(xs);
      }),
      seedParam(),
    );
  });

  it("property: the last of several markers wins", () => {
    fc.assert(
      fc.property(
        fc.array(finding, { maxLength: 3 }),
        fc.array(finding, { maxLength: 3 }),
        (a, b) => {
          expect(parseQaGapsMarker(`${format(a)}\n${format(b)}`)).toEqual(b);
        },
      ),
      seedParam(),
    );
  });

  it("property: parse never throws on arbitrary text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (s) => {
        expect(() => parseQaGapsMarker(s)).not.toThrow();
      }),
      seedParam(),
    );
  });

  it("boundary: `} -->` inside a value truncates the marker (known lossy input)", () => {
    const x: GapFinding[] = [
      {
        category: "test_gap",
        evidence: "e",
        description: "has } --> inside",
        recommendedAction: "fix_now",
      },
    ];
    expect(parseQaGapsMarker(format(x))).toBeNull();
  });
});
