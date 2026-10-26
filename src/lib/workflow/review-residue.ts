/**
 * Review by exception (#1520): the "Read first" PR comment.
 *
 * Partitions a PR's diff into three sections, residue first:
 *
 * - **Residue** — what nothing vouches for: files no AC's `Evidence:` clause
 *   names, hot files, weakened tests, tautology-detector hits, a diff over
 *   the size budget. The reviewer reads this in full.
 * - **Tests** — each test file with its seam class and whether a
 *   `SEQUANT_MUTATION` record names it.
 * - **Explained** — files an AC's evidence names, with the AC id.
 *
 * Attribution is a parse, not a model (R-2): an AC explains a file only when
 * its evidence clause names the path, as a bare path or as a command
 * argument. Everything else falls to residue. Every residue and test line
 * carries the command that produced it (R-3).
 *
 * This module is pure: {@link buildReviewResidue} and
 * {@link renderReadFirst} take text in and return text out. The git and gh
 * calls live in `review-residue.post.ts`.
 */

import { parseAcceptanceCriteria } from "../ac-parser.js";
import type { MutationMarker } from "./mutation-marker.js";
import { isProseGate } from "../prose-gate.js";

/** First line of the comment; dedup and the outcome script match on it. */
const READ_FIRST_HEADING = "## Read first";

/** Machine marker carried by every Read-first comment. */
const READ_FIRST_MARKER = "SEQUANT_READ_FIRST";

/** A file with this many `fix` commits in the window is hot. */
const HOT_FILE_THRESHOLD = 3;

/** Changed non-test lines above which the diff itself is residue. */
const SIZE_BUDGET_LINES = 400;

/** The window the hot-file count reads. */
export const HOT_FILE_WINDOW = "28.days";

/** Per-file tautology-detector result, as `--json` reports it. */
interface TautologyHit {
  filePath: string;
  totalTests: number;
  tautologicalCount: number;
}

export interface ReviewResidueInput {
  prNumber: number;
  issueNumber: number;
  /** Diff base the commands name (e.g. `origin/main`). */
  base: string;
  /** HEAD the partition was computed at. */
  commit?: string;
  /** `git diff --numstat --no-renames <base>...HEAD`. */
  numstat: string;
  /** Contents of the test files in the diff, keyed by path. */
  testFileSources: Record<string, string>;
  /** The issue body; its `Evidence:` clauses do the attributing. */
  issueBody: string;
  /** `git log --since=28.days --format=%x00%s --name-only`. */
  fixLog: string;
  tautology: TautologyHit[];
  mutationMarkers: MutationMarker[];
}

export type SeamClass = "real" | "mock" | "prose";

interface ResidueLine {
  text: string;
  command: string;
}

interface TestLine {
  path: string;
  seam: SeamClass;
  /** Module specifiers mocked that the project does not own. */
  foreignMocks: string[];
  mutationAc?: string;
  command: string;
}

export interface ReviewResidue {
  residue: ResidueLine[];
  tests: TestLine[];
  explained: { path: string; acs: string[] }[];
}

interface NumstatRow {
  path: string;
  added: number;
  deleted: number;
}

const TEST_PATH_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)__tests__\//;

export function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path);
}

/** Parse `git diff --numstat`; binary rows (`-`) count as zero lines. */
export function parseNumstat(numstat: string): NumstatRow[] {
  const rows: NumstatRow[] = [];
  for (const line of numstat.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3 || !parts[2]) continue;
    rows.push({
      path: parts.slice(2).join("\t").trim(),
      added: Number(parts[0]) || 0,
      deleted: Number(parts[1]) || 0,
    });
  }
  return rows;
}

/** Path-shaped tokens: contain a `/` or end in a file extension. */
const PATH_TOKEN_RE =
  /[\w@.-]*(?:\/[\w@.-]+)+\/?|[\w@-][\w@.-]*\.[A-Za-z][\w]*/g;

/**
 * The paths an evidence clause names, bare or as command arguments. Trailing
 * punctuation is dropped; a token with no `/` and no extension names nothing.
 */
