/**
 * Direct unit coverage for `formatEvidenceBundle` (#995).
 *
 * The halt tests in `model-ladder.test.ts` drive this formatter through the
 * real run and ready-gate paths, which is what proves the halts fire. They do
 * not, however, reach every branch of the renderer: an empty `shasTried`, an
 * empty `iterations` list, a present-but-empty `declaredAcs`, and a NON-empty
 * escalation history each render a distinct line that only shows up in halt
 * shapes those integration tests do not produce.
 *
 * Those branches are the ones a human reads when adjudicating a halt, and the
 * empty/non-empty escalation-history distinction is the load-bearing evidence
 * for "no rung was spent" (#971 AC-3/AC-4). A renderer that silently dropped
 * the line, or printed "(empty …)" over a populated history, would invert the
 * meaning of the bundle while every integration test stayed green.
 */

import { describe, it, expect } from "vitest";
import {
  formatEvidenceBundle,
  type EvidenceBundle,
  type LadderHaltReason,
} from "./divergence-halt.js";
import type { ModelEscalationRecord } from "./model-ladder.js";

/** A minimal bundle; each test overrides only the field it is about. */
function bundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    issueNumber: 995,
    phase: "exec",
    reason: "SPEC_DIVERGENCE",
    shasTried: [],
    iterations: [],
    escalationHistory: [],
    ...overrides,
  };
}

const RUNG_1: ModelEscalationRecord = {
  phase: "exec",
  rung: 1,
  base: "sonnet",
  escalated: "opus",
  trigger: "LOOP_NO_DIFF",
};

describe("formatEvidenceBundle: header and reason vocabulary", () => {
  it.each([
    ["SPEC_DIVERGENCE", "declared the spec impossible"],
    ["DIVERGENCE_SUSPECT", "repeated progress at a still-failing verdict"],
    ["TOP_OF_LADDER", "nowhere left to climb"],
  ] as Array<[LadderHaltReason, string]>)(
    "%s renders its own headline and next step",
    (reason, headlineFragment) => {
      const out = formatEvidenceBundle(bundle({ reason }));

      expect(out).toContain(
        `Ladder halt: ${reason} — issue #995, phase 'exec'`,
      );
      expect(out).toContain(headlineFragment);
      // Every reason must offer a distinct remedy: a halt that tells the human
      // nothing to do is the failure mode the bundle exists to prevent.
      expect(out).toMatch(/ {2}Next step: \S/);
    },
  );

  it("names the phase it halted in, not a hardcoded one", () => {
    expect(formatEvidenceBundle(bundle({ phase: "qa" }))).toContain(
      "phase 'qa'",
    );
  });
});

describe("formatEvidenceBundle: escalation history is the 'no rung spent' proof", () => {
  it("spells out an EMPTY history rather than omitting the section", () => {
    const out = formatEvidenceBundle(bundle());

    // Absent and empty must not be confusable — a reader should never have to
    // infer "no rung was spent" from a missing section.
    expect(out).toContain("Escalation history:");
    expect(out).toContain("(empty — no model rung was spent)");
  });

  it("renders a populated history and drops the empty claim", () => {
    const out = formatEvidenceBundle(
      bundle({
        reason: "TOP_OF_LADDER",
        escalationHistory: [
          RUNG_1,
          { ...RUNG_1, phase: "qa", rung: 2, escalated: "fable" },
        ],
      }),
    );

    expect(out).toContain("exec: sonnet → opus (rung 1, LOOP_NO_DIFF)");
    expect(out).toContain("qa: sonnet → fable (rung 2, LOOP_NO_DIFF)");
    // The inverse of the assertion above: printing "(empty …)" over a real
    // history would report a spent rung as unspent.
    expect(out).not.toContain("no model rung was spent");
  });
});

describe("formatEvidenceBundle: declaredAcs (AC-14 requires the AC be named)", () => {
  it("quotes the AC the agent named", () => {
    expect(
      formatEvidenceBundle(bundle({ declaredAcs: "AC-2, AC-5" })),
    ).toContain("Declared impossible: AC-2, AC-5");
  });

  it("reports a present-but-EMPTY declaration explicitly", () => {
    // The halt still has to say something: an agent that declared divergence
    // without naming an AC leaves the human nothing to reconcile, and silence
    // here would read as "no divergence was declared".
    expect(formatEvidenceBundle(bundle({ declaredAcs: "" }))).toContain(
      "Declared impossible: (the agent named no AC)",
    );
    expect(formatEvidenceBundle(bundle({ declaredAcs: "   " }))).toContain(
      "Declared impossible: (the agent named no AC)",
    );
  });

  it("omits the line entirely when the field is absent (non-divergence halts)", () => {
    expect(
      formatEvidenceBundle(bundle({ reason: "TOP_OF_LADDER" })),
    ).not.toContain("Declared impossible:");
  });
});

describe("formatEvidenceBundle: SHAs and iterations", () => {
  it("marks an empty SHA list rather than printing a bare label", () => {
    const out = formatEvidenceBundle(bundle());
    expect(out).toContain("SHAs tried: (none recorded)");
    expect(out).toContain("    (none recorded)");
  });

  it("joins SHAs and replays each iteration's verdict", () => {
    const out = formatEvidenceBundle(
      bundle({
        reason: "DIVERGENCE_SUSPECT",
        shasTried: ["sha-1", "sha-2"],
        iterations: [
          { iteration: 1, sha: "sha-1", verdict: "AC_NOT_MET" },
          { iteration: 2, sha: "sha-2", verdict: "AC_NOT_MET" },
        ],
      }),
    );

    expect(out).toContain("SHAs tried: sha-1, sha-2");
    expect(out).toContain("1: verdict=AC_NOT_MET sha=sha-1");
    expect(out).toContain("2: verdict=AC_NOT_MET sha=sha-2");
  });

  it("fills in missing per-iteration fields instead of printing undefined", () => {
    const out = formatEvidenceBundle(
      bundle({ iterations: [{ iteration: 1 }] }),
    );

    expect(out).toContain("1: verdict=(none) sha=(none)");
    expect(out).not.toContain("undefined");
  });

  it("includes the agent's own message when it supplied one", () => {
    expect(
      formatEvidenceBundle(bundle({ message: "AC-1 contradicts itself" })),
    ).toContain("Agent message: AC-1 contradicts itself");
  });
});

describe("formatEvidenceBundle: output shape", () => {
  it("uses plain labelled lines — no box-drawing characters", () => {
    // The bundle is read as often by an agent (in a /loop or /qa prompt) as by
    // a human, and box-drawing is hostile to both grep and LLM parsing.
    const out = formatEvidenceBundle(
      bundle({ shasTried: ["sha-1"], escalationHistory: [RUNG_1] }),
    );

    expect(out).not.toMatch(/[│─┌┐└┘├┤┬┴┼╔╗╚╝║═]/);
    expect(out.split("\n").every((l) => l === l.trimEnd())).toBe(true);
  });
});
