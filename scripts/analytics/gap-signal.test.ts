/**
 * Unit tests for gap-signal.ts mining and classification.
 * Uses injected fetchers — no live `gh` calls.
 */

import { describe, it, expect, vi } from "vitest";
import {
  mine,
  SECTIONS,
  measureSkillCost,
  displayReport,
  type MiningReport,
} from "./gap-signal.js";

const MERGED_QA = `## QA Review for Issue #999

### Risk Assessment

- **Sibling sites considered:** Two cross-file siblings reviewed in \`src/lib/foo.ts\` and \`src/lib/bar.ts\`. Both follow the same pattern; non-blocking but a follow-up issue should track the audit. Filed #1001.
- **Sibling-line audit:** N/A — single-call-site fix.

### Anti-Pattern Detection

Detection Pattern Verification: **Not Required** — diff contains no skill regex/grep/awk changes.

### Adversarial Re-Read

- One residue found in \`src/foo.ts:42\`. Non-blocking, recommended as a follow-up issue.

### Verdict: AC_MET_BUT_NOT_A_PLUS

<!-- SEQUANT_PHASE: {"phase":"qa","status":"completed","verdict":"AC_MET_BUT_NOT_A_PLUS","commitSHA":"abc"} -->`;

const SPEC_BODY = `## Plan for #999

### Sibling-site Scan

Pattern \`foo\` appears in 3 sites — all in \`src/lib/foo.ts\`. No cross-file siblings. Non-blocking.

## AC Quality Check

⚠️ **AC-1:** title-body-tension flagged on AC-2. Will fix in exec.
✅ AC-3, AC-4: clean.

<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed"} -->`;

function makeFakeFetchers(
  issues: Array<{
    number: number;
    prNumber: number | null;
    comments: Array<{ body: string; createdAt: string }>;
  }>,
) {
  return {
    listIssues: () => issues.map((i) => i.number),
    fetchIssue: (n: number) => {
      const found = issues.find((i) => i.number === n);
      if (!found) return null;
      return {
        number: found.number,
        prNumber: found.prNumber,
        comments: found.comments,
        bodyText: "",
      };
    },
  };
}

describe("gap-signal mining", () => {
  it("attributes flags to the correct sections", () => {
    const fetchers = makeFakeFetchers([
      {
        number: 999,
        prNumber: 1000,
        comments: [
          { body: SPEC_BODY, createdAt: "2026-04-15T10:00:00Z" },
          { body: MERGED_QA, createdAt: "2026-04-15T11:00:00Z" },
        ],
      },
    ]);

    const report = mine({
      since: "2026-04-01",
      limit: 50,
      out: "/tmp/gap-signal-test.jsonl",
      fetchers,
    });

    // Distribution
    expect(report.totals.issuesScanned).toBe(1);
    expect(report.totals.qaCommentsParsed).toBe(1);
    expect(report.totals.specCommentsParsed).toBe(1);

    // Sections present
    const ids = report.sections.map((s) => s.sectionId);
    expect(ids).toContain("qa.s5");
    expect(ids).toContain("qa.s4q5");
    expect(ids).toContain("qa.s6c");
    expect(ids).toContain("qa.s6d");
    expect(ids).toContain("spec.sibling");
    expect(ids).toContain("spec.aclinter");
  });

  it("classifies §5 as filed_followup when text mentions Filed #N", () => {
    const fetchers = makeFakeFetchers([
      {
        number: 999,
        prNumber: 1000,
        comments: [{ body: MERGED_QA, createdAt: "2026-04-15T11:00:00Z" }],
      },
    ]);

    const report = mine({
      since: "2026-04-01",
      limit: 50,
      out: "/tmp/gap-signal-test.jsonl",
      fetchers,
    });

    const s5 = report.sections.find((s) => s.sectionId === "qa.s5")!;
    expect(s5.triggered).toBe(1);
    expect(s5.byFate.filed_followup).toBe(1);
  });

  it("classifies §4 Q5 'N/A — single-call-site' as not_triggered", () => {
    const fetchers = makeFakeFetchers([
      {
        number: 999,
        prNumber: 1000,
        comments: [{ body: MERGED_QA, createdAt: "2026-04-15T11:00:00Z" }],
      },
    ]);

    const report = mine({
      since: "2026-04-01",
      limit: 50,
      out: "/tmp/gap-signal-test.jsonl",
      fetchers,
    });

    const s4q5 = report.sections.find((s) => s.sectionId === "qa.s4q5")!;
    expect(s4q5.byFate.not_triggered).toBe(1);
    expect(s4q5.triggered).toBe(0);
  });

  it("classifies §6c 'Not Required' as not_triggered", () => {
    const fetchers = makeFakeFetchers([
      {
        number: 999,
        prNumber: 1000,
        comments: [{ body: MERGED_QA, createdAt: "2026-04-15T11:00:00Z" }],
      },
    ]);

    const report = mine({
      since: "2026-04-01",
      limit: 50,
      out: "/tmp/gap-signal-test.jsonl",
      fetchers,
    });

    const s6c = report.sections.find((s) => s.sectionId === "qa.s6c")!;
    expect(s6c.byFate.not_triggered).toBe(1);
  });

  it("classifies §6d 'recommended as a follow-up issue' as filed_followup", () => {
    const fetchers = makeFakeFetchers([
      {
        number: 999,
        prNumber: 1000,
        comments: [{ body: MERGED_QA, createdAt: "2026-04-15T11:00:00Z" }],
      },
    ]);

    const report = mine({
      since: "2026-04-01",
      limit: 50,
      out: "/tmp/gap-signal-test.jsonl",
      fetchers,
    });

    const s6d = report.sections.find((s) => s.sectionId === "qa.s6d")!;
    expect(s6d.triggered).toBe(1);
    expect(s6d.byFate.filed_followup).toBe(1);
  });

  it("computes action rate per section", () => {
    const fetchers = makeFakeFetchers([
      {
        number: 999,
        prNumber: 1000,
        comments: [
          { body: SPEC_BODY, createdAt: "2026-04-15T10:00:00Z" },
          { body: MERGED_QA, createdAt: "2026-04-15T11:00:00Z" },
        ],
      },
    ]);

    const report = mine({
      since: "2026-04-01",
      limit: 50,
      out: "/tmp/gap-signal-test.jsonl",
      fetchers,
    });

    const s5 = report.sections.find((s) => s.sectionId === "qa.s5")!;
    // 1 triggered, 1 filed_followup → 100%
    expect(s5.actionRate).toBe(1);

    const s4q5 = report.sections.find((s) => s.sectionId === "qa.s4q5")!;
    // 0 triggered → 0%
    expect(s4q5.actionRate).toBe(0);
  });
});

