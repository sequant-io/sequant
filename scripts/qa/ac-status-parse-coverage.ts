#!/usr/bin/env npx tsx
/**
 * Per-AC status parse coverage (#1524, RD-1 of graph-2026-10-review-surface).
 *
 * The QA skill reports per-AC results as prose: tables in some comments,
 * bullet lists in others. The only machine marker is `SEQUANT_PHASE`, which
 * carries the overall verdict. This script measures how far a line-anchored
 * regex gets at reading per-AC status back out of that prose, so the owner
 * can decide between shipping a parser now and adding a marker first.
 *
 * Two modes:
 *   --since DATE   Live corpus: every comment in this repo created on or after
 *                  DATE whose body carries `<!-- SEQUANT_PHASE: {"phase":"qa"`.
 *                  The denominator is the AC ids in each comment's *issue body*
 *                  (`extractAcceptanceCriteria`), not the ids the comment
 *                  mentions, so a comment that skips an AC counts the miss.
 *   --fixture      Hand-labelled fixture (`__tests__/fixtures/qa-comments/`):
 *                  precision and recall against `expected.json`.
 *
 * The parser stays in this script. RS-02 (#1525) owns the producer and may
 * lift it later.
 *
 * Usage:
 *   npx tsx scripts/qa/ac-status-parse-coverage.ts --since 2026-08-01 [--json]
 *   npx tsx scripts/qa/ac-status-parse-coverage.ts --fixture [--json]
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAcceptanceCriteria } from "../../src/lib/ac-parser.js";

export type AcStatus = "met" | "not_met" | "pending" | "unknown";

export const AC_STATUSES: readonly AcStatus[] = [
  "met",
  "not_met",
  "pending",
  "unknown",
];

const QA_MARKER = '<!-- SEQUANT_PHASE: {"phase":"qa"';

/**
 * Status tokens, matched case-sensitively. `\b` treats `_` as a word
 * character, so `AC_NOT_MET` and `AC_MET_BUT_NOT_A_PLUS` (verdict names that
 * appear inside description cells) do not match `MET`.
 */
const STATUS_TOKENS: Array<{ re: RegExp; status: AcStatus }> = [
  { re: /\b(?:NOT|PARTIALLY)[ _]MET\b/g, status: "not_met" },
  { re: /\bMET\b/g, status: "met" },
  { re: /\bPENDING\b/g, status: "pending" },
  { re: /✅/g, status: "met" },
  { re: /❌/g, status: "not_met" },
  { re: /⚠/g, status: "pending" },
];

/** First status token in `text`, by position. */
export function firstStatusToken(text: string): AcStatus | null {
  let best: { index: number; status: AcStatus } | null = null;
  for (const { re, status } of STATUS_TOKENS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) {
      best = { index: m.index, status };
    }
  }
  return best?.status ?? null;
}

/**
 * The AC ids a row is *about*, and the text after them. Only the leading
 * position counts: the first cell of a table row, or the start of a list item
 * or heading. `AC-1/AC-2` and `AC-1/2/3` name several ids. An id anywhere else
 * on the line is prose and is ignored.
 */
