import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  buildReviewResidue,
  classifyTestSeam,
  countFixCommits,
  evidenceTargets,
  renderReadFirst,
  type ReviewResidueInput,
} from "./review-residue.js";
import { parseMutationMarkers } from "./mutation-marker.js";

// Test-file sources live in fixture files so the health scan, which reads
// every *.test.ts, does not count this file's fixtures as its own mocks.
const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "review-residue",
);
const source = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.test.ts.txt`), "utf-8");

// A diff touching five files. AC-1's evidence names two of them.
const NUMSTAT = [
  "40\t2\tsrc/lib/alpha.ts",
  "12\t0\tsrc/lib/alpha.test.ts",
  "8\t1\tsrc/lib/beta.ts",
  "3\t20\tsrc/lib/gamma.test.ts",
  "5\t5\tdocs/notes.md",
].join("\n");

const ISSUE_BODY = [
  "## Acceptance Criteria",
  "",
  "- [ ] AC-1: alpha works. Evidence: `npx vitest run src/lib/alpha.test.ts` → passes; `src/lib/alpha.ts` exports it",
  "- [ ] AC-2: it is documented. Evidence: a human reads the page and agrees",
].join("\n");

// `git log --since=28.days --format=%x00%s --name-only` with beta.ts in three
// fix commits and one feat commit; alpha.ts in two fix commits.
const FIX_LOG = [
  "\0fix(#1): one\n\nsrc/lib/beta.ts\nsrc/lib/alpha.ts\n",
  "\0fix: two\n\nsrc/lib/beta.ts\n",
  "\0fix(#3)!: three\n\nsrc/lib/beta.ts\nsrc/lib/alpha.ts\n",
  "\0feat(#4): not a fix\n\nsrc/lib/beta.ts\n",
].join("");

const MARKER_BODY =
  '<!-- SEQUANT_MUTATION: {"ac":"AC-1","mutation":"removed the export","failedTest":"src/lib/alpha.test.ts > alpha > exports it"} -->';

function fixture(
  overrides: Partial<ReviewResidueInput> = {},
): ReviewResidueInput {
  return {
    prNumber: 42,
    issueNumber: 7,
    base: "origin/main",
    commit: "abc1234",
    numstat: NUMSTAT,
    testFileSources: {
      "src/lib/alpha.test.ts": source("alpha"),
      "src/lib/gamma.test.ts": source("gamma"),
    },
    issueBody: ISSUE_BODY,
    fixLog: FIX_LOG,
    tautology: [],
    mutationMarkers: parseMutationMarkers(MARKER_BODY),
    ...overrides,
  };
}

function section(body: string, heading: string): string[] {
  const start = body.indexOf(`\n${heading}\n`);
  const rest = body.slice(start + heading.length + 2);
  const end = rest.search(/\n## /);
  return (end === -1 ? rest : rest.slice(0, end))
    .split("\n")
    .filter((l) => l.startsWith("- "));
}

describe("buildReviewResidue", () => {
  it("explains the 2 files AC-1's evidence names and leaves 3 as residue", () => {
    const partition = buildReviewResidue(fixture());
    expect(partition.explained.map((e) => e.path).sort()).toEqual([
      "src/lib/alpha.test.ts",
      "src/lib/alpha.ts",
    ]);
    expect(partition.explained.every((e) => e.acs.join() === "AC-1")).toBe(
      true,
    );
    const unexplained = partition.residue
      .filter((r) => r.text.includes("no AC's evidence names it"))
      .map((r) => r.text.match(/`([^`]+)`/)![1])
      .sort();
    expect(unexplained).toEqual([
      "docs/notes.md",
      "src/lib/beta.ts",
      "src/lib/gamma.test.ts",
    ]);
  });

  it("an AC whose evidence names no path explains nothing", () => {
    expect(evidenceTargets("a human reads the page and agrees")).toEqual([]);
    const body = ISSUE_BODY.replace(
      /AC-1: .*$/m,
      "AC-1: alpha. Evidence: it works",
    );
    const partition = buildReviewResidue(fixture({ issueBody: body }));
    expect(partition.explained).toEqual([]);
  });

  it("flags a hot file from the fixture git log (fix commits only)", () => {
    expect(countFixCommits(FIX_LOG).get("src/lib/beta.ts")).toBe(3);
    const hot = buildReviewResidue(fixture()).residue.filter((r) =>
      r.text.includes("is hot"),
    );
    expect(hot.map((r) => r.text)).toEqual([
      "`src/lib/beta.ts` is hot: 3 fix commits in 28 days",
    ]);
  });

  it("flags deleted test lines from --numstat", () => {
    const weakened = buildReviewResidue(fixture()).residue.filter((r) =>
      r.text.includes("test lines"),
    );
    expect(weakened).toHaveLength(1);
    expect(weakened[0].text).toContain("src/lib/gamma.test.ts");
    expect(weakened[0].command).toBe(
      "git diff --numstat origin/main...HEAD -- src/lib/gamma.test.ts",
    );
  });

  it("classes a child_process mock as mock and flags it as not owned", () => {
    const t = buildReviewResidue(fixture()).tests.find(
      (x) => x.path === "src/lib/alpha.test.ts",
    )!;
    expect(t.seam).toBe("mock");
    expect(t.foreignMocks).toEqual(["child_process"]);
    expect(classifyTestSeam('vi.mock("./local.js");').foreignMocks).toEqual([]);
  });

  it("classes a SKILL.md reader as prose", () => {
    const t = buildReviewResidue(fixture()).tests.find(
      (x) => x.path === "src/lib/gamma.test.ts",
    )!;
    expect(t.seam).toBe("prose");
    expect(classifyTestSeam('import { f } from "./f.js";').seam).toBe("real");
  });

  it("marks a test file that a mutation record names", () => {
    const tests = buildReviewResidue(fixture()).tests;
    expect(
      tests.find((t) => t.path === "src/lib/alpha.test.ts")!.mutationAc,
    ).toBe("AC-1");
    expect(
      tests.find((t) => t.path === "src/lib/gamma.test.ts")!.mutationAc,
    ).toBeUndefined();
  });

  it("flags tautology hits and a diff over the size budget", () => {
    const partition = buildReviewResidue(
      fixture({
        numstat: `${NUMSTAT}\n500\t0\tsrc/lib/big.ts`,
        tautology: [
          {
            filePath: "src/lib/alpha.test.ts",
            totalTests: 4,
            tautologicalCount: 1,
          },
        ],
      }),
    );
    const texts = partition.residue.map((r) => r.text);
    expect(texts).toContain(
      "`src/lib/alpha.test.ts`: 1 of 4 tests call no production code",
    );
    expect(texts.some((t) => t.includes("over the 400-line budget"))).toBe(
      true,
    );
  });
});