export function evidenceTargets(evidence: string | undefined): string[] {
  if (!evidence) return [];
  const found = new Set<string>();
  for (const match of evidence.matchAll(PATH_TOKEN_RE)) {
    const token = match[0].replace(/^\.\//, "").replace(/[.,;:]+$/, "");
    if (token.includes("/") || /\.[A-Za-z]\w*$/.test(token)) found.add(token);
  }
  return [...found];
}

/** Whether an evidence token names `path`: equal, or a path-suffix match. */
function namesPath(token: string, path: string): boolean {
  if (token.endsWith("/")) return false;
  return path === token || path.endsWith(`/${token}`);
}

/**
 * Map each diff path to the ACs whose evidence names it. A path no AC names
 * is absent from the map (R-2: unattributed is residue).
 */
function attributeFiles(
  issueBody: string,
  paths: string[],
): Map<string, string[]> {
  const byPath = new Map<string, string[]>();
  for (const ac of parseAcceptanceCriteria(issueBody)) {
    const targets = evidenceTargets(ac.evidence);
    for (const path of paths) {
      if (!targets.some((t) => namesPath(t, path))) continue;
      byPath.set(path, [...(byPath.get(path) ?? []), ac.id]);
    }
  }
  return byPath;
}

const FIX_SUBJECT_RE = /^fix(\(|:|!)/;

/** Count `fix` commits per file in a `--format=%x00%s --name-only` log. */
export function countFixCommits(fixLog: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of fixLog.split("\0")) {
    const [subject, ...files] = entry.split("\n");
    if (!subject || !FIX_SUBJECT_RE.test(subject.trim())) continue;
    for (const file of new Set(files.map((f) => f.trim()).filter(Boolean))) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  return counts;
}

const MOCK_CALL_RE = /\b(?:vi|jest)\.(?:mock|doMock)\(\s*["'`]([^"'`]+)["'`]/g;

/** Specifiers resolved inside the project: relative, absolute or `#` aliases. */
function isOwnedSpecifier(spec: string): boolean {
  return /^(\.|\/|#|@\/|src\/)/.test(spec);
}

/** Seam class of a test file from its source. */
export function classifyTestSeam(source: string): {
  seam: SeamClass;
  foreignMocks: string[];
} {
  const mocked = [...source.matchAll(MOCK_CALL_RE)].map((m) => m[1]);
  const foreignMocks = [...new Set(mocked.filter((s) => !isOwnedSpecifier(s)))];
  // #1566's rule: a read of a SKILL.md plus an assertion on it. A mention
  // in a comment, a path string or a message is not a prose gate.
  if (isProseGate(source)) return { seam: "prose", foreignMocks };
  if (mocked.length > 0) return { seam: "mock", foreignMocks };
  return { seam: "real", foreignMocks };
}

/** The test-file path a marker's `failedTest` names (the part before `>`). */
function markerTestPath(marker: MutationMarker): string {
  return marker.failedTest.split(">")[0].trim();
}

function residueLines(
  input: ReviewResidueInput,
  rows: NumstatRow[],
  explained: Map<string, string[]>,
): ResidueLine[] {
  const { base } = input;
  const numstatCmd = (p?: string): string =>
    `git diff --numstat ${base}...HEAD${p ? ` -- ${p}` : ""}`;
  const lines: ResidueLine[] = [];
  for (const row of rows) {
    if (explained.has(row.path)) continue;
    lines.push({
      text: `\`${row.path}\` (+${row.added} −${row.deleted}): no AC's evidence names it`,
      command: numstatCmd(row.path),
    });
  }
  const fixes = countFixCommits(input.fixLog);
  for (const row of rows) {
    const n = fixes.get(row.path) ?? 0;
    if (n < HOT_FILE_THRESHOLD) continue;
    lines.push({
      text: `\`${row.path}\` is hot: ${n} fix commits in 28 days`,
      command: `git log --since=${HOT_FILE_WINDOW} --format=%s -- ${row.path} | grep -cE '^fix(\\(|:|!)'`,
    });
  }
  for (const row of rows) {
    if (!isTestPath(row.path) || row.deleted <= row.added) continue;
    const what = row.added === 0 ? "deleted" : "weakened";
    lines.push({
      text: `\`${row.path}\` test lines ${what}: +${row.added} −${row.deleted}`,
      command: numstatCmd(row.path),
    });
  }
  for (const hit of input.tautology) {
    if (hit.tautologicalCount === 0) continue;
    lines.push({
      text: `\`${hit.filePath}\`: ${hit.tautologicalCount} of ${hit.totalTests} tests call no production code`,
      command: `npx tsx scripts/qa/tautology-detector-cli.ts --json`,
    });
  }
  const size = rows
    .filter((r) => !isTestPath(r.path))
    .reduce((sum, r) => sum + r.added + r.deleted, 0);
  if (size > SIZE_BUDGET_LINES) {
    lines.push({
      text: `${size} changed non-test lines, over the ${SIZE_BUDGET_LINES}-line budget`,
      command: numstatCmd(),
    });
  }
  return lines;
}

/** Compute the partition. Pure: no I/O. */
export function buildReviewResidue(input: ReviewResidueInput): ReviewResidue {
  const rows = parseNumstat(input.numstat);
  const explained = attributeFiles(
    input.issueBody,
    rows.map((r) => r.path),
  );
  const markerByPath = new Map<string, string>();
  for (const m of input.mutationMarkers)
    markerByPath.set(markerTestPath(m), m.ac);

  const tests: TestLine[] = rows
    .filter(
      (r) => isTestPath(r.path) && input.testFileSources[r.path] !== undefined,
    )
    .map((r) => ({
      path: r.path,
      ...classifyTestSeam(input.testFileSources[r.path]),
      mutationAc: markerByPath.get(r.path),
      command: `grep -nE 'vi\\.mock|jest\\.mock|SKILL\\.md' ${r.path}`,
    }));

  return {
    residue: residueLines(input, rows, explained),
    tests,
    explained: [...explained].map(([path, acs]) => ({ path, acs })),
  };
}

function renderTestLine(t: TestLine, prNumber: number): string {
  const foreign =
    t.foreignMocks.length > 0
      ? `; mocks a module the project does not own: ${t.foreignMocks.map((s) => `\`${s}\``).join(", ")}`
      : "";
  const mutation = t.mutationAc
    ? `mutation record: ${t.mutationAc}`
    : "mutation record: none";
  return (
    `- \`${t.path}\`: ${t.seam}${foreign}; ${mutation} — ` +
    `\`${t.command}\`, \`gh pr view ${prNumber} --json body\``
  );
}

/**
 * Render the comment. Order is fixed (R-5): Residue, Tests, Explained, then
 * the link to the AC verdict. Ends with the {@link READ_FIRST_MARKER}.
 */
export function renderReadFirst(
  input: ReviewResidueInput,
  partition: ReviewResidue = buildReviewResidue(input),
): string {
  const { prNumber, issueNumber, base } = input;
  const out: string[] = [
    READ_FIRST_HEADING,
    "",
    "Computed from the diff, the issue's `Evidence:` clauses and `git log`. Nothing here is written by a model.",
    "",
    "## Residue",
    "",
  ];
  if (partition.residue.length === 0) {
    out.push(`- none — \`git diff --numstat ${base}...HEAD\``);
  }
  for (const r of partition.residue) out.push(`- ${r.text} — \`${r.command}\``);
  out.push("", "## Tests", "");
  if (partition.tests.length === 0) {
    out.push(
      `- no test files in the diff — \`git diff --name-only ${base}...HEAD\``,
    );
  }
  for (const t of partition.tests) out.push(renderTestLine(t, prNumber));
  out.push("", "## Explained", "");
  if (partition.explained.length === 0) out.push("- none");
  for (const e of partition.explained) {
    out.push(`- \`${e.path}\` — ${e.acs.join(", ")}`);
  }
  out.push(
    "",
    `AC verdict: the \`SEQUANT_QA_VERDICT\` comment on #${issueNumber}.`,
    "",
    `<!-- ${READ_FIRST_MARKER}: ${JSON.stringify({ pr: prNumber, commit: input.commit ?? null })} -->`,
  );
  return out.join("\n");
}

/** Whether a comment body is a Read-first comment. */
export function isReadFirstComment(body: string): boolean {
  return (
    body.trimStart().startsWith(READ_FIRST_HEADING) ||
    body.includes(`<!-- ${READ_FIRST_MARKER}:`)
  );
}
