import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseSpecMarker,
  resolveSpecRecommendation,
  type ResolveSpecRecommendationInput,
} from "./spec-recommendation.js";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../__tests__/fixtures/spec-recommendation-814.json",
        import.meta.url,
      ),
    ),
    "utf-8",
  ),
) as { chatText: string; commentBody: string };

/** Stub matching the `githubProvider` DI slot of `resolveSpecRecommendation`. */
function stubProvider(commentBodies: string[]) {
  return { fetchIssueCommentBodiesSync: () => commentBodies };
}

describe("parseSpecMarker", () => {
  it("parses a valid marker", () => {
    const result = parseSpecMarker([
      '<!-- SEQUANT_SPEC: {"phases":["testgen","exec","qa"],"qualityLoop":true} -->',
    ]);
    expect(result).toEqual({
      phases: ["testgen", "exec", "qa"],
      qualityLoop: true,
    });
  });

  it("defaults qualityLoop to false when omitted", () => {
    const result = parseSpecMarker([
      '<!-- SEQUANT_SPEC: {"phases":["exec","qa"]} -->',
    ]);
    expect(result).toEqual({ phases: ["exec", "qa"], qualityLoop: false });
  });

  it("returns null when no marker is present", () => {
    expect(parseSpecMarker(["just some prose, no marker here"])).toBeNull();
  });

  it("returns null on malformed JSON (AC-2)", () => {
    expect(
      parseSpecMarker(["<!-- SEQUANT_SPEC: {not valid json} -->"]),
    ).toBeNull();
  });

  it("returns null when phases fails schema validation (AC-2)", () => {
    // phases must be a non-empty array of strings
    expect(
      parseSpecMarker(['<!-- SEQUANT_SPEC: {"phases":[]} -->']),
    ).toBeNull();
  });

  it("returns null when a phase name is not in the registry (AC-2)", () => {
    expect(
      parseSpecMarker([
        '<!-- SEQUANT_SPEC: {"phases":["exec","not-a-real-phase"]} -->',
      ]),
    ).toBeNull();
  });

  it("ignores a marker inside a fenced code block (reuses stripMarkdownCode)", () => {
    const body = [
      "Example marker for documentation purposes:",
      "```",
      '<!-- SEQUANT_SPEC: {"phases":["exec","qa"]} -->',
      "```",
    ].join("\n");
    expect(parseSpecMarker([body])).toBeNull();
  });

  it("takes the latest marker across comments when multiple exist", () => {
    const result = parseSpecMarker([
      '<!-- SEQUANT_SPEC: {"phases":["exec","qa"]} -->',
      '<!-- SEQUANT_SPEC: {"phases":["testgen","exec","qa"],"qualityLoop":true} -->',
    ]);
    expect(result).toEqual({
      phases: ["testgen", "exec", "qa"],
      qualityLoop: true,
    });
  });
});

describe("resolveSpecRecommendation — resolution chain (AC-3)", () => {
  const base: ResolveSpecRecommendationInput = {
    chatOutput: "",
    issueNumber: 999,
    labels: ["enhancement"],
  };

  it("prefers the comment marker when present", () => {
    const result = resolveSpecRecommendation({
      ...base,
      chatOutput:
        "## Recommended Workflow\n**Phases:** exec → qa\n**Quality Loop:** disabled",
      githubProvider: stubProvider([
        '<!-- SEQUANT_SPEC: {"phases":["testgen","exec","qa"],"qualityLoop":true} -->',
      ]),
    });
    expect(result).toEqual({
      phases: ["testgen", "exec", "qa"],
      qualityLoop: true,
      source: "marker",
    });
  });

  it("falls through to comment prose when no marker is present", () => {
    const result = resolveSpecRecommendation({
      ...base,
      chatOutput: "no workflow section here",
      githubProvider: stubProvider([
        "## Recommended Workflow\n**Phases:** spec → testgen → exec → qa\n**Quality Loop:** enabled",
      ]),
    });
    expect(result).toEqual({
      phases: ["testgen", "exec", "qa"],
      qualityLoop: true,
      source: "comment-prose",
    });
  });

  it("falls through to chat text when comments have neither marker nor prose", () => {
    const result = resolveSpecRecommendation({
      ...base,
      chatOutput:
        "## Recommended Workflow\n**Phases:** spec → exec → qa\n**Quality Loop:** disabled",
      githubProvider: stubProvider(["no plan comment posted"]),
    });
    expect(result).toEqual({
      phases: ["exec", "qa"],
      qualityLoop: false,
      source: "chat",
    });
  });

  it("falls through to label-based detection as the last resort", () => {
    const result = resolveSpecRecommendation({
      ...base,
      labels: ["ui"],
      chatOutput: "nothing parseable",
      githubProvider: stubProvider(["nothing parseable either"]),
    });
    expect(result.source).toBe("label-fallback");
    expect(result.phases).toEqual(["exec", "test", "qa"]);
  });

  it("falls through past an invalid marker to comment prose (AC-2)", () => {
    const result = resolveSpecRecommendation({
      ...base,
      githubProvider: stubProvider([
        '<!-- SEQUANT_SPEC: {"phases":["not-a-real-phase"]} -->\n\n## Recommended Workflow\n**Phases:** testgen → exec → qa\n**Quality Loop:** enabled',
      ]),
    });
    expect(result).toEqual({
      phases: ["testgen", "exec", "qa"],
      qualityLoop: true,
      source: "comment-prose",
    });
  });
});

describe("resolveSpecRecommendation — #814 motivating fixture (AC-5)", () => {
  it("resolves testgen via the comment path when chat text has no workflow section", () => {
    const result = resolveSpecRecommendation({
      chatOutput: fixture.chatText,
      issueNumber: 814,
      labels: ["bug", "cli"],
      githubProvider: stubProvider([fixture.commentBody]),
    });

    expect(result.source).toBe("comment-prose");
    expect(result.phases).toContain("testgen");
    expect(result.phases).toEqual(["testgen", "exec", "qa"]);
  });
});

describe("resolveSpecRecommendation — legacy comments without a marker (AC-6)", () => {
  it("resolves via comment-prose for pre-#921 comments", () => {
    const legacyComment =
      "## Plan\n\nSome plan text.\n\n## Recommended Workflow\n**Phases:** spec → exec → qa\n**Quality Loop:** disabled\n**Reasoning:** simple bug fix";

    const result = resolveSpecRecommendation({
      chatOutput: "",
      issueNumber: 500,
      labels: ["bug"],
      githubProvider: stubProvider([legacyComment]),
    });

    expect(result).toEqual({
      phases: ["exec", "qa"],
      qualityLoop: false,
      source: "comment-prose",
    });
  });
});
