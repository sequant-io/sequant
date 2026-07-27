/**
 * Tests for the infra-blocked CI detection helpers used by `/qa` Phase 1.
 *
 * Covers AC-1 (the all-failing gate), AC-2 (the not-started signature and
 * verbatim message), AC-4 (no reclassification off the trigger path), and AC-5
 * (the captured live-incident fixture as the reference corpus).
 *
 * The fixtures below are copied verbatim from the admarble/ad-motion billing
 * lockout captured in issue #820. That capture is perishable — the incident is
 * resolved upstream and the annotation no longer exists — so this file is now
 * the only surviving record of the shape. Do not "tidy" the fixture text: the
 * detection regex is matched against real bytes here on purpose.
 */

import { describe, it, expect } from "vitest";
import {
  allChecksFailing,
  detectInfraBlockedCi,
  NOT_STARTED_SIGNATURE,
  type AnnotatedCheck,
} from "./infra-blocked-ci.js";

/**
 * Verbatim `gh api repos/{owner}/{repo}/commits/{head_sha}/check-runs`
 * → `.check_runs[0]` from the live incident.
 */
const FIXTURE_CHECK_RUN = {
  name: "conform (vertical)",
  status: "completed",
  conclusion: "failure",
  started_at: "2026-07-26T06:41:38Z",
  completed_at: "2026-07-26T06:41:40Z",
  output: { title: null, summary: null },
};

/** Verbatim `.output.annotations_url` → `.[0]` from the live incident. */
const FIXTURE_ANNOTATION = {
  annotation_level: "failure",
  path: ".github",
  message:
    "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings",
};

describe("allChecksFailing (AC-1, AC-4)", () => {
  it("returns true when every check is in the fail bucket", () => {
    expect(
      allChecksFailing([
        { bucket: "fail" },
        { bucket: "fail" },
        { bucket: "fail" },
      ]),
    ).toBe(true);
  });

  it("returns true for a single failing check", () => {
    expect(allChecksFailing([{ bucket: "fail" }])).toBe(true);
  });

  it("returns false when the check list is empty (no CI configured)", () => {
    expect(allChecksFailing([])).toBe(false);
  });

  it("returns false when checks are all passing", () => {
    expect(allChecksFailing([{ bucket: "pass" }, { bucket: "pass" }])).toBe(
      false,
    );
  });

  it("returns false for a mix of failing and passing checks", () => {
    expect(allChecksFailing([{ bucket: "fail" }, { bucket: "pass" }])).toBe(
      false,
    );
  });

  it("returns false when one check is still pending", () => {
    expect(allChecksFailing([{ bucket: "fail" }, { bucket: "pending" }])).toBe(
      false,
    );
  });

  it("returns false when a check is skipped alongside failures", () => {
    expect(allChecksFailing([{ bucket: "fail" }, { bucket: "skipping" }])).toBe(
      false,
    );
  });
});

describe("detectInfraBlockedCi — live-incident fixture (AC-2, AC-5)", () => {
  const fixtureChecks: AnnotatedCheck[] = [
    {
      checkName: FIXTURE_CHECK_RUN.name,
      annotations: [FIXTURE_ANNOTATION],
    },
  ];

  it("classifies the captured billing-lockout annotation as infra-blocked", () => {
    expect(detectInfraBlockedCi(fixtureChecks).blocked).toBe(true);
  });

  it("returns the annotation message verbatim, byte for byte", () => {
    // AC-2 requires the report to carry the message verbatim — the text names
    // the remedy ("Billing & plans"), which a paraphrase would drop.
    expect(detectInfraBlockedCi(fixtureChecks).message).toBe(
      FIXTURE_ANNOTATION.message,
    );
  });

  it("reports which check the annotation came from", () => {
    expect(detectInfraBlockedCi(fixtureChecks).checkName).toBe(
      "conform (vertical)",
    );
  });

  it("matches the fixture message case-insensitively", () => {
    expect(NOT_STARTED_SIGNATURE.test(FIXTURE_ANNOTATION.message)).toBe(true);
    expect(
      NOT_STARTED_SIGNATURE.test(FIXTURE_ANNOTATION.message.toUpperCase()),
    ).toBe(true);
  });

  it("matches regardless of annotation_level, which is deliberately not gated", () => {
    expect(
      detectInfraBlockedCi([
        {
          checkName: "conform (vertical)",
          annotations: [{ ...FIXTURE_ANNOTATION, annotation_level: "warning" }],
        },
      ]).blocked,
    ).toBe(true);
  });

  it("finds the signature on a later check when earlier ones are unannotated", () => {
    expect(
      detectInfraBlockedCi([
        { checkName: "lint", annotations: [] },
        { checkName: "build (20.x)", annotations: null },
        {
          checkName: FIXTURE_CHECK_RUN.name,
          annotations: [FIXTURE_ANNOTATION],
        },
      ]),
    ).toEqual({
      blocked: true,
      message: FIXTURE_ANNOTATION.message,
      checkName: "conform (vertical)",
    });
  });
});

