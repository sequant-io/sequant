#!/usr/bin/env npx tsx
/**
 * QA Precheck CLI — deterministic gap-checks
 *
 * Pre-QA gate that runs scriptable gap-checks before the QA agent is invoked.
 * Emits `.sequant/gap-precheck.json` with structured findings the QA skill
 * consumes via "Phase 0c: Precheck Findings".
 *
 * Three sections (per #609 spec):
 *   - fixtures      — verbatim motivating-example extraction from issue body
 *                     (Section 6d Q1 / Section 6c Step 4)
 *   - siblingGrep   — changed-identifier scan for cross-file sibling sites
 *                     (Section 5)
 *   - acLiteralDiff — AC checkbox IDs in issue body vs PR body
 *                     (Section 1 / AC Literal Verification)
 *
 * Out-of-scope (handled inline in the QA skill via file-glob gating):
 *   - §6c detection-pattern verification (inline conditional cheaper than IPC)
 *   - §6d adversarial re-read (judgment-only)
 *   - §4 Q5 intra-file sibling-line audit (judgment-only)
 *
 * Usage:
 *   npx tsx scripts/qa/precheck.ts --issue <N> [--pr <P>] [--out <path>]
 *
 * Exit code: always 0. Findings live in the JSON; consumers decide gating.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "fail" | "not_applicable";

export interface FixtureRow {
  kind: "fenced" | "blockquote" | "prefix";
  label?: string;
  content: string;
  line: number;
}

export interface FixturesCheck {
  status: CheckStatus;
  count: number;
  fixtures: FixtureRow[];
  note?: string;
}

export interface IdentifierRow {
  name: string;
  definedIn: string;
  siblingSites: string[];
}

export interface SiblingGrepCheck {
  status: CheckStatus;
  identifiers: IdentifierRow[];
  note?: string;
}

export interface AcLiteralDiffCheck {
  status: CheckStatus;
  issueACs: string[];
  prACs: string[];
  missingInPR: string[];
  note?: string;
}

export interface PrecheckResult {
  schemaVersion: 1;
  issue: number | null;
  pr: number | null;
  generatedAt: string;
  checks: {
    fixtures: FixturesCheck;
    siblingGrep: SiblingGrepCheck;
    acLiteralDiff: AcLiteralDiffCheck;
  };
}

// ---------------------------------------------------------------------------
// Fixture extraction (Section 6d Q1 / Section 6c Step 4)
// ---------------------------------------------------------------------------

const EXCLUDED_HEADING_NAMES = new Set([
  "Setup",
  "Install",
  "Installation",
  "Prerequisites",
  "How to install",
]);

const PREFIX_LABELS = [
  "Verify",
  "Verbatim",
  "Example",
  "AC verification",
  "Repro",
];

/**
 * Extract verbatim motivating-example fixtures from an issue body.
 *
 * Three kinds, all explicitly enumerated in qa/SKILL.md §6c Step 4:
 *   - fenced: triple-backtick code blocks NOT under Setup/Install/Prerequisites headings
 *   - blockquote: lines starting with `> `
 *   - prefix: lines beginning with `**Verify:**`, `**Verbatim:**`, `**Example:**`,
 *             `**AC verification:**`, `**Repro:**`
 *
 * Line numbers are 1-based and point at the first content line of the fixture
 * (the line after the opening fence for fenced blocks, the `>` line itself for
 * blockquotes, the `**Label:**` line itself for prefixed lines).
 */
