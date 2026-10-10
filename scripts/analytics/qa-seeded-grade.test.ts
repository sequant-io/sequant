/**
 * Tests for the seeded-defect graders and the fixture they grade (#1067).
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import * as os from "os";
import {
  extractFindings,
  gradePlantedShare,
  gradeRecall,
  loadTruth,
  namesIdentifier,
  type GroundTruth,
} from "./qa-seeded-grade.js";

const FIXTURE = path.join("docs", "investigations", "qa-seeded-fixture");
const TRUTH_FILE = path.join(FIXTURE, "ground-truth.json");
const PATCH_FILE = path.join(FIXTURE, "defects.patch");
const SAMPLE_FILE = path.join(FIXTURE, "sample-verdict.md");
const REVIEWS_DIR = path.join(FIXTURE, "reviews");
const DATASET_FILE = path.join(
  "docs",
  "investigations",
  "qa-second-look-dataset.md",
);

/** Defect classes in the dataset's per-case table (caught rows only). */
function caughtClasses(doc: string): Set<string> {
  const start = doc.indexOf("<!-- dataset-table:start -->");
  const end = doc.indexOf("<!-- dataset-table:end -->");
  const rows = doc
    .slice(start, end)
    .split("\n")
    .filter((l) => l.startsWith("|"));
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

  it("3 of 5 findings map to a planted identifier → planted share 0.6", () => {
    const p = gradePlantedShare(verdict, truth);
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
    expect(out).toContain("planted share 0.60 (3/5)");
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
      { identifiers: ["readNotesFile"], class: "error-path" },
      { identifiers: ["0.0.0.0"], class: "security-exposure" },
    ],
  };

  it("a verdict with no findings has undefined planted share, not NaN", () => {
    const p = gradePlantedShare(
      "**Verdict:** READY_FOR_MERGE\n\nAll good.",
      truth,
    );
    expect(p.total).toBe(0);
    expect(p.value).toBeNull();
  });

  it("matches whole identifiers only", () => {
    expect(namesIdentifier("calls readNotesFileSync", "readNotesFile")).toBe(
      false,
    );
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
    expect(gradePlantedShare(v, truth).hits).toBe(1);
  });
});

