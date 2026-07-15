/**
 * Tests for the `--chain` content pre-flight (#762).
 *
 * Per AC-5, each warning class is exercised against VERBATIM issue-body
 * fixtures (real markers like `Blocked by #38`, real `## Acceptance Criteria`
 * headings) and tested individually — no synthetic combined fixture jams every
 * marker into one body (feedback_synthetic_test_fixture_trap).
 */

import { describe, it, expect } from "vitest";
import {
  computePreflightWarnings,
  parseDeclaredBlockers,
  hasNonEmptyAcSection,
  type PreflightIssue,
} from "./chain-preflight.js";

/** Build a fetched-issue map from a list of issues. */
function toMap(issues: PreflightIssue[]): Map<number, PreflightIssue> {
  return new Map(issues.map((i) => [i.number, i]));
}

// ── Verbatim fixtures ─────────────────────────────────────────────────────

/** An issue with a normal `AC-N:`-prefixed Acceptance Criteria section. */
const AC_PREFIXED_BODY = `## Context

Some background.

## Acceptance Criteria

- [ ] **AC-1:** The widget renders.
- [ ] **AC-2:** The widget persists.
`;

/**
 * An issue whose AC section uses bare checkboxes (no \`AC-N:\` prefix) — copied
 * verbatim from this feature's own issue (#762). ac-parser's AC-N patterns do
 * NOT match these, so this is the false-positive case the fallback guards.
 */
const BARE_CHECKBOX_AC_BODY = `## Proposal

A fast pre-flight at chain start.

## Acceptance Criteria

- [ ] \`--chain\` runs print pre-flight warnings for: missing/empty AC section.
- [ ] Warnings never block by default; an opt-in flag makes them fatal.
`;

/** An issue body with no Acceptance Criteria section at all. */
const NO_AC_BODY = `## Context

This issue describes a bug but never lists acceptance criteria.

## Notes

Just some prose, no checkboxes under an AC heading.
`;

/** An issue with an AC heading but no checkbox items under it (empty section). */
const EMPTY_AC_BODY = `## Acceptance Criteria

## Out of scope

- [ ] this checkbox is under a DIFFERENT heading, not AC.
`;

describe("hasNonEmptyAcSection", () => {
  it("returns true for a standard AC-N: prefixed section (ac-parser fast path)", () => {
    expect(hasNonEmptyAcSection(AC_PREFIXED_BODY)).toBe(true);
  });

  it("returns true for a bare-checkbox AC section (fallback; verbatim #762 body)", () => {
    expect(hasNonEmptyAcSection(BARE_CHECKBOX_AC_BODY)).toBe(true);
  });

  it("returns false when there is no Acceptance Criteria section", () => {
    expect(hasNonEmptyAcSection(NO_AC_BODY)).toBe(false);
  });

  it("returns false for an AC heading with no checkbox items before the next heading", () => {
    expect(hasNonEmptyAcSection(EMPTY_AC_BODY)).toBe(false);
  });
});

describe("parseDeclaredBlockers", () => {
  it("catches the verbatim `Blocked by #38` marker (the AC-2 motivating example)", () => {
    expect(
      parseDeclaredBlockers("This is Blocked by #38 until it lands."),
    ).toEqual([38]);
  });

  it("catches `depends on #N` and bold `**Depends on**: #N`", () => {
    expect(parseDeclaredBlockers("depends on #123")).toEqual([123]);
    expect(parseDeclaredBlockers("**Depends on**: #456")).toEqual([456]);
  });

  it("dedups repeated markers and preserves first-seen order", () => {
    expect(
      parseDeclaredBlockers(
        "Blocked by #10. Also depends on #11. Depends on #10.",
      ),
    ).toEqual([10, 11]);
  });

  it("ignores markers inside fenced code blocks", () => {
    const body = "Prose.\n\n```\n# example: blocked by #99\n```\n";
    expect(parseDeclaredBlockers(body)).toEqual([]);
  });
});

