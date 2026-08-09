#!/usr/bin/env npx tsx
/**
 * Spec Citation Grounding Check — deterministic existence verification
 *
 * Extracts path-like and symbol-like citations from plan/report text and
 * checks each against the repository. Verifying "does `src/lib/foo.ts` exist"
 * is deterministic, so it is a script, not an LLM prompt (#834, #608).
 *
 * **This is an existence checker, not a grounding-quality checker.** It catches
 * the loud failure — a cited path that does not exist — and is blind to the
 * quiet one: a real path described incorrectly. Do not read its output as a
 * measure of whether a plan understood the code it cites.
 *
 * Extraction over prose produces false positives (#769), so the checker only
 * ever *verifies existence* — side-effect-free and cheap — and never treats a
 * miss as more than a flag. A missing citation is surfaced for adjudication,
 * not failed.
 *
 * Nonexistent is not the same as phantom: a plan that proposes to create
 * `scripts/spec/ground-check.ts` cites a file that correctly does not exist
 * yet. Each citation carries an `intent` (`reference` | `creation`) so the two
 * are counted separately rather than conflated into one misleading rate.
 *
 * Usage:
 *   npx tsx scripts/spec/ground-check.ts --in <file> [--ref <commit>] [--out <path>]
 *   cat plan.md | npx tsx scripts/spec/ground-check.ts
 *
 * Read-only: no writes (except an explicit --out), no network. All repository
 * access goes through `git ls-tree` / `git grep`.
 *
 * Exit code: always 0. Findings live in the JSON; consumers decide gating.
 */

import * as fs from "fs";
import * as nodePath from "path";
import { execFileSync } from "child_process";

// `git` reports POSIX-separated paths on every platform, and every path this
// module manipulates originates from `git` or from citation text that uses `/`.
// Using `path.posix` throughout keeps the logic identical on Windows, where
// `path.join` would otherwise emit `\` and silently break every comparison
// against the tracked-file set.
const path = nodePath.posix;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CitationKind = "path" | "symbol";

/** Whether the text cites something that exists or proposes to create it. */
export type CitationIntent = "reference" | "creation";

export interface Citation {
  /** The citation exactly as written, including any `:LINE` suffix. */
  raw: string;
  kind: CitationKind;
  exists: boolean;
  /** Repo-relative path the citation resolved to, when it resolved. */
  matchedAt?: string;
  /** 1-indexed line of the input text the citation appeared on. */
  line: number;
  intent: CitationIntent;
}

export interface GroundCheckSummary {
  total: number;
  paths: number;
  symbols: number;
  resolved: number;
  /** Missing AND cited as an existing thing — the phantom-citation candidates. */
  missingReferenced: number;
  /** Missing but proposed for creation — expected, not a phantom. */
  missingCreation: number;
}

export interface GroundCheckResult {
  schemaVersion: 1;
  ref: string | null;
  generatedAt: string;
  summary: GroundCheckSummary;
  citations: Citation[];
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Extensions treated as source-tree files. Kept deliberately narrow: a broader
 * list pulls in prose nouns like `node.js` and inflates the denominator with
 * tokens no author meant as a file reference.
 */
const SOURCE_EXTENSIONS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "md",
  "json",
  "sh",
  "yml",
  "yaml",
] as const;

const EXT_ALTERNATION = SOURCE_EXTENSIONS.join("|");

/**
 * A backtick-quoted path: any `/`-joined token ending in a source extension,
 * optionally suffixed with `:LINE` or `:LINE-LINE`. This is the `PATH_REGEX`
 * genus from `src/lib/assess-collision-detect.ts`, widened in two ways the
 * real corpus forced (see `ground-check.test.ts`): the tracked-root anchor is
 * dropped, because root-level files (`package.json`, `CHANGELOG.md`) and bare
 * filenames (`phase-executor.ts`, cited 35× in the corpus) are common and
 * resolvable; and the `:LINE` suffix is matched here rather than left to
 * corrupt the path.
 */
