#!/usr/bin/env npx tsx
/**
 * Phase A measurement instrument for #922 — how grounded are spec plans?
 *
 * Runs `ground-check.ts` over real `SEQUANT_PHASE: spec` plan comments and
 * reports two rates. Reporting only one is the trap this issue was re-aimed to
 * avoid: a phantom rate with no coverage rate reads as a clean bill of health
 * when the real story is "almost nothing was checkable".
 *
 *   phantom rate  = phantom citations / path-and-symbol citations
 *   coverage rate = claim lines carrying >= 1 extractable citation / claim lines
 *
 * **Nonexistent is not phantom.** A plan legitimately names code it proposes to
 * create. The discriminator is deterministic rather than verb-sniffing: check
 * each citation twice — at the commit contemporaneous with the comment, and at
 * HEAD.
 *
 *   exists then                -> grounded
 *   missing then, exists now   -> planned-new (the plan named what it then built)
 *   missing then, missing now  -> phantom candidate
 *
 * That discriminator is only valid once the work has merged, so the headline
 * corpus is restricted to **closed** issues. Open issues are measured too but
 * reported separately as un-discriminable: their planned-new citations are
 * indistinguishable from phantoms by construction.
 *
 * This script reaches the network (`gh`); the checker it drives does not.
 * That split is deliberate — AC-1 requires `ground-check.ts` to stay
 * read-only and offline so it is safe to wire into `/spec` later.
 *
 * Usage:
 *   npx tsx scripts/spec/measure-corpus.ts [--limit 40] [--out <path>] [--json]
 */

import * as fs from "fs";
import * as nodePath from "path";
import { execFileSync } from "child_process";
import {
  buildRepoIndex,
  extractCitations,
  resolvePath,
  resolveSymbol,
  stripFences,
  type Citation,
  type RepoIndex,
} from "./ground-check.js";

