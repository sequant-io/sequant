/**
 * Tests for prior-assessment detection — supersession header,
 * re-assessment churn warning, and conflict-prompt predicate (#555).
 *
 * Covers AC-6 from the issue spec:
 *   - 0 prior assess comments → no supersession header
 *   - 1 prior matching action → header references that date, no churn
 *   - 3+ prior comments → churn warning fires
 *   - prior PROCEED + new PARK → conflict-prompt predicate triggers
 */

import { describe, expect, it } from "vitest";
import {
  buildSupersessionHeader,
  detectChurn,
  findAllAssessComments,
  shouldPromptOnConflict,
  type IssueComment,
} from "../assess-comment-parser.ts";

const assessBody = (action: string) =>
  `## Assess Analysis\n\n→ ${action} — reason here\n\n<!-- assess:action=${action} -->`;

const assessComment = (createdAt: string, action: string): IssueComment => ({
  body: assessBody(action),
  createdAt,
});

const regularComment = (createdAt: string, body = "Regular"): IssueComment => ({
  body,
  createdAt,
});

const execMarkerComment = (createdAt: string): IssueComment => ({
  body: `Implementation done.\n\n<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"${createdAt}","pr":42} -->`,
  createdAt,
});

describe("findAllAssessComments", () => {
  it("returns priors in chronological order (input order preserved)", () => {
    const comments: IssueComment[] = [
      assessComment("2026-04-17T00:00:00Z", "PROCEED"),
      regularComment("2026-04-18T00:00:00Z"),
      assessComment("2026-04-23T00:00:00Z", "PROCEED"),
      assessComment("2026-04-26T00:00:00Z", "PARK"),
    ];

    const priors = findAllAssessComments(comments);

    expect(priors).toHaveLength(3);
    expect(priors[0].createdAt).toBe("2026-04-17T00:00:00Z");
    expect(priors[1].createdAt).toBe("2026-04-23T00:00:00Z");
    expect(priors[2].createdAt).toBe("2026-04-26T00:00:00Z");
  });

  it("returns empty array when no assess comments exist", () => {
    expect(findAllAssessComments([])).toEqual([]);
    expect(
      findAllAssessComments([regularComment("2026-04-26T00:00:00Z")]),
    ).toEqual([]);
  });
});

describe("buildSupersessionHeader (AC-1, AC-2)", () => {
  it("returns null when there are 0 prior assess comments", () => {
    expect(buildSupersessionHeader([])).toBeNull();
  });

  it("formats single-prior header with date and action", () => {
    const priors: IssueComment[] = [
      assessComment("2026-04-23T18:30:00Z", "PROCEED"),
    ];

    expect(buildSupersessionHeader(priors)).toBe(
      "Supersedes prior assess from 2026-04-23 (PROCEED)",
    );
  });

  it("formats multi-prior header with count and most-recent date", () => {
    const priors: IssueComment[] = [
      assessComment("2026-04-17T00:00:00Z", "PROCEED"),
      assessComment("2026-04-23T00:00:00Z", "PROCEED"),
    ];

    expect(buildSupersessionHeader(priors)).toBe(
      "Supersedes 2 prior assessments (most recent: 2026-04-23)",
    );
  });

  it("falls back to 'unknown' action when prior has no parseable action", () => {
    const priors: IssueComment[] = [
      {
        body: "## Assess Analysis\n\nno action marker",
        createdAt: "2026-04-23T00:00:00Z",
      },
    ];

    expect(buildSupersessionHeader(priors)).toBe(
      "Supersedes prior assess from 2026-04-23 (unknown)",
    );
  });
});

describe("detectChurn (AC-3)", () => {
  it("does not fire for 0 priors", () => {
    expect(detectChurn([], [])).toEqual({ isChurn: false, count: 0 });
  });

  it("does not fire for 1 prior", () => {
    const priors = [assessComment("2026-04-23T00:00:00Z", "PROCEED")];
    expect(detectChurn(priors, priors)).toMatchObject({
      isChurn: false,
      count: 1,
    });
  });

  it("does not fire for 2 priors", () => {
    const priors = [
      assessComment("2026-04-17T00:00:00Z", "PROCEED"),
      assessComment("2026-04-23T00:00:00Z", "PROCEED"),
    ];
    expect(detectChurn(priors, priors)).toMatchObject({
      isChurn: false,
      count: 2,
    });
  });

  it("fires for 3+ priors with no exec marker between first and now", () => {
    const priors = [
      assessComment("2026-04-17T00:00:00Z", "PROCEED"),
      assessComment("2026-04-23T00:00:00Z", "PROCEED"),
      assessComment("2026-04-26T00:00:00Z", "PARK"),
    ];

    const result = detectChurn(priors, priors);

    expect(result.isChurn).toBe(true);
    expect(result.count).toBe(3);
    expect(result.firstDate).toBe("2026-04-17");
  });

  it("does not fire when exec marker appears after the first prior", () => {
    const priors = [
      assessComment("2026-04-17T00:00:00Z", "PROCEED"),
      assessComment("2026-04-23T00:00:00Z", "PROCEED"),
      assessComment("2026-04-26T00:00:00Z", "PROCEED"),
    ];
    const allComments: IssueComment[] = [
      priors[0],
      priors[1],
      execMarkerComment("2026-04-24T00:00:00Z"),
      priors[2],
    ];

    expect(detectChurn(priors, allComments).isChurn).toBe(false);
  });

  it("ignores exec markers dated before the first prior", () => {
    const priors = [
      assessComment("2026-04-17T00:00:00Z", "PROCEED"),
      assessComment("2026-04-23T00:00:00Z", "PROCEED"),
      assessComment("2026-04-26T00:00:00Z", "PARK"),
    ];
    const allComments: IssueComment[] = [
      execMarkerComment("2026-03-01T00:00:00Z"),
      ...priors,
    ];

    expect(detectChurn(priors, allComments).isChurn).toBe(true);
  });
});

describe("shouldPromptOnConflict (AC-4)", () => {
  it("returns true when prior PROCEED differs from new PARK", () => {
    expect(shouldPromptOnConflict("PROCEED", "PARK")).toBe(true);
  });

  it("returns true when prior REWRITE differs from new CLOSE", () => {
    expect(shouldPromptOnConflict("REWRITE", "CLOSE")).toBe(true);
  });

  it("returns false when prior and new actions match", () => {
    expect(shouldPromptOnConflict("PROCEED", "PROCEED")).toBe(false);
    expect(shouldPromptOnConflict("REWRITE", "REWRITE")).toBe(false);
    expect(shouldPromptOnConflict("PARK", "PARK")).toBe(false);
  });

  it("returns false for non-{PROCEED,REWRITE} priors even when actions differ", () => {
    expect(shouldPromptOnConflict("PARK", "PROCEED")).toBe(false);
    expect(shouldPromptOnConflict("CLOSE", "PROCEED")).toBe(false);
    expect(shouldPromptOnConflict("CLARIFY", "PROCEED")).toBe(false);
    expect(shouldPromptOnConflict("MERGE", "PROCEED")).toBe(false);
  });

  it("returns false when either action is undefined", () => {
    expect(shouldPromptOnConflict(undefined, "PROCEED")).toBe(false);
    expect(shouldPromptOnConflict("PROCEED", undefined)).toBe(false);
    expect(shouldPromptOnConflict(undefined, undefined)).toBe(false);
  });
});