const PATH_CITATION_RE = new RegExp(
  "`([A-Za-z0-9_.@/-]+\\.(?:" + EXT_ALTERNATION + ")(?::\\d+(?:-\\d+)?)?)`",
  "g",
);

/** A backtick-quoted directory reference, e.g. `src/lib/workflow/`. */
const DIR_CITATION_RE = /`([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*\/)`/g;

/** A backtick-quoted bare identifier, optionally with a `()` call suffix. */
const SYMBOL_CITATION_RE = /`([A-Za-z_$][A-Za-z0-9_$]*)(?:\(\))?`/g;

/**
 * Identifier-shaped tokens that are not code symbols in this project's prose:
 * issue labels, workflow phase names, CLI subcommands, and common English.
 * Without this list the symbol denominator fills with `bug` (91×), `test`
 * (63×) and `enhancement` (54×), none of which anyone cited as code.
 */
const SYMBOL_STOPLIST: ReadonlySet<string> = new Set([
  // Issue labels / verdicts
  "bug",
  "enhancement",
  "complex",
  "refactor",
  "breaking",
  "planned",
  "docs",
  "ui",
  "frontend",
  "admin",
  "typo",
  "security",
  "performance",
  "blocked",
  // Phases and subcommands
  "spec",
  "exec",
  "qa",
  "test",
  "testgen",
  "docs",
  "merger",
  "loop",
  "assess",
  "solve",
  "improve",
  "reflect",
  "release",
  "setup",
  "clean",
  "verify",
  "run",
  "ready",
  "init",
  "sync",
  "update",
  "status",
  "logs",
  "locks",
  "worktree",
  // Common prose / build vocabulary
  "main",
  "master",
  "true",
  "false",
  "null",
  "undefined",
  "string",
  "number",
  "boolean",
  "any",
  "void",
  "npm",
  "npx",
  "git",
  "node",
  "gh",
  "jq",
  "sed",
  "grep",
  "awk",
  "cat",
  "echo",
  "yes",
  "no",
  "N",
  "M",
  "X",
  "Y",
]);

/**
 * Verbs that mark the citation on the same line as something the plan intends
 * to create. Anchored to the text *preceding* the citation, so "create
 * `scripts/spec/ground-check.ts`" reads as creation while "the check in
 * `precheck.ts` creates a file" does not.
 */
const CREATION_VERBS =
  "create|creates|created|creating|add|adds|added|adding|new|introduce|introduces|introduced|scaffold|generate|generates|generated|write|writes|rename|renamed|extract|extracted|export|exports|expose|exposes|alias";

/** Creation language immediately preceding the citation on the same line. */
const CREATION_BEFORE_RE = new RegExp(
  `\\b(${CREATION_VERBS}|e\\.g\\.|for example)\\b[^\`]*$`,
  "i",
);

/**
 * Creation language immediately following the citation, for the passive shape
 * that dominates plan prose: "`escalateEffort` added to `RunOptions`".
 */
const CREATION_AFTER_RE = new RegExp(
  `^[^\`]{0,24}\\b(${CREATION_VERBS})\\b`,
  "i",
);

// ---------------------------------------------------------------------------
// Text preparation
// ---------------------------------------------------------------------------

/**
 * Remove fenced code blocks, preserving line count so citation line numbers
 * stay accurate.
 *
 * Fenced blocks in a plan are overwhelmingly *proposed* commands and snippets
 * — `npx tsx scripts/spec/ground-check.ts --in plan.md` cites a file the plan
 * is asking someone to write. Counting those as phantom citations would make
 * the measured rate a function of how many examples an author included, which
 * is not the property being measured. Inline single-backtick spans are kept:
 * that is the form real citations take.
 */
export function stripFences(text: string): string {
  const lines = text.split("\n");
  let inFence = false;
  return lines
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return "";
      }
      return inFence ? "" : line;
    })
    .join("\n");
}