const SPEC_MARKER = /SEQUANT_PHASE:\s*\{"phase":"spec"/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Verdict = "grounded" | "planned-new" | "phantom";

export interface MeasuredCitation extends Citation {
  existsNow: boolean;
  verdict: Verdict;
}

export interface RunMeasurement {
  issue: number;
  createdAt: string;
  ref: string | null;
  closed: boolean;
  citations: number;
  grounded: number;
  plannedNew: number;
  phantom: number;
  claimLines: number;
  claimLinesWithCitation: number;
  /** Phantoms the text presented as existing code — the concerning class. */
  phantomAsserted: number;
  /** Phantoms the text proposed to create — dropped or renamed, not false. */
  phantomProposed: number;
  phantomCitations: string[];
}

export interface CorpusReport {
  schemaVersion: 1;
  generatedAt: string;
  headRef: string;
  runs: RunMeasurement[];
  closed: AggregateRates;
  open: AggregateRates;
}

export interface AggregateRates {
  runs: number;
  citations: number;
  grounded: number;
  plannedNew: number;
  phantom: number;
  phantomRate: number;
  phantomAsserted: number;
  /** The decision-relevant rate: asserted-but-nonexistent / all citations. */
  assertedPhantomRate: number;
  claimLines: number;
  claimLinesWithCitation: number;
  coverageRate: number;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * Lines that assert something about the codebase and could therefore carry a
 * citation: list items and table rows in the plan body.
 *
 * Headings, HTML comments, blockquotes and fenced blocks are excluded — they
 * are structure and commentary, and counting them would inflate the
 * denominator with lines nobody would expect to cite a file.
 */
export function claimLines(text: string): string[] {
  return stripFences(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (l.startsWith("#")) return false;
      if (l.startsWith("<!--")) return false;
      if (l.startsWith(">")) return false;
      if (/^\|\s*[-:| ]+\|?$/.test(l)) return false; // table separator
      if (l.startsWith("---")) return false;
      const isListItem = /^([-*+]|\d+\.)\s/.test(l);
      const isTableRow = l.startsWith("|");
      return isListItem || isTableRow;
    });
}

function hasCitation(line: string): boolean {
  return extractCitations(line).length > 0;
}

// ---------------------------------------------------------------------------
// git / gh helpers
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** Last commit on origin/main at or before the comment timestamp. */
export function contemporaneousRef(
  createdAt: string,
  cwd: string,
): string | null {
  try {
    const out = run(
      "git",
      ["rev-list", "-1", `--before=${createdAt}`, "origin/main"],
      cwd,
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

interface HarvestedComment {
  issue: number;
  createdAt: string;
  body: string;
  closed: boolean;
}

export function harvest(limit: number, cwd: string): HarvestedComment[] {
  const raw = run(
    "gh",
    [
      "issue",
      "list",
      "--state",
      "all",
      "--limit",
      "300",
      "--json",
      "number,state,comments",
    ],
    cwd,
  );
  const issues: Array<{
    number: number;
    state: string;
    comments: Array<{ createdAt: string; body: string }>;
  }> = JSON.parse(raw);

  const out: HarvestedComment[] = [];
  for (const issue of issues) {
    for (const c of issue.comments) {
      if (!SPEC_MARKER.test(c.body)) continue;
      out.push({
        issue: issue.number,
        createdAt: c.createdAt,
        body: c.body,
        closed: issue.state === "CLOSED",
      });
    }
  }
  // Newest first, then take the requested slice.
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

function checkAt(
  raw: ReturnType<typeof extractCitations>[number],
  index: RepoIndex,
  cwd: string,
  ref: string | null,
  symbolCache: Map<string, { exists: boolean; matchedAt?: string }>,
): { exists: boolean; matchedAt?: string } {
  if (raw.kind === "path") return resolvePath(raw.raw, index);
  const key = `${ref ?? "WT"}:${raw.raw}`;
  let r = symbolCache.get(key);
  if (!r) {
    r = resolveSymbol(raw.raw, cwd, ref);
    symbolCache.set(key, r);
  }
  return r;
}

export function measureOne(
  c: HarvestedComment,
  cwd: string,
  headIndex: RepoIndex,
  headRef: string,
  symbolCache: Map<string, { exists: boolean; matchedAt?: string }>,
): RunMeasurement {
  const ref = contemporaneousRef(c.createdAt, cwd);
  const thenIndex = ref ? buildRepoIndex(cwd, ref) : headIndex;

  const extracted = extractCitations(c.body);
  const measured: MeasuredCitation[] = extracted.map((e) => {
    const then = checkAt(e, thenIndex, cwd, ref, symbolCache);
    const now = then.exists
      ? { exists: true }
      : checkAt(e, headIndex, cwd, headRef, symbolCache);
    const verdict: Verdict = then.exists
      ? "grounded"
      : now.exists
        ? "planned-new"
        : "phantom";
    return {
      ...e,
      exists: then.exists,
      matchedAt: then.matchedAt,
      existsNow: now.exists,
      verdict,
    };
  });

  const lines = claimLines(c.body);
  return {
    issue: c.issue,
    createdAt: c.createdAt,
    ref,
    closed: c.closed,
    citations: measured.length,
    grounded: measured.filter((m) => m.verdict === "grounded").length,
    plannedNew: measured.filter((m) => m.verdict === "planned-new").length,
    phantom: measured.filter((m) => m.verdict === "phantom").length,
    claimLines: lines.length,
    claimLinesWithCitation: lines.filter(hasCitation).length,
    phantomAsserted: measured.filter(
      (m) => m.verdict === "phantom" && m.intent === "reference",
    ).length,
    phantomProposed: measured.filter(
      (m) => m.verdict === "phantom" && m.intent === "creation",
    ).length,
    phantomCitations: measured
      .filter((m) => m.verdict === "phantom")
      .map((m) => `${m.kind}:${m.raw} (${m.intent})`),
  };
}

export function aggregate(runs: RunMeasurement[]): AggregateRates {
  const sum = (f: (r: RunMeasurement) => number): number =>
    runs.reduce((a, r) => a + f(r), 0);
  const citations = sum((r) => r.citations);
  const phantom = sum((r) => r.phantom);
  const claim = sum((r) => r.claimLines);
  const claimCited = sum((r) => r.claimLinesWithCitation);
  const asserted = sum((r) => r.phantomAsserted);
  return {
    runs: runs.length,
    citations,
    grounded: sum((r) => r.grounded),
    plannedNew: sum((r) => r.plannedNew),
    phantom,
    phantomRate: citations ? phantom / citations : 0,
    phantomAsserted: asserted,
    assertedPhantomRate: citations ? asserted / citations : 0,
    claimLines: claim,
    claimLinesWithCitation: claimCited,
    coverageRate: claim ? claimCited / claim : 0,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function formatReport(report: CorpusReport): string {
  const L: string[] = [];
  const { closed, open } = report;

  L.push("## Phase A measurement — spec plan citation grounding");
  L.push("");
  L.push(
    `Corpus: ${report.runs.length} \`SEQUANT_PHASE: spec\` plan comments ` +
      `(${closed.runs} on closed issues, ${open.runs} on open). ` +
      `Each citation checked twice: at the commit contemporaneous with the ` +
      `comment, and at HEAD (\`${report.headRef.slice(0, 8)}\`).`,
  );
  L.push("");
  L.push("### Headline — closed issues (the discriminable corpus)");
  L.push("");
  L.push("| Metric | Value |");
  L.push("|--------|-------|");
  L.push(`| Plan comments | ${closed.runs} |`);
  L.push(`| Citations extracted | ${closed.citations} |`);
  L.push(`| Grounded (existed at spec time) | ${closed.grounded} |`);
  L.push(`| Planned-new (created afterwards) | ${closed.plannedNew} |`);
  L.push(`| Missing at both refs | ${closed.phantom} |`);
  L.push(
    `| — of those, proposed (dropped/renamed) | ${closed.phantom - closed.phantomAsserted} |`,
  );
  L.push(
    `| — of those, **asserted as existing code** | **${closed.phantomAsserted}** |`,
  );
  L.push(`| Phantom rate (all missing) | ${pct(closed.phantomRate)} |`);
  L.push(
    `| **Asserted-phantom rate** (the decision-relevant one) | **${pct(closed.assertedPhantomRate)}** |`,
  );
  L.push(
    `| **Coverage rate** | **${pct(closed.coverageRate)}** ` +
      `(${closed.claimLinesWithCitation}/${closed.claimLines} claim lines) |`,
  );
  L.push("");
  L.push("### Open issues — reported separately, not discriminable");
  L.push("");
  L.push(
    `${open.runs} comments, ${open.citations} citations, ` +
      `${open.phantom} unresolved at both refs (${pct(open.phantomRate)}). ` +
      "Their work has not merged, so planned-new and phantom are " +
      "indistinguishable by construction — this number is an upper bound, not a rate.",
  );
  L.push("");
  L.push("### Per-run detail (closed issues)");
  L.push("");
  L.push(
    "| Issue | Citations | Grounded | Planned-new | Missing | Asserted-phantom | Coverage |",
  );
  L.push(
    "|-------|-----------|----------|-------------|---------|------------------|----------|",
  );
  for (const r of report.runs.filter((x) => x.closed)) {
    const cov = r.claimLines ? r.claimLinesWithCitation / r.claimLines : 0;
    L.push(
      `| #${r.issue} | ${r.citations} | ${r.grounded} | ${r.plannedNew} | ` +
        `${r.phantom} | ${r.phantomAsserted} | ${pct(cov)} |`,
    );
  }
  L.push("");

  const withPhantoms = report.runs.filter((r) => r.closed && r.phantom > 0);
  if (withPhantoms.length > 0) {
    L.push("### Phantom candidates (closed issues) — for manual adjudication");
    L.push("");
    for (const r of withPhantoms) {
      L.push(`- **#${r.issue}:** ${r.phantomCitations.join(", ")}`);
    }
    L.push("");
  }

  L.push("### Caveats");
  L.push("");
  L.push(
    "- **This is an existence score, not a grounding-quality score.** It " +
      "catches the loud failure (a cited path that does not exist) and is " +
      "blind to the quiet one (a real path described incorrectly). Do not " +
      "read the phantom rate as a measure of whether plans understood the " +
      "code they cite.",
  );
  L.push(
    "- The coverage rate is the decision-relevant denominator: a low phantom " +
      "rate over low coverage means most claims were never checkable, not " +
      "that most claims were right.",
  );
  L.push(
    "- Contemporaneous refs resolve against `origin/main` by comment " +
      "timestamp. A plan written against an unmerged branch will show its " +
      "branch-only files as missing-then.",
  );
  L.push(
    "- **Missing is not phantom, and phantom is not hallucinated.** Plan text " +
      "is full of proposals, so a citation missing at both refs is usually a " +
      "name that was dropped or renamed during implementation — #920's plan " +
      "offered `hasDeliverableCommits` as an alias and shipped " +
      "`hasExecChanges`. The intent split separates proposals from claims " +
      "about existing code; the latter is the only bucket a grounding gate " +
      "would have caught, and it still warrants reading before it is believed.",
  );
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Args {
  limit: number;
  out: string | null;
  json: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 40, out: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--limit")
      args.limit = parseInt(argv[++i] ?? "40", 10) || 40;
    else if (a === "--out") args.out = argv[++i] ?? null;
    else if (a === "--json") args.json = true;
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    // eslint-disable-next-line no-console
    console.log(
      [
        "Phase A measurement — spec plan citation grounding (#922)",
        "",
        "Usage:",
        "  npx tsx scripts/spec/measure-corpus.ts [--limit 40] [--out <path>] [--json]",
        "",
        "Options:",
        "  --limit <N>   Most recent N spec plan comments (default: 40)",
        "  --out <path>  Write the markdown report here",
        "  --json        Emit the raw JSON report instead of markdown",
        "  --help        Show this help",
      ].join("\n"),
    );
    return;
  }

  const cwd = process.cwd();
  const headRef = run("git", ["rev-parse", "HEAD"], cwd).trim();
  const headIndex = buildRepoIndex(cwd, headRef);
  const symbolCache = new Map<
    string,
    { exists: boolean; matchedAt?: string }
  >();

  const comments = harvest(args.limit, cwd);
  // eslint-disable-next-line no-console
  console.error(`Measuring ${comments.length} spec plan comments...`);

  const runs: RunMeasurement[] = [];
  for (const c of comments) {
    runs.push(measureOne(c, cwd, headIndex, headRef, symbolCache));
    // eslint-disable-next-line no-console
    console.error(`  #${c.issue} (${runs.length}/${comments.length})`);
  }

  const report: CorpusReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    headRef,
    runs,
    closed: aggregate(runs.filter((r) => r.closed)),
    open: aggregate(runs.filter((r) => !r.closed)),
  };

  const output = args.json
    ? JSON.stringify(report, null, 2) + "\n"
    : formatReport(report) + "\n";

  if (args.out) {
    const dir = nodePath.dirname(args.out);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(args.out, output);
    // eslint-disable-next-line no-console
    console.error(`Wrote ${args.out}`);
  } else {
    process.stdout.write(output);
  }
}

const isMain = (() => {
  try {
    const invoked = process.argv[1];
    if (!invoked) return false;
    const here = new URL(import.meta.url).pathname;
    return nodePath.resolve(invoked) === nodePath.resolve(here);
  } catch {
    return false;
  }
})();

if (isMain) {
  main();
}