describe("detectInfraBlockedCi — non-matching input (AC-4)", () => {
  it("returns not-blocked for an empty check list", () => {
    expect(detectInfraBlockedCi([])).toEqual({ blocked: false });
  });

  it("returns not-blocked when checks carry no annotations", () => {
    expect(
      detectInfraBlockedCi([
        { checkName: "lint", annotations: [] },
        { checkName: "build (22.x)" },
      ]),
    ).toEqual({ blocked: false });
  });

  it("returns not-blocked for a genuine test failure annotation", () => {
    expect(
      detectInfraBlockedCi([
        {
          checkName: "test",
          annotations: [
            {
              annotation_level: "failure",
              path: "src/lib/qa/infra-blocked-ci.ts",
              message: "Expected 3 assertions but received 2",
            },
          ],
        },
      ]),
    ).toEqual({ blocked: false });
  });

  it("returns not-blocked for a merely similar message", () => {
    // "cancelled before the job started" is a different condition (a cancelled
    // run), and must not be swept into the infra-blocked bucket.
    expect(
      detectInfraBlockedCi([
        {
          checkName: "build (20.x)",
          annotations: [
            { message: "The run was cancelled before the job started" },
          ],
        },
      ]).blocked,
    ).toBe(false);
  });

  it("tolerates null and missing message fields without throwing", () => {
    expect(
      detectInfraBlockedCi([
        {
          checkName: "lint",
          annotations: [{ message: null }, { annotation_level: "notice" }],
        },
      ]),
    ).toEqual({ blocked: false });
  });
});

describe("detectInfraBlockedCi — malformed API payloads degrade, never throw", () => {
  // `/qa` feeds this raw `gh api` output. A failed annotations request returns
  // an object where an array is expected; iterating it throws and would take
  // down the QA phase for the exact broken-CI case this detector exists to
  // handle gracefully. These pin degradation rather than crash.

  it("returns not-blocked when annotations is a gh api error object", () => {
    const ghError = {
      message: "Not Found",
      documentation_url: "https://docs.github.com",
    };
    expect(
      detectInfraBlockedCi([
        { checkName: "conform (vertical)", annotations: ghError },
      ] as unknown as AnnotatedCheck[]),
    ).toEqual({ blocked: false });
  });

  it("skips a malformed check but still matches a well-formed later one", () => {
    expect(
      detectInfraBlockedCi([
        {
          checkName: "broken",
          annotations: { message: "Not Found" },
        },
        {
          checkName: "conform (vertical)",
          annotations: [FIXTURE_ANNOTATION],
        },
      ] as unknown as AnnotatedCheck[]),
    ).toEqual({
      blocked: true,
      message: FIXTURE_ANNOTATION.message,
      checkName: "conform (vertical)",
    });
  });

  it("returns not-blocked when checks itself is not an array", () => {
    expect(
      detectInfraBlockedCi({
        message: "Bad credentials",
      } as unknown as AnnotatedCheck[]),
    ).toEqual({ blocked: false });
  });

  it("returns not-blocked for null/undefined entries in the checks array", () => {
    expect(
      detectInfraBlockedCi([null, undefined] as unknown as AnnotatedCheck[]),
    ).toEqual({ blocked: false });
  });

  it("returns not-blocked when annotations is a bare string", () => {
    expect(
      detectInfraBlockedCi([
        { checkName: "x", annotations: "job was not started" },
      ] as unknown as AnnotatedCheck[]),
    ).toEqual({ blocked: false });
  });
});