export function extractFixtures(issueBody: string): FixtureRow[] {
  const lines = issueBody.split("\n");
  const fixtures: FixtureRow[] = [];

  // Track current top-level heading to gate fenced extraction.
  let currentHeading = "";
  let inFence = false;
  let fenceStartLine = 0;
  let fenceBuffer: string[] = [];
  // Whether the active fence is under an excluded heading (Setup / Install / etc.)
  let fenceExcluded = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // Track heading; only ## / ### counts as a "section" boundary for gating.
    // (We use a simple "any heading resets the current section" rule.)
    const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (headingMatch && !inFence) {
      currentHeading = headingMatch[1].trim();
    }

    // Fence open/close.
    const fenceMatch = line.match(/^```/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceStartLine = lineNo + 1;
        fenceBuffer = [];
        fenceExcluded = EXCLUDED_HEADING_NAMES.has(currentHeading);
      } else {
        // Close fence — emit if not excluded and not empty.
        const content = fenceBuffer.join("\n").trim();
        if (!fenceExcluded && content.length > 0) {
          fixtures.push({
            kind: "fenced",
            content,
            line: fenceStartLine,
          });
        }
        inFence = false;
        fenceBuffer = [];
        fenceExcluded = false;
      }
      continue;
    }

    if (inFence) {
      fenceBuffer.push(line);
      continue;
    }

    // Blockquote lines.
    if (/^>\s?/.test(line)) {
      const content = line.replace(/^>\s?/, "").trim();
      if (content.length > 0) {
        fixtures.push({ kind: "blockquote", content, line: lineNo });
      }
      continue;
    }

    // Prefix-labelled lines (e.g. `**Verify:** ...`).
    const prefixMatch = line.match(/^\*\*([A-Za-z][A-Za-z ]+):\*\*\s*(.*)$/);
    if (prefixMatch) {
      const label = prefixMatch[1].trim();
      if (PREFIX_LABELS.includes(label)) {
        const content = prefixMatch[2].trim();
        if (content.length > 0) {
          fixtures.push({ kind: "prefix", label, content, line: lineNo });
        }
      }
    }
  }

  return fixtures;
}

// ---------------------------------------------------------------------------
// AC ID extraction (Section 1 / AC Literal Verification)
// ---------------------------------------------------------------------------

/**
 * Extract sorted unique AC IDs (e.g. "AC-1", "AC-12") from arbitrary text.
 *
 * Matches the canonical id form `AC-<digits>` wherever it appears. Whitespace,
 * markdown formatting (`**AC-1**`), checkbox prefix (`- [ ] AC-1`), and table
 * cells (`| AC-1 |`) all parse identically.
 */
export function extractACIDs(text: string): string[] {
  const matches = text.match(/AC-\d+/g) ?? [];
  const seen = new Set(matches);
  return Array.from(seen).sort(compareACID);
}

function compareACID(a: string, b: string): number {
  const na = parseInt(a.slice(3), 10);
  const nb = parseInt(b.slice(3), 10);
  return na - nb;
}

/**
 * Diff issue-body AC IDs against PR-body AC IDs.
 *
 * Returns the literal IDs present in the issue but absent from the PR body.
 * Does NOT compare AC text — that is judgment work for the QA agent. The
 * literal-ID diff is a first-pass tripwire for "PR description forgot to list
 * an AC."
 */
export function diffACIDs(
  issueBody: string,
  prBody: string,
): {
  issueACs: string[];
  prACs: string[];
  missingInPR: string[];
} {
  const issueACs = extractACIDs(issueBody);
  const prACs = extractACIDs(prBody);
  const prSet = new Set(prACs);
  const missingInPR = issueACs.filter((id) => !prSet.has(id));
  return { issueACs, prACs, missingInPR };
}

// ---------------------------------------------------------------------------
// Changed-identifier extraction (Section 5 / cross-file sibling-site)
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff and extract identifiers that were added or modified.
 *
 * Looks for top-level declaration shapes on added (`+`) lines:
 *   - `function foo(`           / `async function foo(`
 *   - `export function foo(`    / `export async function foo(`
 *   - `const foo =`             / `let foo =` / `var foo =`
 *   - `export const foo =`      / `export let foo =`
 *   - `class Foo`               / `export class Foo`
 *   - `interface Foo`           / `export interface Foo`
 *   - `type Foo =`              / `export type Foo =`
 *
 * Excludes:
 *   - Test files (`.test.`, `.spec.`, `__tests__/`)
 *   - Non-source files (skill markdown, docs, scripts/*.sh — anything that
 *     isn't `.ts`/`.tsx`/`.js`/`.jsx`)
 *
 * Returns one row per identifier (deduped) with the file it was extracted from.
 */
export function extractIdentifiersFromDiff(
  diff: string,
): Array<{ name: string; file: string }> {
  const out: Array<{ name: string; file: string }> = [];
  const seen = new Set<string>();

  let currentFile = "";
  let currentFileEligible = false;

  const declRegexes: RegExp[] = [
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/,
    /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
    /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/,
  ];

  const lines = diff.split("\n");
  for (const line of lines) {
    // File header: `+++ b/path/to/file.ts`
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      currentFileEligible = isSourceFile(currentFile);
      continue;
    }

    if (!currentFileEligible) continue;
    if (!line.startsWith("+") || line.startsWith("+++")) continue;

    // Strip the leading `+` and any indentation; declaration must be at the
    // start of the line content (no nested-block decls).
    const content = line.slice(1).trimStart();
    for (const re of declRegexes) {
      const m = content.match(re);
      if (m) {
        const name = m[1];
        const key = `${name}::${currentFile}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ name, file: currentFile });
        }
        break;
      }
    }
  }

  return out;
}

