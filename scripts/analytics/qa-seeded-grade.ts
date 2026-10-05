/**
 * Seeded-defect graders for `/qa` verdicts (#1067, recalibrated in #1313)
 *
 * Scores one posted `/qa` verdict against the ground truth of the
 * seeded-defect fixture (`docs/investigations/qa-seeded-fixture/`):
 *
 *   recall        = planted defects named in a finding ÷ planted defects
 *   planted share = distinct planted defects named in findings
 *                   ÷ (distinct planted defects named + non-planted findings)
 *
 * Planted share is NOT a false-positive rate. A real finding the fixture did
 * not plant (an unvalidated flag, a missing try/catch) lands in `unmatched`
 * and is reported, not scored as a mistake. Restatements of one planted
 * defect (AC row, Issues list, Next steps) collapse to one.
 *
 * Recall reads findings only, not the whole verdict: a neutral mention such as
 * an AC row marked MET that names a helper is not a catch.
 *
 * Each defect carries `identifiers`: tokens a reviewer must write to describe
 * it (the defect site or its file:line). A defect is named when ANY alias
 * appears. Matching is literal and boundary-delimited — a verdict that
 * paraphrases a defect without naming a site token is a miss.
 *
 * What counts as a finding:
 *   1. every top-level list item (`- `, `* `, `1. ` at column 0) inside a
 *      section whose heading names issues — blocker, issue, gap, finding,
 *      concern, problem, defect, bug, recommendation. Not "risk": the /qa
 *      template's "Risk Assessment" lists failure modes for every review.
 *      The title `## QA Review for Issue #N` is not an issues heading;
 *   2. every row of an AC table (header's first cell starts with `AC`) that
 *      marks the AC as not met or partially met (`AC_NOT_MET`, `NOT_MET`,
 *      `PARTIALLY_MET`, `❌`, `Not met`, `Partially met`). ❌ in a build or
 *      test status table is not a finding.
 * A section ends at the next heading of any level.
 *
 * Usage:
 *   npx tsx scripts/analytics/qa-seeded-grade.ts --verdict <file> --truth <file>
 *
 * @see https://github.com/sequant-io/sequant/issues/1313
 */

import * as fs from "fs";

export interface PlantedDefect {
  /** Legacy single identifier; `loadTruth` folds it into `identifiers`. */
  id?: string;
  /** Tokens a reviewer must write to describe the defect; any one names it. */
  identifiers: string[];
  class: string;
  file?: string;
  rationale?: string;
}

export interface GroundTruth {
  defects: PlantedDefect[];
}

export interface Score {
  hits: number;
  total: number;
  /** null when `total` is 0 — undefined, not NaN. */
  value: number | null;
}

const REVIEW_TITLE = /\bQA Review\b/i;
const ISSUE_HEADING =
  /\b(blockers?|issues?|gaps?|findings?|concerns?|problems?|defects?|bugs?|recommendations?)\b/i;
const HEADING = /^\s{0,3}(#{1,6}\s+.*|\*\*[^*]+\*\*:?\s*)$/;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+\S/;
const NOT_MET_ROW =
  /(AC_NOT_MET|\bNOT_MET\b|\bPARTIALLY_MET\b|❌|\bnot met\b|\bpartially met\b)/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `text` names `id` as a whole token (not inside a longer symbol); case-insensitive. */
export function namesIdentifier(text: string, id: string): boolean {
  return new RegExp(`(?<![\\w.])${escapeRegExp(id)}(?![\\w])`, "i").test(text);
}

/** True when `text` names the defect by any of its identifiers. */
export function namesDefect(text: string, d: PlantedDefect): boolean {
  return d.identifiers.some((id) => namesIdentifier(text, id));
}

/** Split a verdict into findings per the rule in the module header. */
export function extractFindings(verdict: string): string[] {
  const findings: string[] = [];
  let inIssueSection = false;
  let current: string[] | null = null;
  let inAcTable = false;
  let prevWasTableRow = false;
  const flush = () => {
    if (current) findings.push(current.join("\n").trim());
    current = null;
  };
  for (const line of verdict.split("\n")) {
    if (HEADING.test(line)) {
      flush();
      inIssueSection = ISSUE_HEADING.test(line) && !REVIEW_TITLE.test(line);
      prevWasTableRow = false;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      if (!prevWasTableRow) {
        // Header row: only a table whose first column is the AC id is an AC table.
        const first = line.split("|")[1] ?? "";
        inAcTable = /^\s*\**AC\b/i.test(first);
      } else if (inAcTable && NOT_MET_ROW.test(line)) {
        findings.push(line.trim());
      }
      prevWasTableRow = true;
      continue;
    }
    prevWasTableRow = false;
    if (inIssueSection && LIST_ITEM.test(line)) {
      flush();
      current = [line];
      continue;
    }
    // Indented continuation of the current list item.
    if (current && /^\s+\S/.test(line)) {
      current.push(line);
      continue;
    }
    if (line.trim() === "" && current) continue;
    flush();
  }
  flush();
  return findings;
}

function ratio(hits: number, total: number): Score {
  return { hits, total, value: total === 0 ? null : hits / total };
}

export function gradeRecall(verdict: string, truth: GroundTruth): Score {
  const findings = extractFindings(verdict);
  const hits = truth.defects.filter((d) =>
    findings.some((f) => namesDefect(f, d)),
  ).length;
  return ratio(hits, truth.defects.length);
}

export interface PlantedShare extends Score {
  /** Findings that name no planted defect. Reported, not penalised. */
  unmatched: string[];
}

export function gradePlantedShare(
  verdict: string,
  truth: GroundTruth,
): PlantedShare {
  const findings = extractFindings(verdict);
  const named = new Set<number>();
  const unmatched: string[] = [];
  for (const f of findings) {
    let any = false;
    truth.defects.forEach((d, i) => {
      if (namesDefect(f, d)) {
        named.add(i);
        any = true;
      }
    });
    if (!any) unmatched.push(f);
  }
  return { ...ratio(named.size, named.size + unmatched.length), unmatched };
}

export function formatScore(name: string, s: Score): string {
  const v = s.value === null ? "n/a" : s.value.toFixed(2);
  return `${name} ${v} (${s.hits}/${s.total})`;
}

export function loadTruth(file: string): GroundTruth {
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as GroundTruth;
  if (!Array.isArray(parsed.defects)) {
    throw new Error(`${file}: expected a "defects" array`);
  }
  for (const d of parsed.defects) {
    if (!Array.isArray(d.identifiers) || d.identifiers.length === 0) {
      d.identifiers = d.id ? [d.id] : [];
    }
    if (d.identifiers.length === 0) {
      throw new Error(`${file}: a defect has neither "identifiers" nor "id"`);
    }
  }
  return parsed;
}

function main(): void {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const verdictFile = get("--verdict");
  const truthFile = get("--truth");
  if (!verdictFile || !truthFile) {
    console.error(
      "usage: qa-seeded-grade.ts --verdict <file> --truth <ground-truth.json>",
    );
    process.exit(2);
  }
  const verdict = fs.readFileSync(verdictFile, "utf-8");
  const truth = loadTruth(truthFile);
  console.log(formatScore("recall", gradeRecall(verdict, truth)));
  const share = gradePlantedShare(verdict, truth);
  console.log(formatScore("planted share", share));
  console.log(`unmatched findings ${share.unmatched.length}`);
}

if (process.argv[1] && /qa-seeded-grade\.ts$/.test(process.argv[1])) {
  main();
}