/** Split a `path:LINE` / `path:LINE-LINE` citation into its path component. */
export function stripLineSuffix(raw: string): string {
  return raw.replace(/:\d+(?:-\d+)?$/, "");
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

interface ExtractedCitation {
  raw: string;
  kind: CitationKind;
  line: number;
  intent: CitationIntent;
}

function intentFor(
  lineText: string,
  matchIndex: number,
  matchLength: number,
): CitationIntent {
  const before = lineText.slice(0, matchIndex);
  const after = lineText.slice(matchIndex + matchLength);
  return CREATION_BEFORE_RE.test(before) || CREATION_AFTER_RE.test(after)
    ? "creation"
    : "reference";
}

/**
 * Pull every mechanically-checkable citation out of plan/report text.
 *
 * Deliberately conservative on symbols and permissive on paths: a missed path
 * only lowers coverage, whereas a bogus symbol pollutes the phantom rate with
 * prose the author never meant as a code reference.
 */
export function extractCitations(text: string): ExtractedCitation[] {
  const cleaned = stripFences(text);
  const out: ExtractedCitation[] = [];
  const seen = new Set<string>();

  const lines = cleaned.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    const lineNo = i + 1;

    const push = (
      raw: string,
      kind: CitationKind,
      idx: number,
      len: number,
    ): void => {
      const key = `${kind}:${raw}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        raw,
        kind,
        line: lineNo,
        intent: intentFor(lineText, idx, len),
      });
    };

    for (const m of lineText.matchAll(PATH_CITATION_RE)) {
      push(m[1], "path", m.index ?? 0, m[0].length);
    }
    for (const m of lineText.matchAll(DIR_CITATION_RE)) {
      push(m[1], "path", m.index ?? 0, m[0].length);
    }
    for (const m of lineText.matchAll(SYMBOL_CITATION_RE)) {
      const token = m[1];
      if (isSymbolCandidate(token))
        push(token, "symbol", m.index ?? 0, m[0].length);
    }
  }

  return out;
}

/**
 * Whether a backticked bare token is plausibly a code symbol.
 *
 * Requires positive evidence of code shape — an internal capital (camelCase or
 * PascalCase) or an underscore — rather than merely "is a word in backticks".
 * Single lowercase words in this project's prose are labels and subcommands,
 * not identifiers.
 */
export function isSymbolCandidate(token: string): boolean {
  if (SYMBOL_STOPLIST.has(token) || SYMBOL_STOPLIST.has(token.toLowerCase())) {
    return false;
  }
  if (token.length < 3) return false;
  const hasInternalCapital = /[a-z][A-Z]/.test(token);
  const hasUnderscore = token.includes("_");
  const isPascalCase = /^[A-Z][a-z]/.test(token);
  return hasInternalCapital || hasUnderscore || isPascalCase;
}

// ---------------------------------------------------------------------------
// Repository resolution
// ---------------------------------------------------------------------------

export interface RepoIndex {
  /** Every tracked file path at the ref, POSIX-separated. */
  files: ReadonlySet<string>;
  /** Every directory prefix implied by those files, each with a trailing `/`. */
  dirs: ReadonlySet<string>;
  /** basename -> full paths, for resolving bare-filename citations. */
  byBasename: ReadonlyMap<string, string[]>;
  /**
   * Every proper path suffix -> full paths, for resolving partial-path
   * citations like `commands/ready.ts` (really `src/commands/ready.ts`).
   * Authors routinely elide the leading directories; without this the
   * citation reads as a phantom. Caught on the first real corpus sample,
   * which is why the extractor is validated against captured comments rather
   * than synthetic fixtures (#551/#547).
   */
  bySuffix: ReadonlyMap<string, string[]>;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Build the tracked-path index for a ref (or the working tree when ref is
 * null). One `git ls-tree` per ref, cached by the caller across many inputs.
 */
export function buildRepoIndex(cwd: string, ref: string | null): RepoIndex {
  let raw: string;
  try {
    raw = ref
      ? git(["ls-tree", "-r", "--name-only", ref], cwd)
      : git(["ls-files"], cwd);
  } catch {
    // An unresolvable ref yields an empty index rather than a crash: the
    // caller gets `exists: false` across the board and can see from the
    // summary that the ref was the problem.
    return {
      files: new Set(),
      dirs: new Set(),
      byBasename: new Map(),
      bySuffix: new Map(),
    };
  }

  const files = new Set<string>();
  const dirs = new Set<string>();
  const byBasename = new Map<string, string[]>();
  const bySuffix = new Map<string, string[]>();

  const addTo = (
    map: Map<string, string[]>,
    key: string,
    val: string,
  ): void => {
    const list = map.get(key);
    if (list) list.push(val);
    else map.set(key, [val]);
  };

  for (const line of raw.split("\n")) {
    const file = line.trim();
    if (!file) continue;
    files.add(file);

    addTo(byBasename, path.basename(file), file);

    // Every proper suffix at a segment boundary: `src/commands/ready.ts`
    // registers `commands/ready.ts` and `ready.ts`.
    const segments = file.split("/");
    for (let i = 1; i < segments.length; i++) {
      addTo(bySuffix, segments.slice(i).join("/"), file);
    }

    let dir = path.dirname(file);
    while (dir && dir !== "." && dir !== "/") {
      dirs.add(dir + "/");
      dir = path.dirname(dir);
    }
  }

  return { files, dirs, byBasename, bySuffix };
}

/**
 * Candidate repo paths a citation could mean, most specific first.
 *
 * The skill-mirror expansion is load-bearing: plans cite `qa/SKILL.md` (44× in
 * the corpus) as the canonical name for a file that lives at
 * `.claude/skills/qa/SKILL.md`. Without expansion every such citation reads as
 * a phantom, which would have been the single largest false-positive source in
 * the measurement.
 */
export function candidatePaths(cited: string): string[] {
  const p = stripLineSuffix(cited);
  const candidates = [p];

  // Bare `<skill>/SKILL.md` -> the three mirrors it could name.
  const skillMirror = p.match(/^([a-z][a-z0-9_-]*)\/SKILL\.md$/);
  if (skillMirror) {
    candidates.push(
      `.claude/skills/${skillMirror[1]}/SKILL.md`,
      `templates/skills/${skillMirror[1]}/SKILL.md`,
      `skills/${skillMirror[1]}/SKILL.md`,
    );
  }

  return candidates;
}

/** Resolve one extracted citation against the index. */
export function resolvePath(
  cited: string,
  index: RepoIndex,
): { exists: boolean; matchedAt?: string } {
  const p = stripLineSuffix(cited);

  // Directory citation. Accept an elided leading path the same way files do:
  // `skills/` names a real directory even though it is also a suffix of
  // `.claude/skills/`.
  if (p.endsWith("/")) {
    if (index.dirs.has(p)) return { exists: true, matchedAt: p };
    const bare = p.slice(0, -1);
    for (const dir of index.dirs) {
      if (dir.endsWith(`/${bare}/`)) return { exists: true, matchedAt: dir };
    }
    return { exists: false };
  }

  for (const candidate of candidatePaths(cited)) {
    if (index.files.has(candidate))
      return { exists: true, matchedAt: candidate };
  }

  // Elided-prefix citation: `commands/ready.ts` for `src/commands/ready.ts`.
  // Ambiguity is fine — the question is "does anything by this name exist",
  // not "which one did the author mean".
  const suffixHits = index.bySuffix.get(p);
  if (suffixHits && suffixHits.length > 0) {
    return { exists: true, matchedAt: suffixHits[0] };
  }

  // Bare filename with no directory component.
  if (!p.includes("/")) {
    const hits = index.byBasename.get(p);
    if (hits && hits.length > 0) return { exists: true, matchedAt: hits[0] };
  }

  return { exists: false };
}

/**
 * Resolve a symbol by grepping the tree. Cached per (ref, symbol) by the
 * caller, since the corpus repeats symbols heavily across comments.
 */
export function resolveSymbol(
  symbol: string,
  cwd: string,
  ref: string | null,
): { exists: boolean; matchedAt?: string } {
  const args = ["grep", "-l", "-w", "-F", "--max-count", "1", "-e", symbol];
  if (ref) args.push(ref);
  try {
    const out = git(args, cwd);
    const first = out.split("\n").find((l) => l.trim());
    if (!first) return { exists: false };
    // `git grep <rev>` prefixes hits with `<rev>:`.
    const cleaned =
      ref && first.startsWith(`${ref}:`) ? first.slice(ref.length + 1) : first;
    return { exists: true, matchedAt: cleaned.trim() };
  } catch {
    // git grep exits 1 on "no matches" — that is a clean negative, not an error.
    return { exists: false };
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface GroundCheckOptions {
  text: string;
  cwd?: string;
  ref?: string | null;
  /** Reused across calls so a corpus run pays for `git grep` once per symbol. */
  symbolCache?: Map<string, { exists: boolean; matchedAt?: string }>;
  index?: RepoIndex;
  /** Injected for tests; defaults to the real timestamp. */
  now?: string;
}

export function runGroundCheck(opts: GroundCheckOptions): GroundCheckResult {
  const cwd = opts.cwd ?? process.cwd();
  const ref = opts.ref ?? null;
  const index = opts.index ?? buildRepoIndex(cwd, ref);
  const symbolCache = opts.symbolCache ?? new Map();

  const extracted = extractCitations(opts.text);
  const citations: Citation[] = extracted.map((c) => {
    if (c.kind === "path") {
      const r = resolvePath(c.raw, index);
      return { ...c, exists: r.exists, matchedAt: r.matchedAt };
    }
    const key = `${ref ?? "WT"}:${c.raw}`;
    let r = symbolCache.get(key);
    if (!r) {
      r = resolveSymbol(c.raw, cwd, ref);
      symbolCache.set(key, r);
    }
    return { ...c, exists: r.exists, matchedAt: r.matchedAt };
  });

  return {
    schemaVersion: 1,
    ref,
    generatedAt: opts.now ?? new Date().toISOString(),
    summary: summarize(citations),
    citations,
  };
}

export function summarize(citations: Citation[]): GroundCheckSummary {
  return {
    total: citations.length,
    paths: citations.filter((c) => c.kind === "path").length,
    symbols: citations.filter((c) => c.kind === "symbol").length,
    resolved: citations.filter((c) => c.exists).length,
    missingReferenced: citations.filter(
      (c) => !c.exists && c.intent === "reference",
    ).length,
    missingCreation: citations.filter(
      (c) => !c.exists && c.intent === "creation",
    ).length,
  };
}

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

export interface CliArgs {
  in: string | null;
  out: string | null;
  ref: string | null;
  help: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { in: null, out: null, ref: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--in") args.in = argv[++i] ?? null;
    else if (a === "--out") args.out = argv[++i] ?? null;
    else if (a === "--ref") args.ref = argv[++i] ?? null;
  }
  return args;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      "Spec Citation Grounding Check — deterministic existence verification",
      "",
      "Usage:",
      "  npx tsx scripts/spec/ground-check.ts --in <file> [--ref <commit>] [--out <path>]",
      "  cat plan.md | npx tsx scripts/spec/ground-check.ts",
      "",
      "Options:",
      "  --in <file>     Plan/report text to check (default: stdin)",
      "  --ref <commit>  Check against this commit instead of the working tree",
      "  --out <path>    Write JSON here instead of stdout",
      "  --help          Show this help",
      "",
      "Existence only: a real path described incorrectly still passes.",
      "Exit code: always 0. Findings live in the JSON.",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function readInput(inPath: string | null): string {
  if (inPath) return fs.readFileSync(inPath, "utf-8");
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const result = runGroundCheck({ text: readInput(args.in), ref: args.ref });
  const json = JSON.stringify(result, null, 2) + "\n";
  if (args.out) {
    const dir = nodePath.dirname(args.out);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(args.out, json);
    // eslint-disable-next-line no-console
    console.log(`Wrote ${args.out}`);
  } else {
    process.stdout.write(json);
  }
}

// Only run main() when invoked as a CLI, not when imported by tests.
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