function isSourceFile(file: string): boolean {
  if (/(?:^|\/)__tests__\//.test(file)) return false;
  if (/\.(test|spec)\.[jt]sx?$/.test(file)) return false;
  return /\.[jt]sx?$/.test(file);
}

// ---------------------------------------------------------------------------
// CLI helpers (gh / git) — best-effort, fail-soft
// ---------------------------------------------------------------------------

function safeExec(cmd: string): string | null {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function fetchIssueBody(issue: number): string | null {
  const raw = safeExec(`gh issue view ${issue} --json body -q .body`);
  return raw === null ? null : raw;
}

function fetchPrBody(pr: number): string | null {
  const raw = safeExec(`gh pr view ${pr} --json body -q .body`);
  return raw === null ? null : raw;
}

function fetchCurrentPrNumber(): number | null {
  const raw = safeExec(`gh pr view --json number -q .number`);
  if (raw === null) return null;
  const n = parseInt(raw.trim(), 10);
  return Number.isNaN(n) ? null : n;
}

function fetchDiff(): string | null {
  // origin/main is the canonical comparison base — see
  // feedback_worktree_stale_main.md (local main can drift).
  return safeExec(`git diff origin/main...HEAD --unified=0`);
}

// ---------------------------------------------------------------------------
// Sibling-grep — surface candidate cross-file sites for the QA agent
// ---------------------------------------------------------------------------

/**
 * For each (identifier, definedIn) pair, scan the codebase for other files
 * that reference the identifier and return the file list.
 *
 * The agent then judges materiality — this is candidate surfacing, not
 * verdict input. We exclude test files and the source file itself; the
 * remaining set is what `feedback_sibling_scan_includes_prose.md` calls
 * "candidate sibling sites worth a second look."
 */
export function findSiblingSites(
  identifiers: Array<{ name: string; file: string }>,
  searchRoots: string[] = ["src", "scripts", "bin"],
  maxSitesPerIdentifier = 10,
): IdentifierRow[] {
  const rows: IdentifierRow[] = [];

  for (const { name, file } of identifiers) {
    // Use `git grep -l` for speed and respect for .gitignore. Exclude tests.
    const roots = searchRoots
      .filter((r) => fs.existsSync(r))
      .map((r) => `'${r}'`)
      .join(" ");
    if (!roots) {
      rows.push({ name, definedIn: file, siblingSites: [] });
      continue;
    }
    const word = `\\b${escapeRegex(name)}\\b`;
    const out = safeExec(
      `git grep -lE ${JSON.stringify(word)} -- ${roots} ':(exclude)**/*.test.ts' ':(exclude)**/*.spec.ts' ':(exclude)**/__tests__/**'`,
    );
    const siblings = (out ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l !== file)
      .slice(0, maxSitesPerIdentifier);
    rows.push({ name, definedIn: file, siblingSites: siblings });
  }

  return rows;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Top-level runner
// ---------------------------------------------------------------------------

export interface RunOptions {
  issue: number | null;
  pr: number | null;
  // Optional injected sources (for tests).
  issueBody?: string | null;
  prBody?: string | null;
  diff?: string | null;
  searchRoots?: string[];
}

export function runPrecheck(opts: RunOptions): PrecheckResult {
  const issueBody =
    opts.issueBody !== undefined
      ? opts.issueBody
      : opts.issue !== null
        ? fetchIssueBody(opts.issue)
        : null;

  const prNumber = opts.pr !== null ? opts.pr : fetchCurrentPrNumber();
  const prBody =
    opts.prBody !== undefined
      ? opts.prBody
      : prNumber !== null
        ? fetchPrBody(prNumber)
        : null;

  const diff = opts.diff !== undefined ? opts.diff : fetchDiff();

  // --- fixtures ---
  let fixtures: FixturesCheck;
  if (issueBody === null) {
    fixtures = {
      status: "fail",
      count: 0,
      fixtures: [],
      note: "Issue body unavailable (gh CLI offline / unauth / issue not found)",
    };
  } else {
    const rows = extractFixtures(issueBody);
    fixtures = {
      status: rows.length > 0 ? "pass" : "not_applicable",
      count: rows.length,
      fixtures: rows,
      note:
        rows.length > 0
          ? undefined
          : "No motivating-example payload in issue body",
    };
  }

  // --- siblingGrep ---
  let siblingGrep: SiblingGrepCheck;
  if (diff === null) {
    siblingGrep = {
      status: "fail",
      identifiers: [],
      note: "git diff unavailable (not a git repo, or origin/main missing)",
    };
  } else {
    const idents = extractIdentifiersFromDiff(diff);
    if (idents.length === 0) {
      siblingGrep = {
        status: "not_applicable",
        identifiers: [],
        note: "No source-file declarations changed (docs / config / skill prose only)",
      };
    } else {
      siblingGrep = {
        status: "pass",
        identifiers: findSiblingSites(idents, opts.searchRoots),
      };
    }
  }

  // --- acLiteralDiff ---
  let acLiteralDiff: AcLiteralDiffCheck;
  if (issueBody === null) {
    acLiteralDiff = {
      status: "fail",
      issueACs: [],
      prACs: [],
      missingInPR: [],
      note: "Issue body unavailable",
    };
  } else if (prBody === null) {
    acLiteralDiff = {
      status: "not_applicable",
      issueACs: extractACIDs(issueBody),
      prACs: [],
      missingInPR: [],
      note: "No PR body available (PR not yet created, or gh unavailable)",
    };
  } else {
    const d = diffACIDs(issueBody, prBody);
    acLiteralDiff = {
      status: d.missingInPR.length === 0 ? "pass" : "fail",
      ...d,
    };
  }

  return {
    schemaVersion: 1,
    issue: opts.issue,
    pr: prNumber,
    generatedAt: new Date().toISOString(),
    checks: { fixtures, siblingGrep, acLiteralDiff },
  };
}

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  issue: number | null;
  pr: number | null;
  out: string;
  help: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    issue: null,
    pr: null,
    out: ".sequant/gap-precheck.json",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--issue") {
      args.issue = parseIntStrict(argv[++i]);
    } else if (a === "--pr") {
      args.pr = parseIntStrict(argv[++i]);
    } else if (a === "--out") {
      args.out = argv[++i] ?? args.out;
    }
  }
  return args;
}

function parseIntStrict(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      "QA Precheck — deterministic gap-checks for the QA skill",
      "",
      "Usage:",
      "  npx tsx scripts/qa/precheck.ts --issue <N> [--pr <P>] [--out <path>]",
      "",
      "Options:",
      "  --issue <N>   Issue number (required for fixture extraction + AC diff)",
      "  --pr <P>      PR number (auto-detected via `gh pr view` if omitted)",
      "  --out <path>  Output JSON path (default: .sequant/gap-precheck.json)",
      "  --help        Show this help",
      "",
      "Exit code: always 0. Findings live in the JSON.",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function writeResult(result: PrecheckResult, outPath: string): void {
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const result = runPrecheck({ issue: args.issue, pr: args.pr });
  writeResult(result, args.out);
  // eslint-disable-next-line no-console
  console.log(`Wrote ${args.out}`);
}

// Only run main() when invoked as a CLI, not when imported by tests.
const isMain = (() => {
  try {
    const invoked = process.argv[1];
    if (!invoked) return false;
    const here = new URL(import.meta.url).pathname;
    return path.resolve(invoked) === path.resolve(here);
  } catch {
    return false;
  }
})();

if (isMain) {
  main();
}
