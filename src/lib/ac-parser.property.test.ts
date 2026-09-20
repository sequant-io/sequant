/**
 * Property-based and metamorphic tests for `parseAcceptanceCriteria` (#1095).
 *
 * Set `FC_SEED` to replay a run; fast-check prints the failing seed on failure.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseAcceptanceCriteria } from "./ac-parser.js";

const seedParam = (): { seed?: number } =>
  process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {};

/** An AC line in one of the supported shapes, id fixed by the caller. */
type AcLine = { id: string; checked: boolean; shape: number; text: string };

// Word-only text: no `*`, `:`, `|`, backticks or "Evidence" so shapes stay unambiguous.
const wordText = fc
  .array(fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/), {
    minLength: 1,
    maxLength: 5,
  })
  .map((w) => w.join(" "));

const acLines = fc
  .uniqueArray(fc.integer({ min: 1, max: 99 }), { minLength: 1, maxLength: 8 })
  .chain((nums) =>
    fc.tuple(
      ...nums.map((n) =>
        fc.record({
          id: fc.constant(`AC-${n}`),
          checked: fc.boolean(),
          shape: fc.integer({ min: 0, max: 4 }),
          text: wordText,
        }),
      ),
    ),
  );

// Filler must not start with `-`, `#`, `|` or a fence, and must not look like an AC.
const filler = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ,.]{0,30}$/);

function render(ac: AcLine, checkedOverride?: boolean): string {
  const box = (checkedOverride ?? ac.checked) ? "[x]" : "[ ]";
  switch (ac.shape) {
    case 0:
      return `- ${box} **${ac.id}:** ${ac.text}`;
    case 1:
      return `- ${box} **${ac.id}: ${ac.text}**`;
    case 2:
      return `- ${box} **${ac.id}** ${ac.text}`;
    case 3:
      return `- ${box} **${ac.id}**: ${ac.text}`;
    default:
      return `- ${box} ${ac.id}: ${ac.text}`;
  }
}

/** Interleave AC lines with filler, keeping AC lines in order. */
function build(
  acs: AcLine[],
  fill: string[],
  fmtFiller: (s: string) => string = (s) => s,
  checkedOverride?: boolean,
): string {
  const out: string[] = [];
  acs.forEach((ac, i) => {
    if (fill[i] !== undefined) out.push(fmtFiller(fill[i]));
    out.push(render(ac, checkedOverride));
  });
  fill.slice(acs.length).forEach((f) => out.push(fmtFiller(f)));
  return out.join("\n");
}

const ids = (body: string): string[] =>
  parseAcceptanceCriteria(body)
    .map((c) => c.id)
    .sort();

describe("parseAcceptanceCriteria (property)", () => {
  it("property: never throws or hangs on arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (s) => {
        expect(() => parseAcceptanceCriteria(s)).not.toThrow();
      }),
      seedParam(),
    );
  });

  it("property: parsed id set is invariant under filler re-indent, filler reorder and [ ] -> [x]", () => {
    fc.assert(
      fc.property(
        acLines,
        fc.array(filler, { maxLength: 8 }),
        fc.boolean(),
        (acs, fill, checkAll) => {
          const base = ids(build(acs, fill));
          expect(base).toEqual(acs.map((a) => a.id).sort());

          // re-indent filler only (AC-line indentation is part of the format)
          expect(ids(build(acs, fill, (s) => `    ${s}`))).toEqual(base);
          // reorder unrelated lines
          expect(ids(build(acs, [...fill].reverse()))).toEqual(base);
          // checkbox state does not affect which ids are parsed
          expect(ids(build(acs, fill, undefined, checkAll))).toEqual(base);
        },
      ),
      seedParam(),
    );
  });

  it("property: every description token of a parsed AC appears in the input", () => {
    // Token-wise, not whole-string: pattern 3 (`**AC-1: foo** bar`) legitimately
    // re-joins the two capture groups with a space and drops the `**`.
    fc.assert(
      fc.property(acLines, fc.array(filler, { maxLength: 4 }), (acs, fill) => {
        const body = build(acs, fill);
        for (const c of parseAcceptanceCriteria(body)) {
          for (const token of c.description.split(/\s+/).filter(Boolean)) {
            expect(body).toContain(token);
          }
        }
      }),
      seedParam(),
    );
  });
});
