/**
 * Tests for #975 AC-4: enrichPhasePoliciesFromResults populates resolvedModel
 * from driver modelUsage into the phasePolicies passed to recordRun.
 *
 * These tests are mutation-verifiable: deleting or no-op'ing the enrichment
 * logic in enrichPhasePoliciesFromResults causes every assertion on
 * `resolvedModel` below to fail.
 */

import { describe, it, expect } from "vitest";
import { enrichPhasePoliciesFromResults } from "./run-orchestrator.js";
import type { IssueResult } from "./types.js";

function makeIssueResult(
  phaseResults: Array<{ phase: string; resolvedModel?: string }>,
): IssueResult {
  return {
    issueNumber: 975,
    success: true,
    phaseResults: phaseResults.map((pr) => ({
      phase: pr.phase as "exec" | "spec" | "qa",
      success: true,
      resolvedModel: pr.resolvedModel,
    })),
  } as IssueResult;
}

describe("#975 AC-4: enrichPhasePoliciesFromResults", () => {
  it("merges resolvedModel from phase results into phasePolicies", () => {
    const phasePolicies = {
      exec: { model: "sonnet", requestedModel: "role:fast" },
    };
    const results = [
      makeIssueResult([{ phase: "exec", resolvedModel: "claude-sonnet-5" }]),
    ];

    const enriched = enrichPhasePoliciesFromResults(phasePolicies, results);

    expect(enriched?.exec?.resolvedModel).toBe("claude-sonnet-5");
  });

  it("preserves requestedModel and model alongside resolvedModel", () => {
    const phasePolicies = {
      exec: { model: "sonnet", requestedModel: "role:fast" },
    };
    const results = [
      makeIssueResult([{ phase: "exec", resolvedModel: "claude-sonnet-5" }]),
    ];

    const enriched = enrichPhasePoliciesFromResults(phasePolicies, results);

    expect(enriched?.exec?.model).toBe("sonnet");
    expect(enriched?.exec?.requestedModel).toBe("role:fast");
    expect(enriched?.exec?.resolvedModel).toBe("claude-sonnet-5");
  });

  it("handles multiple phases independently", () => {
    const phasePolicies = {
      spec: { model: "haiku" },
      exec: { model: "sonnet", requestedModel: "role:fast" },
      qa: { model: "opus", requestedModel: "role:strong" },
    };
    const results = [
      makeIssueResult([
        { phase: "spec", resolvedModel: "claude-haiku-4-5-20251001" },
        { phase: "exec", resolvedModel: "claude-sonnet-5" },
        { phase: "qa", resolvedModel: "claude-opus-4-8" },
      ]),
    ];

    const enriched = enrichPhasePoliciesFromResults(phasePolicies, results);

    expect(enriched?.spec?.resolvedModel).toBe("claude-haiku-4-5-20251001");
    expect(enriched?.exec?.resolvedModel).toBe("claude-sonnet-5");
    expect(enriched?.qa?.resolvedModel).toBe("claude-opus-4-8");
  });

  it("returns phasePolicies unchanged when no phase results have resolvedModel", () => {
    const phasePolicies = { exec: { model: "sonnet" } };
    const results = [makeIssueResult([{ phase: "exec" }])]; // no resolvedModel

    const enriched = enrichPhasePoliciesFromResults(phasePolicies, results);

    expect(enriched).toBe(phasePolicies); // same reference — no allocation
    expect(enriched?.exec?.resolvedModel).toBeUndefined();
  });

  it("returns undefined when phasePolicies is undefined and no resolvedModels", () => {
    const results = [makeIssueResult([{ phase: "exec" }])];

    const enriched = enrichPhasePoliciesFromResults(undefined, results);

    expect(enriched).toBeUndefined();
  });

  it("creates phase entry when resolvedModel exists but phase not in phasePolicies", () => {
    // Phase ran with default model (no configured policy), driver reported modelUsage
    const results = [
      makeIssueResult([{ phase: "exec", resolvedModel: "claude-sonnet-5" }]),
    ];

    const enriched = enrichPhasePoliciesFromResults(undefined, results);

    expect(enriched?.exec?.resolvedModel).toBe("claude-sonnet-5");
  });

  it("last execution's resolvedModel wins when a phase ran multiple times", () => {
    const phasePolicies = { exec: { model: "sonnet" } };
    const results = [
      makeIssueResult([
        { phase: "exec", resolvedModel: "claude-sonnet-4" }, // first run
        { phase: "exec", resolvedModel: "claude-sonnet-5" }, // quality-loop retry
      ]),
    ];

    const enriched = enrichPhasePoliciesFromResults(phasePolicies, results);

    expect(enriched?.exec?.resolvedModel).toBe("claude-sonnet-5");
  });

  it("aggregates across multiple IssueResults", () => {
    const phasePolicies = { exec: { model: "sonnet" } };
    const results = [
      makeIssueResult([{ phase: "exec", resolvedModel: "claude-sonnet-5" }]),
      makeIssueResult([{ phase: "exec", resolvedModel: "claude-sonnet-5" }]),
    ];

    const enriched = enrichPhasePoliciesFromResults(phasePolicies, results);

    expect(enriched?.exec?.resolvedModel).toBe("claude-sonnet-5");
  });
});
