/**
 * QA Precheck — unit + integration tests.
 *
 * Coverage:
 *   - extractFixtures: fenced / blockquote / prefix shapes; Setup gating; empty body
 *   - extractACIDs + diffACIDs: literal-id diff (no text-comparison rationalization)
 *   - extractIdentifiersFromDiff: TS declaration shapes; test-file exclusion
 *   - runPrecheck (integration): injected sources flow through to a well-formed JSON
 *   - CLI: --help, --out, real issue body via fixtures
 *
 * Fixture inputs are taken from real-shape inputs (issue #609 body, PR #547
 * verbatim-fixture regression) — NOT synthetic chimeras, per
 * feedback_synthetic_test_fixture_trap.md.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import {
  extractFixtures,
  extractACIDs,
  diffACIDs,
  extractIdentifiersFromDiff,
  runPrecheck,
  parseArgs,
} from "./precheck.js";

const CLI_PATH = path.resolve(__dirname, "precheck.ts");

// ---------------------------------------------------------------------------
// extractFixtures
// ---------------------------------------------------------------------------

describe("extractFixtures", () => {
  it("extracts a fenced code block as a fixture", () => {
    const body = [
      "## Problem",
      "Some prose.",
      "",
      "```",
      "the verbatim example",
      "spans multiple lines",
      "```",
      "",
      "More prose.",
    ].join("\n");
    const out = extractFixtures(body);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("fenced");
    expect(out[0].content).toBe("the verbatim example\nspans multiple lines");
    expect(out[0].line).toBe(5); // first content line, 1-based
  });

  it("excludes fenced blocks under Setup / Install / Prerequisites headings", () => {
    const body = [
      "## Setup",
      "```",
      "npm install",
      "```",
      "",
      "## Reproduction",
      "```",
      "the actual bug input",
      "```",
    ].join("\n");
    const out = extractFixtures(body);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("the actual bug input");
  });

  it("extracts blockquote lines (single and multi)", () => {
    const body = [
      "> first blockquote",
      "> second blockquote",
      "non-quote line",
      "> third blockquote",
    ].join("\n");
    const out = extractFixtures(body);
    const quotes = out.filter((f) => f.kind === "blockquote");
    expect(quotes.map((q) => q.content)).toEqual([
      "first blockquote",
      "second blockquote",
      "third blockquote",
    ]);
  });

  it("extracts **Verify:** / **Verbatim:** / **Example:** / **Repro:** prefixed lines", () => {
    const body = [
      "**Verify:** flag X is set",
      "**Verbatim:** the exact text",
      "**Example:** the example",
      "**Repro:** steps to reproduce",
      "**AC verification:** literal AC text",
      "**Random:** should NOT match",
    ].join("\n");
    const out = extractFixtures(body);
    const prefixes = out.filter((f) => f.kind === "prefix");
    expect(prefixes.map((p) => p.label).sort()).toEqual([
      "AC verification",
      "Example",
      "Repro",
      "Verbatim",
      "Verify",
    ]);
    expect(prefixes.find((p) => p.label === "Verify")?.content).toBe(
      "flag X is set",
    );
  });

  it("returns empty array when issue body has no payload", () => {
    const body = "## Problem\n\nJust prose, no fixtures.\n\nMore prose.";
    expect(extractFixtures(body)).toEqual([]);
  });

  it("does not extract empty fenced blocks", () => {
    const body = ["```", "```", "real prose"].join("\n");
    expect(extractFixtures(body)).toEqual([]);
  });

  it("handles unclosed fences without crashing", () => {
    const body = ["```", "stuck open"].join("\n");
    // Without a closing fence we deliberately do NOT emit the fixture; the
    // alternative would be to silently emit half-parsed content which is
    // worse than missing it.
    expect(() => extractFixtures(body)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// extractACIDs + diffACIDs
// ---------------------------------------------------------------------------

describe("extractACIDs", () => {
  it("extracts AC-N ids in numeric order and dedupes", () => {
    const text =
      "- [ ] **AC-2** foo\n- [ ] **AC-10** bar\n- [ ] AC-2 dup\n- [ ] AC-1";
    expect(extractACIDs(text)).toEqual(["AC-1", "AC-2", "AC-10"]);
  });

  it("returns empty array when no AC ids present", () => {
    expect(extractACIDs("prose with no acceptance criteria")).toEqual([]);
  });

  it("matches inside table cells, checkboxes, and bold formatting", () => {
    const text =
      "| AC | Description |\n| AC-3 | row |\n- [x] **AC-1**\n`AC-2` inline";
    expect(extractACIDs(text)).toEqual(["AC-1", "AC-2", "AC-3"]);
  });
});

describe("diffACIDs", () => {
  it("reports IDs present in issue but missing from PR body", () => {
    const issue = "- [ ] AC-1\n- [ ] AC-2\n- [ ] AC-3\n- [ ] AC-4";
    const pr = "Implements AC-1 and AC-2.";
    const d = diffACIDs(issue, pr);
    expect(d.issueACs).toEqual(["AC-1", "AC-2", "AC-3", "AC-4"]);
    expect(d.prACs).toEqual(["AC-1", "AC-2"]);
    expect(d.missingInPR).toEqual(["AC-3", "AC-4"]);
  });

  it("returns empty missing list when PR covers all ACs", () => {
    const issue = "- [ ] AC-1\n- [ ] AC-2";
    const pr = "## Summary\nAddresses AC-1 and AC-2.";
    expect(diffACIDs(issue, pr).missingInPR).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractIdentifiersFromDiff
// ---------------------------------------------------------------------------

describe("extractIdentifiersFromDiff", () => {
  it("extracts function / const / class / interface / type from a TS diff", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -0,0 +1,8 @@",
      "+export function alpha() {}",
      "+async function beta() {}",
      "+export const gamma = 1;",
      "+let delta = 2;",
      "+export class Epsilon {}",
      "+interface Zeta { x: number }",
      "+export type Eta = string;",
      "+const inner = () => alpha();",
    ].join("\n");
    const ids = extractIdentifiersFromDiff(diff)
      .map((i) => i.name)
      .sort();
    expect(ids).toEqual([
      "Epsilon",
      "Eta",
      "Zeta",
      "alpha",
      "beta",
      "delta",
      "gamma",
      "inner",
    ]);
  });

  it("excludes identifiers from test files", () => {
    const diff = [
      "diff --git a/src/foo.test.ts b/src/foo.test.ts",
      "--- a/src/foo.test.ts",
      "+++ b/src/foo.test.ts",
      "@@ -0,0 +1,1 @@",
      "+export function shouldBeExcluded() {}",
    ].join("\n");
    expect(extractIdentifiersFromDiff(diff)).toEqual([]);
  });

  it("excludes identifiers from skill markdown / non-source files", () => {
    const diff = [
      "diff --git a/.claude/skills/qa/SKILL.md b/.claude/skills/qa/SKILL.md",
      "--- a/.claude/skills/qa/SKILL.md",
      "+++ b/.claude/skills/qa/SKILL.md",
      "@@ -0,0 +1,1 @@",
      "+export function looksLikeDeclButIsProse() {}",
    ].join("\n");
    expect(extractIdentifiersFromDiff(diff)).toEqual([]);
  });

  it("dedupes identifiers per file", () => {
    const diff = [
      "+++ b/src/foo.ts",
      "+export function alpha() {}",
      "+export function alpha() {}",
    ].join("\n");
    expect(extractIdentifiersFromDiff(diff)).toEqual([
      { name: "alpha", file: "src/foo.ts" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// runPrecheck (integration with injected sources)
// ---------------------------------------------------------------------------

describe("runPrecheck (injected sources)", () => {
  it("produces a well-formed PrecheckResult with all three checks populated", () => {
    const issueBody = [
      "## Problem",
      "- [ ] **AC-1** description",
      "- [ ] **AC-2** description",
      "",
      "**Verify:** the fix matches the spec",
      "",
      "```",
      "verbatim repro",
      "```",
    ].join("\n");
    // PR body mentions AC-1 literally but omits AC-2 — the literal-id diff
    // is a tripwire for "PR forgot to list an AC". Judgment about whether
    // a missing AC is genuinely deferred is the QA agent's call.
    const prBody = "Implements AC-1.";
    const diff = [
      "+++ b/src/feature.ts",
      "+export function newHelper() {}",
    ].join("\n");

    const result = runPrecheck({
      issue: 609,
      pr: 999,
      issueBody,
      prBody,
      diff,
      searchRoots: [], // disables git grep in test env
    });

    expect(result.schemaVersion).toBe(1);
    expect(result.issue).toBe(609);
    expect(result.pr).toBe(999);
    expect(result.checks.fixtures.status).toBe("pass");
    expect(result.checks.fixtures.count).toBeGreaterThanOrEqual(2);
    expect(result.checks.acLiteralDiff.status).toBe("fail");
    expect(result.checks.acLiteralDiff.missingInPR).toEqual(["AC-2"]);
    expect(result.checks.siblingGrep.status).toBe("pass");
    expect(result.checks.siblingGrep.identifiers[0].name).toBe("newHelper");
  });

  it("marks fixtures not_applicable when body has no payload", () => {
    const result = runPrecheck({
      issue: 1,
      pr: null,
      issueBody: "## Problem\n\nplain prose only",
      prBody: null,
      diff: "",
      searchRoots: [],
    });
    expect(result.checks.fixtures.status).toBe("not_applicable");
    expect(result.checks.fixtures.count).toBe(0);
  });

  it("marks siblingGrep not_applicable when only docs/skill files changed", () => {
    const diff = [
      "+++ b/docs/investigations/foo.md",
      "+# New investigation",
      "+++ b/.claude/skills/qa/SKILL.md",
      "+some new prose",
    ].join("\n");
    const result = runPrecheck({
      issue: 1,
      pr: null,
      issueBody: "## Problem\n\nprose",
      prBody: null,
      diff,
      searchRoots: [],
    });
    expect(result.checks.siblingGrep.status).toBe("not_applicable");
  });

  it("marks acLiteralDiff not_applicable when PR body is null", () => {
    const result = runPrecheck({
      issue: 1,
      pr: null,
      issueBody: "- [ ] AC-1",
      prBody: null,
      diff: "",
      searchRoots: [],
    });
    expect(result.checks.acLiteralDiff.status).toBe("not_applicable");
    expect(result.checks.acLiteralDiff.issueACs).toEqual(["AC-1"]);
  });

  it("acLiteralDiff passes when PR body covers all issue ACs", () => {
    const result = runPrecheck({
      issue: 1,
      pr: 2,
      issueBody: "- [ ] AC-1\n- [ ] AC-2",
      prBody: "Implements AC-1 and AC-2.",
      diff: "",
      searchRoots: [],
    });
    expect(result.checks.acLiteralDiff.status).toBe("pass");
    expect(result.checks.acLiteralDiff.missingInPR).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses --issue, --pr, --out", () => {
    const args = parseArgs([
      "--issue",
      "609",
      "--pr",
      "999",
      "--out",
      "x.json",
    ]);
    expect(args.issue).toBe(609);
    expect(args.pr).toBe(999);
    expect(args.out).toBe("x.json");
    expect(args.help).toBe(false);
  });

  it("defaults --out to .sequant/gap-precheck.json", () => {
    const args = parseArgs(["--issue", "1"]);
    expect(args.out).toBe(".sequant/gap-precheck.json");
  });

  it("handles --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("treats malformed numbers as null", () => {
    expect(parseArgs(["--issue", "notanumber"]).issue).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CLI integration — actually shell out to verify wiring works
// ---------------------------------------------------------------------------

describe("precheck CLI (integration)", () => {
  it("--help prints usage and exits 0", () => {
    const out = execSync(`npx tsx ${CLI_PATH} --help`, {
      encoding: "utf-8",
      cwd: path.resolve(__dirname, "../.."),
      timeout: 30000,
    });
    expect(out).toContain("QA Precheck");
    expect(out).toContain("--issue");
    expect(out).toContain("--out");
  });

  it("--out writes a JSON file with the expected schema", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "precheck-"));
    const outPath = path.join(tmpDir, "precheck.json");
    try {
      execSync(`npx tsx ${CLI_PATH} --out ${outPath}`, {
        encoding: "utf-8",
        cwd: path.resolve(__dirname, "../.."),
        timeout: 60000,
        // No --issue: precheck runs with null issue, gh fetch returns null,
        // and we still write a fail/not_applicable result.
      });
      const body = JSON.parse(fs.readFileSync(outPath, "utf-8"));
      expect(body.schemaVersion).toBe(1);
      expect(body.checks).toHaveProperty("fixtures");
      expect(body.checks).toHaveProperty("siblingGrep");
      expect(body.checks).toHaveProperty("acLiteralDiff");
      expect(typeof body.generatedAt).toBe("string");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
