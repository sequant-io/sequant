/**
 * Property tests for `parseQaSummary` and the QA verdict comment (#1095, #1073).
 *
 * Set `FC_SEED` to replay a run; fast-check prints the failing seed on failure.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseQaSummary, parseQaVerdict } from "./phase-executor.js";
import { buildQaVerdictComment } from "./batch-executor.js";
import type { QaVerdict } from "./run-log-schema.js";

const seedParam = (): { seed?: number } =>
  process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {};

const wordText = fc
  .array(fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/), {
    minLength: 1,
    maxLength: 4,
  })
  .map((w) => w.join(" "));

type Shape = "table" | "checklist" | "bold";

const renderAc = (shape: Shape, n: number, met: boolean, text: string) => {
  switch (shape) {
    case "table":
      return `| AC-${n} | ${text} | ${met ? "✅ MET" : "❌ NOT_MET"} | notes |`;
    case "checklist":
      return `- [${met ? "x" : " "}] **AC-${n}**: ${text}`;
    case "bold":
      return `- **AC-${n}**: ${met ? "MET" : "NOT_MET"} — ${text}`;
  }
};

const report = (shapes: readonly Shape[]) =>
  fc
    .uniqueArray(fc.integer({ min: 1, max: 99 }), {
      minLength: 1,
      maxLength: 10,
    })
    .chain((nums) =>
      fc.tuple(
        ...nums.map((n) =>
          fc.record({
            n: fc.constant(n),
            shape: fc.constantFrom(...shapes),
            met: fc.boolean(),
            text: wordText,
          }),
        ),
      ),
    );

describe("parseQaVerdict (property)", () => {
  const verdictArb = fc.constantFrom(
    "READY_FOR_MERGE",
    "AC_MET_BUT_NOT_A_PLUS",
    "AC_NOT_MET",
    "NEEDS_VERIFICATION",
  );

  it("property: the recorded verdict is the one the final heading names (#1119)", () => {
    fc.assert(
      fc.property(
        fc.array(verdictArb, { maxLength: 4 }),
        verdictArb,
        (quoted, final) => {
          const before = quoted.map((v) => `## QA Verdict: ${v}`).join("\n");
          const out = `${before}\n\n### Verdict: ${final}\n\nDone.`;
          expect(parseQaVerdict(out)).toBe(final);
        },
      ),
      seedParam(),
    );
  });
});

describe("parseQaSummary (property)", () => {
  it("property: never throws on arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (s) => {
        expect(() => parseQaSummary(s)).not.toThrow();
      }),
      seedParam(),
    );
  });

  it("property: table, checklist and bold-prefixed AC lines are all counted (checklist)", () => {
    fc.assert(
      fc.property(report(["table", "checklist", "bold"]), (acs) => {
        const out = [
          "## QA Review",
          "",
          ...acs.map((a) => renderAc(a.shape, a.n, a.met, a.text)),
          "",
          "### Verdict: AC_MET_BUT_NOT_A_PLUS",
        ].join("\n");
        const summary = parseQaSummary(out);
        expect(summary).not.toBeNull();
        expect(summary?.acTotal).toBe(acs.length);
        expect(summary?.acMet).toBe(acs.filter((a) => a.met).length);
      }),
      seedParam(),
    );
  });

  it("property: checklist-only reports count every checkbox (checklist)", () => {
    fc.assert(
      fc.property(report(["checklist"]), (acs) => {
        const out = acs
          .map((a) => renderAc("checklist", a.n, a.met, a.text))
          .join("\n");
        const summary = parseQaSummary(out);
        expect(summary?.acTotal).toBe(acs.length);
        expect(summary?.acMet).toBe(acs.filter((a) => a.met).length);
      }),
      seedParam(),
    );
  });
});

describe("buildQaVerdictComment (property)", () => {
  const passing: QaVerdict[] = ["READY_FOR_MERGE", "AC_MET_BUT_NOT_A_PLUS"];

  it("property: consistency - a passing verdict never carries a 0/N met count line", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...passing),
        fc.integer({ min: 0, max: 20 }),
        (verdict, acTotal) => {
          const body = buildQaVerdictComment(
            verdict,
            { acMet: 0, acTotal, gaps: [], suggestions: [] },
            "abc123",
            1,
          );
          expect(body).not.toMatch(/AC coverage: 0\/\d+ met/);
          expect(body).toContain(`## QA Verdict: ${verdict}`);
        },
      ),
      seedParam(),
    );
  });

  it("property: consistency - parsed checklist counts never yield 0/N under a passing verdict", () => {
    fc.assert(
      fc.property(
        report(["checklist"]),
        fc.constantFrom(...passing),
        (acs, verdict) => {
          const out = acs
            .map((a) => renderAc("checklist", a.n, a.met, a.text))
            .join("\n");
          const summary = parseQaSummary(out);
          expect(summary).not.toBeNull();
          const body = buildQaVerdictComment(
            verdict,
            summary ?? undefined,
            undefined,
            1,
          );
          if (summary && summary.acMet > 0) {
            expect(body).toContain(
              `AC coverage: ${summary.acMet}/${summary.acTotal} met`,
            );
          } else {
            expect(body).not.toContain("AC coverage:");
          }
        },
      ),
      seedParam(),
    );
  });
});