describe("computePreflightWarnings — one class per test (AC-1/AC-5)", () => {
  it("warns on a missing/empty Acceptance Criteria section", () => {
    const warnings = computePreflightWarnings(
      [200],
      toMap([{ number: 200, body: NO_AC_BODY, state: "OPEN", title: "Bug" }]),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ issue: 200, kind: "missing-ac" });
  });

  it("warns when the CLI order contradicts a declared `Blocked by #N` marker", () => {
    // Verbatim: #39 declares it is blocked by #38, but the CLI runs `39 38`,
    // i.e. #38 AFTER #39 — the #762 raw-order regression (Open Question #1).
    const blockedBody = `## Context\n\nBlocked by #38.\n\n## Acceptance Criteria\n\n- [ ] **AC-1:** thing works.\n`;
    const warnings = computePreflightWarnings(
      [39, 38],
      toMap([
        { number: 39, body: blockedBody, state: "OPEN", title: "Successor" },
        {
          number: 38,
          body: AC_PREFIXED_BODY,
          state: "OPEN",
          title: "Predecessor",
        },
      ]),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ issue: 39, kind: "dependency-order" });
  });

  it("does NOT warn when the declared blocker already runs first", () => {
    const blockedBody = `## Context\n\nBlocked by #38.\n\n## Acceptance Criteria\n\n- [ ] **AC-1:** thing works.\n`;
    const warnings = computePreflightWarnings(
      [38, 39],
      toMap([
        {
          number: 38,
          body: AC_PREFIXED_BODY,
          state: "OPEN",
          title: "Predecessor",
        },
        { number: 39, body: blockedBody, state: "OPEN", title: "Successor" },
      ]),
    );
    expect(warnings).toHaveLength(0);
  });

  it("warns when the CLI order contradicts the predicted file-overlap order (AC-3)", () => {
    // Both issues name `src/lib/foo.ts`; predicted land order is #40 → #41
    // (ascending), but the CLI runs them #41 #40.
    const bodyA = `## Acceptance Criteria\n\n- [ ] **AC-1:** update \`src/lib/foo.ts\`.\n`;
    const bodyB = `## Acceptance Criteria\n\n- [ ] **AC-1:** also edit \`src/lib/foo.ts\`.\n`;
    const warnings = computePreflightWarnings(
      [41, 40],
      toMap([
        { number: 41, body: bodyB, state: "OPEN", title: "B" },
        { number: 40, body: bodyA, state: "OPEN", title: "A" },
      ]),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ kind: "file-overlap-order" });
    expect(warnings[0].message).toContain("src/lib/foo.ts");
  });

  it("does NOT warn when file-sharing issues already run in ascending order", () => {
    const bodyA = `## Acceptance Criteria\n\n- [ ] **AC-1:** update \`src/lib/foo.ts\`.\n`;
    const bodyB = `## Acceptance Criteria\n\n- [ ] **AC-1:** also edit \`src/lib/foo.ts\`.\n`;
    const warnings = computePreflightWarnings(
      [40, 41],
      toMap([
        { number: 40, body: bodyA, state: "OPEN", title: "A" },
        { number: 41, body: bodyB, state: "OPEN", title: "B" },
      ]),
    );
    expect(warnings).toHaveLength(0);
  });

  it("warns when a chained issue is CLOSED on GitHub (AC-4, #305-consistent)", () => {
    const warnings = computePreflightWarnings(
      [300],
      toMap([
        { number: 300, body: AC_PREFIXED_BODY, state: "CLOSED", title: "Done" },
      ]),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ issue: 300, kind: "closed-issue" });
    expect(warnings[0].message).toContain("#592");
  });
});

describe("computePreflightWarnings — AC-1 all three classes at once", () => {
  it("returns exactly three warnings, one per class, over three real bodies", () => {
    // #100 lacks an AC section; #102 declares `Blocked by #101` AND shares a
    // file with #101; CLI order [100, 102, 101] makes the #101/#102 pair
    // contradict both the dependency marker and the ascending overlap order.
    const missingAc = NO_AC_BODY;
    const blockedAndOverlap = `## Context\n\nBlocked by #101.\n\n## Acceptance Criteria\n\n- [ ] **AC-1:** edit \`src/lib/shared.ts\`.\n`;
    const overlapPartner = `## Acceptance Criteria\n\n- [ ] **AC-1:** also edit \`src/lib/shared.ts\`.\n`;

    const warnings = computePreflightWarnings(
      [100, 102, 101],
      toMap([
        { number: 100, body: missingAc, state: "OPEN", title: "No AC" },
        {
          number: 102,
          body: blockedAndOverlap,
          state: "OPEN",
          title: "Blocked + overlap",
        },
        { number: 101, body: overlapPartner, state: "OPEN", title: "Partner" },
      ]),
    );

    expect(warnings).toHaveLength(3);
    expect(new Set(warnings.map((w) => w.kind))).toEqual(
      new Set(["missing-ac", "dependency-order", "file-overlap-order"]),
    );
  });
});

describe("computePreflightWarnings — robustness (AC-2 warn-only, warn-degrade)", () => {
  it("returns an empty list (never throws) for a clean, consistent chain", () => {
    const clean = `## Acceptance Criteria\n\n- [ ] **AC-1:** unique change in \`src/lib/a.ts\`.\n`;
    const clean2 = `## Acceptance Criteria\n\n- [ ] **AC-1:** unique change in \`src/lib/b.ts\`.\n`;
    const warnings = computePreflightWarnings(
      [10, 11],
      toMap([
        { number: 10, body: clean, state: "OPEN", title: "A" },
        { number: 11, body: clean2, state: "OPEN", title: "B" },
      ]),
    );
    expect(warnings).toEqual([]);
  });

  it("warn-degrades: an issue missing from the fetched map is silently skipped", () => {
    // #12 failed to fetch (absent from the map). Its checks are skipped rather
    // than throwing — the pre-flight must never break a run.
    const clean = `## Acceptance Criteria\n\n- [ ] **AC-1:** change \`src/lib/a.ts\`.\n`;
    const warnings = computePreflightWarnings(
      [10, 12],
      toMap([{ number: 10, body: clean, state: "OPEN", title: "A" }]),
    );
    expect(warnings).toEqual([]);
  });
});
