/**
 * Seeded-defect graders for `/qa` verdicts (#1067)
 *
 * Scores one posted `/qa` verdict against the ground truth of the
 * seeded-defect fixture (`docs/investigations/qa-seeded-fixture/`):
 *
 *   recall    = planted identifiers named in a finding ÷ planted identifiers
 *   precision = findings that name a planted identifier ÷ findings
 *
 * Recall reads findings only, not the whole verdict: a neutral mention such as
 * an AC row marked MET that names `formatNotes` is not a catch.
 *
 * Both are deterministic. Matching is a literal, boundary-delimited match on
 * the identifier — a verdict that paraphrases a defect without naming its
 * symbol is a miss. That bias is deliberate: it is what the grader-vs-human
 * comparison (AC-7) measures.
 *
 * What counts as a finding (the precision denominator):
 *   1. every top-level list item (`- `, `* `, `1. ` at column 0) inside a
 *      section whose heading names issues — blocker, issue, gap, finding,
 *      concern, problem, defect, bug, recommendation. Not "risk": the /qa
 *      template's "Risk Assessment" lists failure modes and untested paths
 *      for every review, so its bullets are analysis, not findings;
 *   2. every markdown table row, anywhere, that marks an AC as not met or
 *      partially met (`AC_NOT_MET`, `NOT_MET`, `PARTIALLY_MET`, `❌`,
 *      `Not met`, `Partially met`).
 * A section ends at the next heading of any level.
 *
 * Usage:
 *   npx tsx scripts/analytics/qa-seeded-grade.ts --verdict <file> --truth <file>
 *
 * @see https://github.com/sequant-io/sequant/issues/1067
 */

import * as fs from "fs";

export interface PlantedDefect {
  id: string;
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

const ISSUE_HEADING =
  /\b(blockers?|issues?|gaps?|findings?|concerns?|problems?|defects?|bugs?|recommendations?)\b/i;
const HEADING = /^\s{0,3}(#{1,6}\s+.*|\*\*[^*]+\*\*:?\s*)$/;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+\S/;
const NOT_MET_ROW =
  /(AC_NOT_MET|\bNOT_MET\b|\bPARTIALLY_MET\b|❌|\bnot met\b|\bpartially met\b)/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `text` names `id` as a whole token (not inside a longer symbol). */
export function namesIdentifier(text: string, id: string): boolean {
  return new RegExp(`(?<![\\w.])${escapeRegExp(id)}(?![\\w])`).test(text);
}

/** Split a verdict into findings per the rule in the module header. */
export function extractFindings(verdict: string): string[] {
  const findings: string[] = [];
  let inIssueSection = false;
  let current: string[] | null = null;
  const flush = () => {
    if (current) findings.push(current.join("\n").trim());
    current = null;
  };
  for (const line of verdict.split("\n")) {
    if (HEADING.test(line)) {
      flush();
      inIssueSection = ISSUE_HEADING.test(line);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      if (NOT_MET_ROW.test(line)) findings.push(line.trim());
      continue;
    }
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
    findings.some((f) => namesIdentifier(f, d.id)),
  ).length;
  return ratio(hits, truth.defects.length);
}

export function gradePrecision(verdict: string, truth: GroundTruth): Score {
  const findings = extractFindings(verdict);
  const hits = findings.filter((f) =>
    truth.defects.some((d) => namesIdentifier(f, d.id)),
  ).length;
  return ratio(hits, findings.length);
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
  console.log(formatScore("precision", gradePrecision(verdict, truth)));
}

if (process.argv[1] && /qa-seeded-grade\.ts$/.test(process.argv[1])) {
  main();
}