describe("graders read sequant's real /qa template", () => {
  const truth = loadTruth(TRUTH_FILE);
  // Shape of a posted /qa review (see #1271's): AC table with MET /
  // PARTIALLY_MET, Code Review **Issues**, and a Risk Assessment that every
  // review fills in whether or not anything is wrong.
  const verdict = [
    "## QA Review for Issue #1",
    "",
    "### AC Coverage",
    "",
    "| AC | Source | Status | Notes |",
    "|----|--------|--------|-------|",
    "| AC-1 | Original | MET | runExport calls store.formatNotes correctly |",
    "| AC-2 | Original | PARTIALLY_MET | parseSinceDate is never called |",
    "",
    "### Code Review",
    "",
    "**Issues**",
    "- The preview server binds `0.0.0.0`.",
    "",
    "### Risk Assessment",
    "",
    "- **Likely failure mode:** a large store slows the export.",
    "- **Not tested:** Windows paths.",
    "- **Sibling sites considered:** every caller of readNotesFile.",
    "- **Sibling-line audit:** clean.",
    "",
    "### Verdict: AC_NOT_MET",
  ].join("\n");

  it("Risk Assessment bullets are not findings; a PARTIALLY_MET row is", () => {
    const findings = extractFindings(verdict);
    expect(findings).toHaveLength(2);
    expect(gradePlantedShare(verdict, truth)).toMatchObject({
      hits: 2,
      total: 2,
    });
  });

  it("a neutral mention (MET row, risk note) is not a recall hit", () => {
    // formatNotes appears only in a MET row; readNotesFile only in Risk.
    expect(gradeRecall(verdict, truth)).toMatchObject({ hits: 2, total: 5 });
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

  it("each defect has an alias that occurs on exactly one line of defects.patch", () => {
    for (const d of truth.defects) {
      const counts = d.identifiers.map(
        (id) => patchLines.filter((l) => l.includes(id)).length,
      );
      expect({ id: d.identifiers[0], anchored: counts.includes(1) }).toEqual({
        id: d.identifiers[0],
        anchored: true,
      });
    }
  });

  it("each class is one the second-look dataset caught", () => {
    const classes = caughtClasses(fs.readFileSync(DATASET_FILE, "utf-8"));
    for (const d of truth.defects) {
      expect({
        id: d.identifiers[0],
        inDataset: classes.has(d.class),
      }).toEqual({
        id: d.identifiers[0],
        inDataset: true,
      });
    }
  });
});

describe("AC-1 (#1313): identifiers are tokens a reviewer must write", () => {
  const truth = loadTruth(TRUTH_FILE);
  const reviews = [1, 2, 3, 4, 5].map((n) =>
    fs.readFileSync(path.join(REVIEWS_DIR, `run-${n}.md`), "utf-8"),
  );

  it("no identifier is a pre-existing store helper name", () => {
    const all = truth.defects.flatMap((d) => d.identifiers);
    expect(all).not.toContain("formatNotes");
    expect(all).not.toContain("readNotesFile");
  });

  it("grader-vs-human disagreement on the five stored reviews is ≤ 2 of 25", () => {
    // The human label is "caught" for every planted defect in every run.
    let missed = 0;
    for (const v of reviews) {
      const r = gradeRecall(v, truth);
      missed += r.total - r.hits;
    }
    expect(missed).toBeLessThanOrEqual(2);
  });

  it("the committed reviews carry no machine paths or private repo names", () => {
    for (const v of reviews) {
      expect(v).not.toMatch(/\/Users\/|notes-fixture/);
    }
  });
});

describe("AC-2 (#1313): planted share is not a false-positive rate", () => {
  const truth: GroundTruth = {
    defects: [
      { identifiers: ["empty catch", "catch {"], class: "error-path" },
      { identifiers: ["0.0.0.0"], class: "security-exposure" },
    ],
  };
  const verdict = [
    "### Issues",
    "- The empty catch swallows store errors.",
    "- The server binds 0.0.0.0.",
    "- `--port` is never validated.",
    "",
    "### Next steps",
    "- Remove the empty catch in export.ts.",
    "- Fix the empty catch so AC-3 passes.",
  ].join("\n");

  it("collapses restatements of one defect and does not penalise a real extra finding", () => {
    const s = gradePlantedShare(verdict, truth);
    // 2 distinct planted defects + 1 real non-planted finding.
    expect(s).toMatchObject({ hits: 2, total: 3 });
    expect(s.unmatched).toEqual(["- `--port` is never validated."]);
  });

  it("a restated defect alone scores 1/1, not 1/3", () => {
    const v = [
      "### Issues",
      "- empty catch in export.ts",
      "- the empty catch again",
      "- still the empty catch",
    ].join("\n");
    expect(gradePlantedShare(v, truth)).toMatchObject({ hits: 1, total: 1 });
  });

  it("any one alias names the defect, case-insensitively", () => {
    const v = "### Issues\n- Empty Catch hides errors\n";
    expect(gradeRecall(v, truth).hits).toBe(1);
  });

  it("a legacy single id still loads as one identifier", () => {
    const tmp = path.join(
      fs.mkdtempSync(path.join(require("os").tmpdir(), "truth-")),
      "t.json",
    );
    fs.writeFileSync(
      tmp,
      JSON.stringify({ defects: [{ id: "vi.mock", class: "unmet-ac" }] }),
    );
    expect(loadTruth(tmp).defects[0].identifiers).toEqual(["vi.mock"]);
  });
});

describe("AC-3 (#1313): template intro bullets and status-table ❌ are not findings", () => {
  const truth = loadTruth(TRUTH_FILE);
  const verdict = [
    "## QA Review for Issue #1: `notes export`",
    "",
    "- **Mode:** sequant run",
    "- **Branch:** feature/1-add-notes-export",
    "",
    "### Build and tests",
    "",
    "| Check | Status |",
    "|-------|--------|",
    "| Build | ✅ passes |",
    "| Tests | ❌ 1 failing |",
    "",
    "### AC Coverage",
    "",
    "| AC | Status | Notes |",
    "|----|--------|-------|",
    "| AC-1 | ❌ NOT_MET | `--format md` prints JSON |",
    "| AC-2 | ✅ MET | fine |",
    "",
    "### Issues",
    "- the server binds 0.0.0.0",
    "",
    '<!-- SEQUANT_QA_GAPS: {"findings":[{"evidence":"0.0.0.0"}]} -->',
  ].join("\n");

  it("only the AC-table ❌ row and the Issues item are findings", () => {
    const findings = extractFindings(verdict);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toContain("AC-1");
    expect(findings[1]).toContain("0.0.0.0");
  });

  it("the title heading does not open an issues section", () => {
    const v = "## QA Review for Issue #7\n- **Mode:** x\n- **Branch:** y\n";
    expect(extractFindings(v)).toEqual([]);
  });
});

describe("#1344: the held-out fixture is well-formed and stays held out", () => {
  const HELDOUT = path.join("docs", "investigations", "qa-heldout-fixture");
  const heldTruthFile = path.join(HELDOUT, "ground-truth.json");
  const heldPatch = path.join(HELDOUT, "defects.patch");
  const truth = loadTruth(heldTruthFile);
  const patchLines = fs.readFileSync(heldPatch, "utf-8").split("\n");

  it("carries a held-out warning that names #1068", () => {
    const raw = JSON.parse(fs.readFileSync(heldTruthFile, "utf-8"));
    expect(raw._warning).toMatch(/#1068/);
  });

  it("plants 5 defects of distinct classes, each anchored on one patch line", () => {
    expect(truth.defects).toHaveLength(5);
    expect(new Set(truth.defects.map((d) => d.class)).size).toBe(5);
    for (const d of truth.defects) {
      const counts = d.identifiers.map(
        (id) => patchLines.filter((l) => l.includes(id)).length,
      );
      expect({ id: d.identifiers[0], anchored: counts.includes(1) }).toEqual({
        id: d.identifiers[0],
        anchored: true,
      });
    }
  });

  it("uses classes the dataset never shows caught, plus primary-path-broken", () => {
    const caught = caughtClasses(fs.readFileSync(DATASET_FILE, "utf-8"));
    for (const d of truth.defects) {
      if (d.class === "primary-path-broken") continue;
      expect({ class: d.class, caught: caught.has(d.class) }).toEqual({
        class: d.class,
        caught: false,
      });
    }
  });

  it("shares no identifier with the in-sample seeded fixture", () => {
    const seeded = new Set(
      loadTruth(TRUTH_FILE).defects.flatMap((d) => d.identifiers),
    );
    const shared = truth.defects
      .flatMap((d) => d.identifiers)
      .filter((id) => seeded.has(id));
    expect(shared).toEqual([]);
  });

  it("applies cleanly to the shared base project", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heldout-"));
    try {
      fs.cpSync(path.join(FIXTURE, "base"), dir, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["apply", "--check", path.resolve(heldPatch)], {
        cwd: dir,
        stdio: "pipe",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
