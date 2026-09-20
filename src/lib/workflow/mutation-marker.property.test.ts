/**
 * Round-trip property tests for `SEQUANT_MUTATION` markers (#1095).
 *
 * No production formatter exists (the emitter is skill prose), so `format`
 * here mirrors the documented shape and this proves parser/doc consistency.
 * Generators encode the marker contract: flat JSON, and no `}` inside string
 * values (the `{[^}]+}` regex stops at the first `}`); a boundary test pins
 * that known-lossy input.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseMutationMarkers } from "./mutation-marker.js";

const seedParam = (): { seed?: number } =>
  process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {};

const format = (m: { ac: string; mutation: string; failedTest: string }) =>
  `<!-- SEQUANT_MUTATION: ${JSON.stringify(m)} -->`;

// Contract: non-empty, no `}`, no backtick (inline-code stripping), no newline.
const value = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => !/[}`\n\r]/.test(s) && s.trim().length > 0);

const payload = fc.record({
  ac: fc.integer({ min: 1, max: 99 }).map((n) => `AC-${n}`),
  mutation: value,
  failedTest: value,
});

describe("SEQUANT_MUTATION marker (property)", () => {
  it("property: parse(format(x)) round-trips", () => {
    fc.assert(
      fc.property(payload, fc.string({ maxLength: 40 }), (x, noise) => {
        // Noise must not swallow the marker: keep it free of fences/backticks.
        const clean = noise.replace(/`/g, "");
        const parsed = parseMutationMarkers(`${clean}\n${format(x)}\n${clean}`);
        expect(parsed).toEqual([x]);
      }),
      seedParam(),
    );
  });

  it("property: several markers parse in document order", () => {
    fc.assert(
      fc.property(fc.array(payload, { minLength: 1, maxLength: 5 }), (xs) => {
        expect(parseMutationMarkers(xs.map(format).join("\n"))).toEqual(xs);
      }),
      seedParam(),
    );
  });

  it("property: parse never throws on arbitrary text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (s) => {
        expect(() => parseMutationMarkers(s)).not.toThrow();
        expect(() => parseMutationMarkers(s, ["a.test.ts"])).not.toThrow();
      }),
      seedParam(),
    );
  });

  it("boundary: a `}` inside a value drops the marker (known lossy input)", () => {
    const x = {
      ac: "AC-1",
      mutation: "removed } brace",
      failedTest: "a.test.ts",
    };
    expect(parseMutationMarkers(format(x))).toEqual([]);
  });
});
