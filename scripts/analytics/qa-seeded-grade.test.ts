/**
 * Tests for the seeded-defect graders and the fixture they grade (#1067).
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  extractFindings,
  gradePrecision,
  gradeRecall,
  loadTruth,
  namesIdentifier,
  type GroundTruth,
} from "./qa-seeded-grade.js";

const FIXTURE = path.join("docs", "investigations", "qa-seeded-fixture");
const TRUTH_FILE = path.join(FIXTURE, "ground-truth.json");
const PATCH_FILE = path.join(FIXTURE, "defects.patch");
const SAMPLE_FILE = path.join(FIXTURE, "sample-verdict.md");
const DATASET_FILE = path.join(
  "docs",
  "investigations",
  "qa-second-look-dataset.md",
);

/** Defect classes in the dataset's per-case table (caught rows only). */
function caughtClasses(doc: string): Set<string> {
  const start = doc.indexOf("<!-- dataset-table:start -->");
  const end = doc.indexOf("<!-- dataset-table:end -->");
  const rows = doc.slice(start, end).split("\n").filter((l) => l.startsWith("|"));
  const header = rows[0].split("|").map((c) => c.trim());
  const caughtCol = header.indexOf("Caught");
  const classCol = header.indexOf("Defect class");
  const classes = new Set<string>();
  for (const row of rows.slice(2)) {
    const cells = row.split("|").map((c) => c.trim().replace(/`/g, ""));
    if (cells[caughtCol] === "y") classes.add(cells[classCol]);
  }
  return classes;
}

describe("AC-4: graders score a hand-written verdict", () => {
  const truth = loadTruth(TRUTH_FILE);
  const verdict = fs.readFileSync(SAMPLE_FILE, "utf-8");

  it("3 of 5 identifiers named → recall 0.6", () => {
    const r = gradeRecall(verdict, truth);
    expect(r.hits).toBe(3);
    expect(r.total).toBe(5);
    expect(r.value).toBeCloseTo(0.6);
  });

  it("3 of 5 findings map to a planted identifier → precision 0.6", () => {
    const p = gradePrecision(verdict, truth);
    expect(p.hits).toBe(3);
    expect(p.total).toBe(5);
    expect(p.value).toBeCloseTo(0.6);
  });

  it("the CLI prints both numbers", () => {
    const out = execFileSync(
      "npx",
      [
        "tsx",
        "scripts/analytics/qa-seeded-grade.ts",
        "--verdict",
        SAMPLE_FILE,
        "--truth",
        TRUTH_FILE,
      ],
      { encoding: "utf-8" },
    );
    expect(out).toContain("recall 0.60 (3/5)");
    expect(out).toContain("precision 0.60 (3/5)");
  }, 30_000);
});

describe("AC-5: recall depends on the ground truth", () => {
  it("dropping one planted identifier changes recall", () => {
    const truth = loadTruth(TRUTH_FILE);
    const verdict = fs.readFileSync(SAMPLE_FILE, "utf-8");
    const fewer: GroundTruth = { defects: truth.defects.slice(1) };
    expect(gradeRecall(verdict, fewer).value).not.toBeCloseTo(
      gradeRecall(verdict, truth).value as number,
    );
  });
});

describe("grader edge cases", () => {
  const truth: GroundTruth = {
    defects: [
      { id: "readNotesFile", class: "error-path" },
      { id: "0.0.0.0", class: "security-exposure" },
    ],
  };

  it("a verdict with no findings has undefined precision, not NaN", () => {
    const p = gradePrecision("**Verdict:** READY_FOR_MERGE\n\nAll good.", truth);
    expect(p.total).toBe(0);
    expect(p.value).toBeNull();
  });

  it("matches whole identifiers only", () => {
    expect(namesIdentifier("calls readNotesFileSync", "readNotesFile")).toBe(false);
    expect(namesIdentifier("binds 10.0.0.0", "0.0.0.0")).toBe(false);
    expect(namesIdentifier("binds `0.0.0.0`.", "0.0.0.0")).toBe(true);
  });

  it("counts not-met AC rows and issue-section list items as findings", () => {
    const v = [
      "### AC Coverage",
      "| AC | Status |",
      "|----|--------|",
      "| AC-1 | ✅ Met |",
      "| AC-3 | ❌ Not met — readNotesFile errors are swallowed |",
      "",
      "### Summary",
      "- this list is not an issue section",
      "",
      "### Gaps",
      "- first gap",
      "  continued on a second line",
      "- second gap",
    ].join("\n");
    const findings = extractFindings(v);
    expect(findings).toHaveLength(3);
    expect(findings[1]).toContain("continued on a second line");
    expect(gradePrecision(v, truth).hits).toBe(1);
  });
});

describe("AC-3: the seeded fixture is well-formed", () => {
  const truth = loadTruth(TRUTH_FILE);
  const patchLines = fs.readFileSync(PATCH_FILE, "utf-8").split("\n");

  it("plants ≥5 defects of distinct classes", () => {
    expect(truth.defects.length).toBeGreaterThanOrEqual(5);
    expect(new Set(truth.defects.map((d) => d.class)).size).toBe(
      truth.defects.length,
    );
  });

  it("each identifier occurs on exactly one line of defects.patch", () => {
    for (const d of truth.defects) {
      const count = patchLines.filter((l) => l.includes(d.id)).length;
      expect({ id: d.id, count }).toEqual({ id: d.id, count: 1 });
    }
  });

  it("each class is one the second-look dataset caught", () => {
    const classes = caughtClasses(fs.readFileSync(DATASET_FILE, "utf-8"));
    for (const d of truth.defects) {
      expect({ id: d.id, inDataset: classes.has(d.class) }).toEqual({
        id: d.id,
        inDataset: true,
      });
    }
  });
});
