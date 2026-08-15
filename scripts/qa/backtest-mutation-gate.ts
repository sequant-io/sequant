#!/usr/bin/env npx tsx
/**
 * AC-5 backtest (#939): "measurement before enforcement breadth is widened."
 *
 * Applies the §6i gate-test-AC population definition (`isGateTestEvidence`)
 * to the last N merged PRs' `## Pre-PR AC Verification` tables (the format
 * `/exec` produces — see #939's Implementation Plan step 12) and counts how
 * many in-scope ACs would have been `Missing` under the new gate. None of
 * these PRs predate this feature, so ~100% Missing is the expected finding
 * — the number that sizes the authoring burden is the *count of in-scope
 * ACs*, not the Missing rate itself.
 *
 * Modeled on `scripts/spec/measure-corpus.ts`'s `harvest()` shape: a real
 * `gh` corpus, no synthetic fixtures, re-runnable rather than a one-off
 * calculation.
 *
 * Usage:
 *   npx tsx scripts/qa/backtest-mutation-gate.ts [--limit N]
 */
import { execFileSync } from "node:child_process";
import { isGateTestEvidence } from "../../src/lib/ac-parser.js";
import { parseMutationMarkers } from "../../src/lib/workflow/mutation-marker.js";

interface MergedPr {
  number: number;
  title: string;
  body: string;
}

export function fetchMergedPrs(limit: number, cwd: string): MergedPr[] {
  const raw = execFileSync(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "merged",
      "--limit",
      String(limit),
      "--json",
      "number,title,body",
    ],
    { cwd, encoding: "utf-8", maxBuffer: 1024 * 1024 * 16 },
  );
  return JSON.parse(raw);
}

/**
 * A row from a `## Pre-PR AC Verification` markdown table:
 * `| AC | Description | Status | Evidence |` (column order/count varies
 * slightly across the exec skill's historical revisions, so header names
 * are read rather than assumed positionally).
 */
export interface AcTableRow {
  ac: string;
  evidence: string;
}

const AC_TABLE_HEADING_RE = /^##+\s*Pre-PR AC Verification\s*$/im;
const TABLE_ROW_RE = /^\|(.+)\|\s*$/;

/**
 * Extract `AC-N` rows from the first `## Pre-PR AC Verification` markdown
 * table in a PR body, keyed to whichever column is headed "Evidence" (empty
 * string when the table has no such column — a pre-#938 PR, or a
 * derived-AC row with no evidence cell).
 */
export function extractAcTableRows(prBody: string): AcTableRow[] {
  const headingMatch = AC_TABLE_HEADING_RE.exec(prBody);
  if (!headingMatch) return [];

  const rest = prBody.slice(headingMatch.index + headingMatch[0].length);
  const lines = rest.split("\n");

  let headerCells: string[] | null = null;
  let evidenceCol = -1;
  let acCol = -1;
  const rows: AcTableRow[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 && headerCells) break; // table ended
    const match = TABLE_ROW_RE.exec(trimmed);
    if (!match) {
      if (headerCells) break; // non-table line after the table started
      continue; // still scanning for the table's start
    }
    const cells = match[1].split("|").map((c) => c.trim());

    if (!headerCells) {
      headerCells = cells.map((c) => c.toLowerCase());
      acCol = headerCells.findIndex((c) => c === "ac");
      evidenceCol = headerCells.findIndex((c) => c === "evidence");
      continue;
    }
    // Skip the `|---|---|` separator row.
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (acCol === -1) continue;

    const acCell = cells[acCol] ?? "";
    const acMatch = /AC-\d+/i.exec(acCell);
    if (!acMatch) continue;

    rows.push({
      ac: acMatch[0].toUpperCase(),
      evidence: evidenceCol >= 0 ? (cells[evidenceCol] ?? "") : "",
    });
  }

  return rows;
}

export interface BacktestResult {
  prsScanned: number;
  prsWithAcTable: number;
  totalAcRows: number;
  inScopeAcCount: number;
  missingCount: number;
  perPr: Array<{ pr: number; inScope: number; missing: number }>;
}

export function backtest(prs: MergedPr[]): BacktestResult {
  let prsWithAcTable = 0;
  let totalAcRows = 0;
  let inScopeAcCount = 0;
  let missingCount = 0;
  const perPr: BacktestResult["perPr"] = [];

  for (const pr of prs) {
    const rows = extractAcTableRows(pr.body ?? "");
    if (rows.length === 0) continue;
    prsWithAcTable++;
    totalAcRows += rows.length;

    const markers = parseMutationMarkers(pr.body ?? "");
    const markedAcs = new Set(markers.map((m) => m.ac.toUpperCase()));

    let prInScope = 0;
    let prMissing = 0;
    for (const row of rows) {
      if (!row.evidence || !isGateTestEvidence(row.evidence)) continue;
      prInScope++;
      inScopeAcCount++;
      if (!markedAcs.has(row.ac)) {
        prMissing++;
        missingCount++;
      }
    }
    if (prInScope > 0) {
      perPr.push({ pr: pr.number, inScope: prInScope, missing: prMissing });
    }
  }

  return {
    prsScanned: prs.length,
    prsWithAcTable,
    totalAcRows,
    inScopeAcCount,
    missingCount,
    perPr,
  };
}

export function formatReport(result: BacktestResult): string {
  const L: string[] = [];
  L.push("## AC-5 backtest — mutation-verification gate, last N merged PRs");
  L.push("");
  L.push(
    `Method: fetched the last ${result.prsScanned} merged PRs, extracted each PR's ` +
      "`## Pre-PR AC Verification` table, applied `isGateTestEvidence` to the " +
      "Evidence column to identify gate-test ACs, and checked for a " +
      "`SEQUANT_MUTATION` marker naming that AC.",
  );
  L.push("");
  L.push("| Metric | Value |");
  L.push("|--------|-------|");
  L.push(`| PRs scanned | ${result.prsScanned} |`);
  L.push(
    `| PRs with a Pre-PR AC Verification table | ${result.prsWithAcTable} |`,
  );
  L.push(`| Total AC rows found | ${result.totalAcRows} |`);
  L.push(`| In-scope (gate-test) ACs | ${result.inScopeAcCount} |`);
  L.push(`| Missing (no SEQUANT_MUTATION marker) | ${result.missingCount} |`);
  L.push(
    `| Missing rate among in-scope ACs | ${
      result.inScopeAcCount
        ? `${((result.missingCount / result.inScopeAcCount) * 100).toFixed(0)}%`
        : "N/A (0 in-scope ACs)"
    } |`,
  );
  L.push("");
  L.push(
    "100% Missing is the expected finding — none of these PRs predate this " +
      "feature. The authoring-burden signal is the **in-scope AC count**: " +
      `${result.inScopeAcCount} gate-test AC(s) across ${result.prsScanned} PRs.`,
  );
  if (result.perPr.length > 0) {
    L.push("");
    L.push("| PR | In-scope ACs | Missing |");
    L.push("|----|--------------|---------|");
    for (const row of result.perPr) {
      L.push(`| #${row.pr} | ${row.inScope} | ${row.missing} |`);
    }
  }
  return L.join("\n");
}

const isDirectRun =
  process.argv[1] && process.argv[1].endsWith("backtest-mutation-gate.ts");

if (isDirectRun) {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : 20;
  const prs = fetchMergedPrs(limit, process.cwd());
  const result = backtest(prs);
  console.log(formatReport(result));
}