describe("renderReadFirst", () => {
  it("every residue and test line carries its command", () => {
    const body = renderReadFirst(
      fixture({
        tautology: [
          {
            filePath: "src/lib/alpha.test.ts",
            totalTests: 4,
            tautologicalCount: 1,
          },
        ],
      }),
    );
    const lines = [
      ...section(body, "## Residue"),
      ...section(body, "## Tests"),
    ];
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) {
      // The command follows the em dash, in backticks.
      expect(line).toMatch(/ — `[^`]+`/);
    }
  });

  it("an empty residue still names its command", () => {
    const body = renderReadFirst(
      fixture({
        numstat: "1\t0\tsrc/lib/alpha.ts",
        fixLog: "",
        issueBody: "- [ ] AC-1: a. Evidence: `src/lib/alpha.ts` exports it",
      }),
    );
    expect(section(body, "## Residue")).toEqual([
      "- none — `git diff --numstat origin/main...HEAD`",
    ]);
  });

  it("starts with the heading and orders Residue, Tests, Explained", () => {
    const body = renderReadFirst(fixture());
    expect(body.startsWith("## Read first\n")).toBe(true);
    const order = [
      "## Residue",
      "## Tests",
      "## Explained",
      "SEQUANT_QA_VERDICT",
    ].map((h) => body.indexOf(h));
    expect(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1]))).toBe(
      true,
    );
    expect(body).toContain(
      '<!-- SEQUANT_READ_FIRST: {"pr":42,"commit":"abc1234"} -->',
    );
  });
});