describe("measureSkillCost", () => {
  it("returns 0 lines and warns to stderr for missing skill files", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fakeSection = {
      ...SECTIONS[0],
      skillFile: "/tmp/does-not-exist-gap-signal-test.md",
    };
    const cost = measureSkillCost(fakeSection);
    expect(cost.lines).toBe(0);
    expect(cost.words).toBe(0);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("anchor drift"),
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("skillFile not found"),
    );
    errSpy.mockRestore();
  });

  it("returns 0 lines and warns to stderr when section anchor does not match (drift)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Re-use SECTIONS[0]'s real skillFile, but override anchor to a regex
    // that won't match anything in the file — simulating a renamed section.
    const drifted = {
      ...SECTIONS[0],
      skillSectionAnchor: /^### __NONEXISTENT_SECTION_NAME_FOR_DRIFT_TEST__$/,
    };
    const cost = measureSkillCost(drifted);
    expect(cost.lines).toBe(0);
    expect(cost.words).toBe(0);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("section may have been renamed"),
    );
    errSpy.mockRestore();
  });
});

describe("displayReport", () => {
  it("renders sections in descending action-rate order", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Synthetic report: three sections with deliberately out-of-order
    // declaration vs. action rate. The display must sort by actionRate desc.
    const report: MiningReport = {
      generatedAt: "2026-05-10T00:00:00.000Z",
      window: { since: "2026-04-01", until: "2026-05-10" },
      totals: {
        issuesScanned: 0,
        qaCommentsParsed: 0,
        specCommentsParsed: 0,
        flagsTotal: 0,
      },
      rawFlagsPath: "/tmp/sort-order-test.jsonl",
      sections: [
        {
          sectionId: "low",
          label: "LOW-RATE-SECTION",
          totalRuns: 10,
          triggered: 0,
          byFate: {
            actioned_in_pr: 0,
            filed_followup: 0,
            dismissed: 0,
            silent: 0,
            not_triggered: 10,
          },
          actionRate: 0,
          skillLines: 100,
          skillWords: 500,
        },
        {
          sectionId: "high",
          label: "HIGH-RATE-SECTION",
          totalRuns: 4,
          triggered: 4,
          byFate: {
            actioned_in_pr: 2,
            filed_followup: 1,
            dismissed: 1,
            silent: 0,
            not_triggered: 0,
          },
          actionRate: 0.75,
          skillLines: 10,
          skillWords: 50,
        },
        {
          sectionId: "mid",
          label: "MID-RATE-SECTION",
          totalRuns: 6,
          triggered: 3,
          byFate: {
            actioned_in_pr: 1,
            filed_followup: 0,
            dismissed: 1,
            silent: 1,
            not_triggered: 3,
          },
          actionRate: 0.33,
          skillLines: 25,
          skillWords: 100,
        },
      ],
    };

    displayReport(report);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const highIdx = output.indexOf("HIGH-RATE-SECTION");
    const midIdx = output.indexOf("MID-RATE-SECTION");
    const lowIdx = output.indexOf("LOW-RATE-SECTION");

    expect(highIdx).toBeGreaterThan(-1);
    expect(midIdx).toBeGreaterThan(-1);
    expect(lowIdx).toBeGreaterThan(-1);
    expect(highIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(lowIdx);

    logSpy.mockRestore();
  });
});
