import { describe, it, expect, vi } from "vitest";

import { FakeGitHubProvider } from "../../src/lib/workflow/platforms/fake-github.js";
import {
  deriveGhFixture,
  loadGhFixture,
} from "../../src/lib/workflow/platforms/gh-fixtures.js";
import type { MergedPRWithComments } from "../../src/lib/workflow/platforms/github.js";
import { main, measureOutcomes, residueIsEmpty } from "./residue-outcomes.js";

const READ_FIRST_FULL =
  "## Read first\n\n## Residue\n\n- `a.ts` (+1 −0): no AC's evidence names it — `git diff --numstat origin/main...HEAD -- a.ts`\n\n## Tests\n";
const READ_FIRST_EMPTY =
  "## Read first\n\n## Residue\n\n- none — `git diff --numstat origin/main...HEAD`\n\n## Tests\n";

const comment = (body: string, createdAt: string, login = "admarble") => ({
  author: { login },
  body,
  createdAt,
});

const PRS: MergedPRWithComments[] = [
  {
    number: 1,
    mergedAt: "2026-10-26T00:00:00Z",
    comments: [
      comment(READ_FIRST_FULL, "2026-10-25T00:00:00Z"),
      comment("looked at a.ts", "2026-10-25T01:00:00Z"),
    ],
  },
  {
    number: 2,
    mergedAt: "2026-10-26T00:00:00Z",
    comments: [
      comment(READ_FIRST_FULL, "2026-10-25T00:00:00Z"),
      comment("ci", "2026-10-25T01:00:00Z", "dependabot[bot]"),
      comment("<!-- SEQUANT_PHASE: {} -->", "2026-10-25T02:00:00Z"),
      comment("after merge", "2026-10-27T00:00:00Z"),
    ],
  },
  {
    number: 3,
    mergedAt: "2026-10-26T00:00:00Z",
    comments: [comment(READ_FIRST_EMPTY, "2026-10-25T00:00:00Z")],
  },
  { number: 4, mergedAt: "2026-10-26T00:00:00Z", comments: [] },
];

describe("residue-outcomes", () => {
  it("splits PRs by residue and counts reviewer comments before merge", () => {
    expect(measureOutcomes(PRS, "2026-10-24")).toEqual({
      since: "2026-10-24",
      prsMerged: 4,
      withResidue: { total: 2, commentedBeforeMerge: 1 },
      emptyResidue: { total: 1, commentedBeforeMerge: 0 },
    });
    expect(residueIsEmpty(READ_FIRST_EMPTY)).toBe(true);
    expect(residueIsEmpty(READ_FIRST_FULL)).toBe(false);
  });

  it("--json prints the four counters, zero before any PR carries the comment", () => {
    const captured = loadGhFixture("pr-list-merged-with-comments");
    const fixture = deriveGhFixture(captured, {
      args: captured.args.map((a) => (a === "2" ? "1000" : a)),
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = main(
      ["--since", "2026-10-20", "--json"],
      new FakeGitHubProvider(fixture),
    );
    const report = JSON.parse(log.mock.calls[0][0] as string);
    log.mockRestore();
    expect(code).toBe(0);
    expect(report.prsMerged).toBe(2);
    expect(report.withResidue).toEqual({ total: 0, commentedBeforeMerge: 0 });
    expect(report.emptyResidue).toEqual({ total: 0, commentedBeforeMerge: 0 });
  });
});