export function leadingAcIds(
  line: string,
): { ids: string[]; rest: string } | null {
  const trimmed = line.trim();
  let lead: string;
  let rest: string;
  if (trimmed.startsWith("|")) {
    const cells = trimmed.replace(/^\|/, "").split("|");
    lead = cells[0] ?? "";
    rest = cells.slice(1).join("|");
  } else {
    const m = /^(?:[-*+]|\d+\.|#{1,6})\s+(.*)$/.exec(trimmed);
    if (!m) return null;
    lead = m[1];
    rest = "";
  }
  const head = /^[\s*_`]*AC-(\d+)((?:\s*\/\s*(?:AC-)?\d+)*)/.exec(lead);
  if (!head) return null;
  const ids = [`AC-${head[1]}`];
  for (const n of head[2].matchAll(/\d+/g)) ids.push(`AC-${n[0]}`);
  if (!trimmed.startsWith("|")) rest = lead.slice(head[0].length);
  else rest = lead.slice(head[0].length) + "|" + rest;
  return { ids, rest };
}

/** Body lines outside fenced code blocks and HTML comments. */
function proseLines(body: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of body.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out;
}

/**
 * Candidate parse: for each id in `acIds`, the first status token on the
 * first table row, list item or heading that leads with that id. Ids with no
 * such line read `unknown`. Free prose is never read.
 */
export function parseAcStatuses(
  body: string,
  acIds: readonly string[],
): Map<string, AcStatus> {
  const wanted = new Set(acIds.map((id) => id.toUpperCase()));
  const found = new Map<string, AcStatus>();
  for (const line of proseLines(body)) {
    const lead = leadingAcIds(line);
    if (!lead) continue;
    const status = firstStatusToken(lead.rest);
    if (!status) continue;
    for (const id of lead.ids) {
      if (wanted.has(id) && !found.has(id)) found.set(id, status);
    }
  }
  const result = new Map<string, AcStatus>();
  for (const id of wanted) result.set(id, found.get(id) ?? "unknown");
  return result;
}

// ── Fixture scoring ─────────────────────────────────────────────────────────

export interface ExpectedEntry {
  issue: number;
  commentId: number;
  acs: Array<{ id: string; status: AcStatus }>;
}

export type Expected = Record<string, ExpectedEntry>;

export interface FixtureMiss {
  fixture: string;
  id: string;
  expected: AcStatus;
  parsed: AcStatus;
  kind: "fp" | "fn";
}

export interface FixtureScore {
  fixtures: number;
  acs: number;
  classified: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  misses: FixtureMiss[];
}

/**
 * TP: the parse is not `unknown` and equals the label. FP: the parse is not
 * `unknown` and differs from the label (a stray `MET` near an AC id lands
 * here). FN: the label is not `unknown` and the parse is `unknown`.
 */
export function scoreFixture(
  expected: Expected,
  readBody: (fixture: string) => string,
): FixtureScore {
  let acs = 0;
  let classified = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const misses: FixtureMiss[] = [];
  for (const [fixture, entry] of Object.entries(expected)) {
    const parsed = parseAcStatuses(
      readBody(fixture),
      entry.acs.map((a) => a.id),
    );
    for (const { id, status: truth } of entry.acs) {
      acs++;
      const got = parsed.get(id.toUpperCase()) ?? "unknown";
      if (got !== "unknown") classified++;
      if (got !== "unknown" && got === truth) tp++;
      else if (got !== "unknown") {
        fp++;
        misses.push({ fixture, id, expected: truth, parsed: got, kind: "fp" });
      } else if (truth !== "unknown") {
        fn++;
        misses.push({ fixture, id, expected: truth, parsed: got, kind: "fn" });
      }
    }
  }
  return {
    fixtures: Object.keys(expected).length,
    acs,
    classified,
    tp,
    fp,
    fn,
    precision: tp + fp === 0 ? 0 : tp / (tp + fp),
    recall: tp + fn === 0 ? 0 : tp / (tp + fn),
    misses,
  };
}

export function fixtureDir(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../__tests__/fixtures/qa-comments",
  );
}

export function loadFixture(dir: string = fixtureDir()): {
  expected: Expected;
  readBody: (fixture: string) => string;
} {
  const expected = JSON.parse(
    fs.readFileSync(path.join(dir, "expected.json"), "utf-8"),
  ) as Expected;
  return {
    expected,
    readBody: (fixture) => fs.readFileSync(path.join(dir, fixture), "utf-8"),
  };
}

// ── Live corpus ─────────────────────────────────────────────────────────────

export interface RawComment {
  id: number;
  created_at: string;
  issue_url: string;
  body: string;
}

export interface QaComment {
  id: number;
  createdAt: string;
  issue: number;
  status: string;
  body: string;
}

/**
 * Comments created on or after `since` that carry a QA phase marker. The
 * API's `since` filters on `updated_at`, so `created_at` is checked here. A
 * comment that only quotes the marker in prose (no `<!--`) is not selected.
 */
export function selectQaComments(
  raw: RawComment[],
  since: string,
): QaComment[] {
  const out: QaComment[] = [];
  for (const c of raw) {
    if (c.created_at < since) continue;
    const at = c.body?.indexOf(QA_MARKER) ?? -1;
    if (at === -1) continue;
    const status =
      /"status":"([a-z_]+)"/.exec(c.body.slice(at))?.[1] ?? "unknown";
    out.push({
      id: c.id,
      createdAt: c.created_at,
      issue: Number(c.issue_url.split("/").pop()),
      status,
      body: c.body,
    });
  }
  return out;
}

function gh(args: string[], cwd: string): string {
  return execFileSync("gh", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 256,
  });
}

export function fetchQaComments(since: string, cwd: string): QaComment[] {
  const lines = gh(
    [
      "api",
      `repos/{owner}/{repo}/issues/comments?since=${since}T00:00:00Z&per_page=100`,
      "--paginate",
      "--jq",
      '.[] | select(.body | contains("SEQUANT_PHASE")) | {id, created_at, issue_url, body}',
    ],
    cwd,
  )
    .split("\n")
    .filter((l) => l.trim().length > 0);
  return selectQaComments(
    lines.map((l) => JSON.parse(l) as RawComment),
    since,
  );
}

export function fetchIssueAcIds(issue: number, cwd: string): string[] {
  const body = gh(
    ["api", `repos/{owner}/{repo}/issues/${issue}`, "--jq", '.body // ""'],
    cwd,
  );
  return extractAcceptanceCriteria(body).items.map((i) => i.id);
}

interface Tally {
  comments: number;
  acs: number;
  classified: number;
}

export interface CorpusReport extends Tally {
  since: string;
  coverage: number;
  commentsWithoutIssueAcs: number;
  byStatus: Record<string, Tally & { coverage: number }>;
  byParsedStatus: Record<AcStatus, number>;
}

export function measureCorpus(
  comments: QaComment[],
  acIdsFor: (issue: number) => string[],
  since: string,
): CorpusReport {
  const total: Tally = { comments: 0, acs: 0, classified: 0 };
  const byStatus: Record<string, Tally> = {};
  const byParsedStatus: Record<AcStatus, number> = {
    met: 0,
    not_met: 0,
    pending: 0,
    unknown: 0,
  };
  let commentsWithoutIssueAcs = 0;
  for (const c of comments) {
    const ids = acIdsFor(c.issue);
    if (ids.length === 0) commentsWithoutIssueAcs++;
    const parsed = parseAcStatuses(c.body, ids);
    const classified = [...parsed.values()].filter(
      (s) => s !== "unknown",
    ).length;
    for (const s of parsed.values()) byParsedStatus[s]++;
    for (const t of [
      total,
      (byStatus[c.status] ??= { comments: 0, acs: 0, classified: 0 }),
    ]) {
      t.comments++;
      t.acs += ids.length;
      t.classified += classified;
    }
  }
  const ratio = (t: Tally) => (t.acs === 0 ? 0 : t.classified / t.acs);
  return {
    since,
    ...total,
    coverage: ratio(total),
    commentsWithoutIssueAcs,
    byStatus: Object.fromEntries(
      Object.entries(byStatus).map(([k, t]) => [
        k,
        { ...t, coverage: ratio(t) },
      ]),
    ),
    byParsedStatus,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const pct = (n: number) => `${Math.round(n * 100)}%`;

function printFixture(score: FixtureScore): void {
  console.log(
    `Fixture: ${score.fixtures} comments, ${score.acs} labelled ACs, ` +
      `${score.classified} classified`,
  );
  console.log(
    `TP ${score.tp}  FP ${score.fp}  FN ${score.fn}  ` +
      `precision ${pct(score.precision)}  recall ${pct(score.recall)}`,
  );
  for (const m of score.misses) {
    console.log(
      `  ${m.kind.toUpperCase()} ${m.fixture} ${m.id}: expected ${m.expected}, parsed ${m.parsed}`,
    );
  }
}

function printCorpus(r: CorpusReport): void {
  console.log(
    `Corpus since ${r.since}: ${r.comments} QA comments, ${r.acs} issue-body ACs, ` +
      `${r.classified} classified — coverage ${pct(r.coverage)}`,
  );
  console.log(
    `Comments whose issue has no parseable ACs: ${r.commentsWithoutIssueAcs}`,
  );
  for (const [status, t] of Object.entries(r.byStatus)) {
    console.log(
      `  ${status}: ${t.comments} comments, ${t.acs} ACs, ${t.classified} classified (${pct(t.coverage)})`,
    );
  }
}

export function main(argv: string[], cwd: string): number {
  const json = argv.includes("--json");
  const sinceAt = argv.indexOf("--since");
  if (argv.includes("--fixture")) {
    const { expected, readBody } = loadFixture();
    const score = scoreFixture(expected, readBody);
    if (json) console.log(JSON.stringify(score, null, 2));
    else printFixture(score);
    return 0;
  }
  if (sinceAt !== -1) {
    const since = argv[sinceAt + 1];
    if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      console.error("--since needs a date: YYYY-MM-DD");
      return 2;
    }
    const comments = fetchQaComments(since, cwd);
    const cache = new Map<number, string[]>();
    const acIdsFor = (issue: number) => {
      if (!cache.has(issue)) cache.set(issue, fetchIssueAcIds(issue, cwd));
      return cache.get(issue)!;
    };
    const report = measureCorpus(comments, acIdsFor, since);
    if (json) console.log(JSON.stringify(report, null, 2));
    else printCorpus(report);
    return 0;
  }
  console.error(
    "Usage: ac-status-parse-coverage.ts (--since YYYY-MM-DD | --fixture) [--json]",
  );
  return 2;
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = main(process.argv.slice(2), process.cwd());
}
