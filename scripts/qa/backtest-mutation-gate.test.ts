import { describe, it, expect } from "vitest";
import { extractAcTableRows, backtest } from "./backtest-mutation-gate.js";

describe("extractAcTableRows", () => {
  it("extracts AC/evidence pairs from a Pre-PR AC Verification table", () => {
    const body = `## Summary
Some text.

## Pre-PR AC Verification

| AC | Description | Status | Evidence |
|----|-------------|--------|----------|
| AC-1 | Does a thing | ✅ Implemented | \`npm test -- foo\` |
| AC-2 | Fixture exists and section is present | ✅ Implemented | skill gate test, mutation-verified |

## Next Steps
More text.
`;
    expect(extractAcTableRows(body)).toEqual([
      { ac: "AC-1", evidence: "`npm test -- foo`" },
      {
        ac: "AC-2",
        evidence: "skill gate test, mutation-verified",
      },
    ]);
  });

  it("returns an empty array when no Pre-PR AC Verification table exists", () => {
    expect(extractAcTableRows("## Summary\nJust prose.\n")).toEqual([]);
  });

  it("returns an empty array when the table has no Evidence column", () => {
    const body = `## Pre-PR AC Verification

| AC | Description | Status |
|----|-------------|--------|
| AC-1 | Does a thing | ✅ Implemented |
`;
    expect(extractAcTableRows(body)).toEqual([{ ac: "AC-1", evidence: "" }]);
  });
});

describe("backtest", () => {
  it("counts in-scope gate-test ACs as Missing when no SEQUANT_MUTATION marker is present", () => {
    const prs = [
      {
        number: 1,
        title: "t",
        body: `## Pre-PR AC Verification

| AC | Description | Status | Evidence |
|----|-------------|--------|----------|
| AC-1 | Fixture check | ✅ Implemented | skill gate test scoped, mutation-verified |
| AC-2 | Behavior | ✅ Implemented | \`npm test -- foo\` |
`,
      },
    ];
    const result = backtest(prs);
    expect(result.prsWithAcTable).toBe(1);
    expect(result.totalAcRows).toBe(2);
    expect(result.inScopeAcCount).toBe(1);
    expect(result.missingCount).toBe(1);
  });

  it("counts an in-scope AC as not-missing when a matching SEQUANT_MUTATION marker is present", () => {
    const prs = [
      {
        number: 2,
        title: "t",
        body: `## Pre-PR AC Verification

| AC | Description | Status | Evidence |
|----|-------------|--------|----------|
| AC-1 | Fixture check | ✅ Implemented | skill gate test scoped, mutation-verified |

<!-- SEQUANT_MUTATION: {"ac":"AC-1","mutation":"deleted fixture","failedTest":"a.test.ts > t"} -->
`,
      },
    ];
    const result = backtest(prs);
    expect(result.inScopeAcCount).toBe(1);
    expect(result.missingCount).toBe(0);
  });

  it("skips PRs with no Pre-PR AC Verification table", () => {
    const prs = [{ number: 3, title: "t", body: "## Summary\nProse only.\n" }];
    const result = backtest(prs);
    expect(result.prsWithAcTable).toBe(0);
    expect(result.inScopeAcCount).toBe(0);
    expect(result.missingCount).toBe(0);
  });
});
