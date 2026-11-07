/**
 * #1524: per-AC status parse coverage. Offline: the fixture only, no `gh`.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import {
  AC_STATUSES,
  fixtureDir,
  loadFixture,
  measureCorpus,
  parseAcStatuses,
  scoreFixture,
  selectQaComments,
} from "./ac-status-parse-coverage.js";

const MARKER = '<!-- SEQUANT_PHASE: {"phase":"qa","status":"completed"} -->';

describe("qa-comments fixture (AC-1)", () => {
  it("has >= 10 verbatim comments and >= 40 hand-labelled ACs, each status in the enum", () => {
    const { expected } = loadFixture();
    const files = fs
      .readdirSync(fixtureDir())
      .filter((f) => f.endsWith(".md"))
      .sort();
    expect(files.length).toBeGreaterThanOrEqual(10);
    const labelled = Object.values(expected).flatMap((e) => e.acs);
    expect(labelled.length).toBeGreaterThanOrEqual(40);
    for (const ac of labelled) expect(AC_STATUSES).toContain(ac.status);
  });

  it("pairs every fixture file with an expected.json entry, and back", () => {
    const { expected, readBody } = loadFixture();
    const files = fs
      .readdirSync(fixtureDir())
      .filter((f) => f.endsWith(".md"))
      .sort();
    expect(Object.keys(expected).sort()).toEqual(files);
    for (const [file, entry] of Object.entries(expected)) {
      expect(file).toBe(`${entry.issue}-${entry.commentId}.md`);
      expect(readBody(file)).toContain('SEQUANT_PHASE: {"phase":"qa"');
    }
  });
});

describe("scoreFixture precision (AC-3)", () => {
  it("counts the real stray MET in 1265's 'MET (locally) / PENDING (CI)' rows as false positives", () => {
    const { expected, readBody } = loadFixture();
    const score = scoreFixture(expected, readBody);
    const fps = score.misses
      .filter((m) => m.kind === "fp")
      .map((m) => `${m.fixture} ${m.id}`);
    expect(fps).toContain("1265-5933933577.md AC-2");
    expect(fps).toContain("1265-5933933577.md AC-7");
    expect(score.precision).toBeLessThan(1);
    expect(score.recall).toBeGreaterThan(0);
  });

  it("scores a parse that differs from the label as FP and an unknown parse as FN", () => {
    const body = "| AC | Status |\n|---|---|\n| AC-1 | MET |\n| AC-2 | MET |\n";
    const score = scoreFixture(
      {
        "x.md": {
          issue: 1,
          commentId: 2,
          acs: [
            { id: "AC-1", status: "met" },
            { id: "AC-2", status: "pending" },
            { id: "AC-3", status: "not_met" },
          ],
        },
      },
      () => body,
    );
    expect([score.tp, score.fp, score.fn]).toEqual([1, 1, 1]);
    expect(score.precision).toBe(0.5);
    expect(score.recall).toBe(0.5);
  });
});

describe("parseAcStatuses", () => {
  it("reads table rows and list items that lead with the AC id", () => {
    const body = [
      "| AC-1 | Original | thing | MET | ok |",
      "| AC-2 | Original | thing | **NOT_MET** | no |",
      "- **AC-3/AC-4:** wired. ✅",
      "| AC-5 | ⚠️ PENDING | later |",
      "| AC-6 | PARTIALLY_MET | half |",
    ].join("\n");
    const got = parseAcStatuses(body, [
      "AC-1",
      "AC-2",
      "AC-3",
      "AC-4",
      "AC-5",
      "AC-6",
    ]);
    expect(Object.fromEntries(got)).toEqual({
      "AC-1": "met",
      "AC-2": "not_met",
      "AC-3": "met",
      "AC-4": "met",
      "AC-5": "pending",
      "AC-6": "not_met",
    });
  });

  it("ignores free prose, ids not in the lead cell, verdict names, code fences and HTML comments", () => {
    const body = [
      "All 2 ACs are MET; AC-1 is MET.",
      "| file.ts | Standard | ✅ Yes | AC-2 |",
      "| AC-1 | caps at `AC_MET_BUT_NOT_A_PLUS`, floors to `AC_NOT_MET` | Verified |",
      "```",
      "| AC-2 | MET |",
      "```",
      "<!-- | AC-2 | MET | -->",
    ].join("\n");
    const got = parseAcStatuses(body, ["AC-1", "AC-2"]);
    expect(Object.fromEntries(got)).toEqual({
      "AC-1": "unknown",
      "AC-2": "unknown",
    });
  });

  it("keeps the first classified row for an id", () => {
    const body = "| AC-1 | NOT_MET |\n\n| AC-1 | MET |";
    expect(parseAcStatuses(body, ["AC-1"]).get("AC-1")).toBe("not_met");
  });
});

describe("selectQaComments", () => {
  it("keeps marked comments created on or after since, and reads the marker status", () => {
    const got = selectQaComments(
      [
        {
          id: 1,
          created_at: "2026-08-02T00:00:00Z",
          issue_url: "https://api.github.com/repos/o/r/issues/7",
          body: `x\n${MARKER}`,
        },
        {
          id: 2,
          created_at: "2026-07-31T23:59:59Z",
          issue_url: "https://api.github.com/repos/o/r/issues/7",
          body: MARKER,
        },
        {
          id: 3,
          created_at: "2026-08-03T00:00:00Z",
          issue_url: "https://api.github.com/repos/o/r/issues/8",
          body: 'quotes `SEQUANT_PHASE: {"phase":"qa"` in prose',
        },
      ],
      "2026-08-01",
    );
    expect(got.map((c) => [c.id, c.issue, c.status])).toEqual([
      [1, 7, "completed"],
    ]);
  });
});

describe("measureCorpus", () => {
  it("uses the issue-body AC ids as the denominator", () => {
    const report = measureCorpus(
      [
        {
          id: 1,
          createdAt: "2026-08-02",
          issue: 7,
          status: "completed",
          body: "| AC-1 | MET |",
        },
        {
          id: 2,
          createdAt: "2026-08-02",
          issue: 8,
          status: "failed",
          body: "| AC-9 | MET |",
        },
      ],
      (issue) => (issue === 7 ? ["AC-1", "AC-2"] : []),
      "2026-08-01",
    );
    expect(report.comments).toBe(2);
    expect(report.acs).toBe(2);
    expect(report.classified).toBe(1);
    expect(report.coverage).toBe(0.5);
    expect(report.commentsWithoutIssueAcs).toBe(1);
    expect(report.byStatus.failed.acs).toBe(0);
  });
});
