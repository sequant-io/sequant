/**
 * Schema validation tests for #823 (AC-2, AC-35).
 *
 * The assertions check that the error *names the offending field*, not merely
 * that validation failed. The payload is hand-built by a model into a temp file;
 * "invalid input" without a field path is not an actionable error.
 */

import { describe, expect, it } from "vitest";

import { AssessResultValidationError, parseAssessResult } from "./types.js";

const validBatch = {
  mode: "batch",
  commandPrefix: "npx sequant",
  issues: [
    {
      number: 823,
      action: "PROCEED",
      reason: "Render via CLI subcommand",
      run: "spec → exec → qa",
      phases: ["spec", "exec", "qa"],
      qualityLoop: true,
    },
  ],
  commands: [{ args: "run 823 -Q" }],
};

const validSingle = {
  mode: "single",
  commandPrefix: "sequant",
  issues: [
    {
      number: 823,
      action: "PROCEED",
      reason: "Render via CLI subcommand",
      title: "fix(assess): render via CLI subcommand",
      state: "Open",
      labels: ["bug", "cli", "complex"],
    },
  ],
};

/** Run `parseAssessResult` and return the problems it reported. */
function problemsFor(payload: unknown): string[] {
  try {
    parseAssessResult(payload);
  } catch (error) {
    if (error instanceof AssessResultValidationError) return error.problems;
    throw error;
  }
  throw new Error("expected validation to fail");
}

describe("parseAssessResult — valid payloads", () => {
  it("accepts a batch payload and returns it typed", () => {
    const result = parseAssessResult(validBatch);
    expect(result.mode).toBe("batch");
    expect(result.issues[0].action).toBe("PROCEED");
    expect(result.commandPrefix).toBe("npx sequant");
  });

  it("accepts a single payload", () => {
    expect(parseAssessResult(validSingle).issues[0].title).toContain("assess");
  });
});

describe("parseAssessResult — missing required fields", () => {
  it("names a missing top-level field", () => {
    const { issues, ...withoutIssues } = validBatch;
    void issues;
    expect(problemsFor(withoutIssues).join("\n")).toContain("issues");
  });

  it("names a missing per-issue field with its index", () => {
    const broken = {
      ...validBatch,
      issues: [{ number: 823, run: "spec → exec → qa" }],
    };
    const problems = problemsFor(broken).join("\n");
    expect(problems).toContain("issues[0].action");
    expect(problems).toContain("issues[0].reason");
  });

  it("requires a Run value in batch mode", () => {
    const broken = {
      ...validBatch,
      issues: [{ ...validBatch.issues[0], run: undefined }],
    };
    expect(problemsFor(broken).join("\n")).toContain("issues[0].run");
  });

  it("requires title and state in single mode", () => {
    const broken = {
      ...validSingle,
      issues: [
        {
          number: 823,
          action: "PROCEED",
          reason: "r",
        },
      ],
    };
    const problems = problemsFor(broken).join("\n");
    expect(problems).toContain("issues[0].title");
    expect(problems).toContain("issues[0].state");
  });
});

describe("parseAssessResult — malformed values", () => {
  it("names a malformed action and lists the valid vocabulary", () => {
    const broken = {
      ...validBatch,
      issues: [{ ...validBatch.issues[0], action: "FROBNICATE" }],
    };
    const problems = problemsFor(broken).join("\n");
    expect(problems).toContain("issues[0].action");
    expect(problems).toContain("PROCEED");
  });

  it("names an unknown key rather than silently dropping it", () => {
    const broken = {
      ...validBatch,
      issues: [{ ...validBatch.issues[0], reasonn: "typo" }],
    };
    expect(problemsFor(broken).join("\n")).toContain("reasonn");
  });

  it("rejects a non-integer issue number", () => {
    const broken = {
      ...validBatch,
      issues: [{ ...validBatch.issues[0], number: "823" }],
    };
    expect(problemsFor(broken).join("\n")).toContain("issues[0].number");
  });
});

describe("parseAssessResult — verdict-specific requirements", () => {
  it("requires a merge target for MERGE", () => {
    const broken = {
      ...validSingle,
      issues: [{ ...validSingle.issues[0], action: "MERGE" }],
    };
    expect(problemsFor(broken).join("\n")).toContain("mergeTarget");
  });

  it("requires a resume condition for PARK", () => {
    const broken = {
      ...validSingle,
      issues: [{ ...validSingle.issues[0], action: "PARK" }],
    };
    expect(problemsFor(broken).join("\n")).toContain("resumeAfter");
  });

  it("requires the needed information for CLARIFY", () => {
    const broken = {
      ...validSingle,
      issues: [{ ...validSingle.issues[0], action: "CLARIFY" }],
    };
    expect(problemsFor(broken).join("\n")).toContain("need");
  });

  it("rejects more than one issue in single mode", () => {
    const broken = {
      ...validSingle,
      issues: [validSingle.issues[0], validSingle.issues[0]],
    };
    expect(problemsFor(broken).join("\n")).toContain("single mode renders");
  });
});
