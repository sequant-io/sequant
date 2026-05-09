/**
 * Behavior-Rule Detector (issue #552)
 *
 * Shared heuristic for `/spec` (proactive) and `/qa` (reactive) phases that
 * detects when an AC describes a *behavior rule* (e.g. "default becomes X",
 * "always include Y", "never skip Z") and, when triggered, surfaces all
 * touchpoints in the codebase that likely implement the rule.
 *
 * Behavior rules are routinely duplicated across a skill prompt
 * (LLM-interpreted) AND the runtime TypeScript that backs it. Without this
 * detector, edits land at one site and the other goes stale — see issue #533
 * (motivating miss; documented in `references/behavior-rule-detection.md`).
 *
 * Three exported functions:
 * - `detectBehaviorRule` — cheap keyword check; gates the more expensive greps
 * - `findTouchpoints`   — used by `/spec` to enumerate likely implementations
 * - `findSurvivingInverseSymbols` — used by `/qa` to flag OLD-rule survivors
 *   inside the diff blast radius
 *
 * The keyword set is the source of truth in this file (per the /spec Open
 * Question on keyword location). The reference doc cites it.
 *
 * @example
 * ```typescript
 * import { detectBehaviorRule, findTouchpoints } from "./behavior-rule-detector.ts";
 *
 * const detection = detectBehaviorRule(ac);
 * if (detection.triggered) {
 *   const hits = findTouchpoints(ac, process.cwd());
 *   for (const h of hits) console.log(`${h.path}:${h.line}  ${h.snippet}`);
 * }
 * ```
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { AcceptanceCriterion } from "../workflow/state-schema.js";

/**
 * Behavior keywords whose presence (≥2 distinct, OR matching the explicit
 * pattern below) signals an AC describes a rule rather than a localized fix.
 * Tunable here; cited from `references/behavior-rule-detection.md`.
 */
export const BEHAVIOR_KEYWORDS = [
  "default",
  "always",
  "never",
  "rule",
  "behavior",
  "skip",
] as const;

export type BehaviorKeyword = (typeof BEHAVIOR_KEYWORDS)[number];

/**
 * Explicit behavior-rule patterns that trigger detection even with a single
 * keyword (false-positive guard exception). Two families:
 *
 * 1. Mid-sentence rule constructs:
 *    - "always X unless Y", "never X unless Y", "default X when Y"
 * 2. Imperative AC openers — when an AC description begins with a capitalized
 *    `Always` / `Never` / `Default` followed by a verb, it's almost certainly
 *    a behavior rule even with a single keyword. Covers the AC-5 literals
 *    "Always include Y" and "Never skip Z" which #552's prior threshold missed.
 *    Case-sensitive on purpose: matches the imperative-rule register, not
 *    "the system always defaults to..." prose mid-paragraph.
 */
const EXPLICIT_PATTERNS: RegExp[] = [
  /\balways\b[^.]*?\bunless\b/i,
  /\bnever\b[^.]*?\bunless\b/i,
  /\bdefault\b[^.]*?\bwhen\b/i,
  /^\s*Always\s+\w+/,
  /^\s*Never\s+\w+/,
  /^\s*Default\s+\w+/,
];

/**
 * Inverse-keyword map — used by `findSurvivingInverseSymbols` to derive search
 * terms for OLD-rule survivors inside the diff blast radius. Asymmetric on
 * purpose: e.g. an AC asserting the NEW rule "always include spec" should
 * search for "skip" / "exclude" / "bypass" survivors, not "always" itself.
 */
const INVERSE_KEYWORDS: Record<BehaviorKeyword, string[]> = {
  default: ["skip", "exclude", "bypass", "override"],
  always: ["skip", "never", "exclude", "conditional", "shortcut"],
  never: ["always", "default", "include", "auto"],
  rule: ["exception", "override", "shortcut", "bypass"],
  behavior: ["legacy", "old", "previous", "deprecated"],
  skip: ["include", "run", "always", "default"],
};

/** A single touchpoint hit (file location matching a behavior-rule symbol). */
export interface TouchpointHit {
  path: string;
  line: number;
  snippet: string;
}

export interface BehaviorRuleDetection {
  triggered: boolean;
  keywords: BehaviorKeyword[];
  matchedPattern?: string;
}

/**
 * Roots scanned by `findTouchpoints`. Order matters when `TOTAL_CAP` is hit:
 * earlier roots are always represented in the results. `bin/` and
 * `src/commands/` are scanned because CLI option registration (Commander.js
 * `.option()` chains in `bin/cli.ts`, `RunOptions` interface in
 * `src/commands/run.ts`) is a recurring rule-drift site — see the "CLI wiring
 * gap" pitfall called out in this project's CLAUDE.md memory. `templates/skills/`
 * and `skills/` are intentionally omitted — they mirror `.claude/skills/` 1:1
 * and including them would triple-count every hit.
 */
const TOUCHPOINT_ROOTS = ["src/lib", "src/commands", "bin", ".claude/skills"];

const TOUCHPOINT_EXTENSIONS = [".md", ".ts", ".tsx"];

/** Skip these directories when walking — they explode the corpus without value. */
const WALK_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "__tests__",
  "__snapshots__",
]);

/**
 * Detect whether an AC describes a behavior rule.
 *
 * Trigger conditions:
 * 1. ≥2 distinct {@link BEHAVIOR_KEYWORDS} present in the AC description
 *    (case-insensitive, word-boundary match), OR
 * 2. Description matches one of the {@link EXPLICIT_PATTERNS}
 *    (e.g. "always X unless Y").
 *
 * Returns `triggered: false` for empty or undefined descriptions, single
 * keyword matches without an explicit pattern, and file-specific ACs
 * ("Update line 42 of foo.ts").
 */
export function detectBehaviorRule(
  ac: AcceptanceCriterion,
): BehaviorRuleDetection {
  const description = ac?.description ?? "";

  if (!description) {
    return { triggered: false, keywords: [] };
  }

  const matched = new Set<BehaviorKeyword>();
  for (const kw of BEHAVIOR_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, "i");
    if (re.test(description)) matched.add(kw);
  }

  // Explicit pattern overrides the ≥2-keyword threshold (e.g. "always X
  // unless Y" only contains one keyword but is unambiguously a behavior rule).
  for (const re of EXPLICIT_PATTERNS) {
    if (re.test(description)) {
      return {
        triggered: true,
        keywords: [...matched],
        matchedPattern: re.source,
      };
    }
  }

  return {
    triggered: matched.size >= 2,
    keywords: [...matched],
  };
}

/**
 * Find touchpoints in the codebase that likely implement the behavior rule
 * described by `ac`. Returns `[]` when {@link detectBehaviorRule} does not
 * trigger (cheap short-circuit per the /spec performance budget).
 *
 * Heuristic:
 *  - Extract identifier-like symbols from the AC (backticked strings, file
 *    paths with extensions, ALL_CAPS / camelCase / kebab-case identifiers).
 *  - Walk {@link TOUCHPOINT_ROOTS}; for each line in matching files, mark a
 *    hit if the line contains any extracted symbol OR ≥2 distinct AC
 *    behavior keywords.
 *  - Hits are deduplicated by `path:line` and capped (per-file: 3, total: 200)
 *    to keep `/spec` output readable (callers can re-run with a tighter scope
 *    if needed).
 */
export function findTouchpoints(
  ac: AcceptanceCriterion,
  repoRoot: string,
): TouchpointHit[] {
  const detection = detectBehaviorRule(ac);
  if (!detection.triggered) return [];
  if (!repoRoot || !existsSync(repoRoot)) return [];

  const symbols = extractSymbols(ac.description);
  const keywords = detection.keywords;

  const hits: TouchpointHit[] = [];
  const seen = new Set<string>();
  const perFileCount = new Map<string, number>();
  // Caps tuned to keep /spec output readable while ensuring breadth of
  // coverage — a per-file ceiling prevents one chatty file from drowning out
  // the rest of the corpus, and a total ceiling caps the worst case.
  const PER_FILE_CAP = 3;
  const TOTAL_CAP = 200;

  for (const root of TOUCHPOINT_ROOTS) {
    const fullRoot = join(repoRoot, root);
    if (!existsSync(fullRoot)) continue;

    for (const file of walkFiles(fullRoot)) {
      if (!TOUCHPOINT_EXTENSIONS.some((ext) => file.endsWith(ext))) continue;
      // Test files implement *checks* of behavior rules, not the rules
      // themselves. Excluding them keeps `findTouchpoints` focused on the
      // implementation sites a /spec planner needs to enumerate.
      if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file)) continue;

      const content = safeReadFile(file);
      if (!content) continue;

      const relPath = relative(repoRoot, file);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!matchesBehaviorSite(line, symbols, keywords)) continue;

        const key = `${relPath}:${i + 1}`;
        if (seen.has(key)) continue;
        const count = perFileCount.get(relPath) ?? 0;
        if (count >= PER_FILE_CAP) break;
        seen.add(key);
        perFileCount.set(relPath, count + 1);

        hits.push({
          path: relPath,
          line: i + 1,
          snippet: line.trim().slice(0, 200),
        });

        if (hits.length >= TOTAL_CAP) return hits;
      }
    }
  }

  return hits;
}

/**
 * Find OLD-rule survivors inside the diff blast radius. Used by `/qa` to flag
 * an AC `NOT_MET` when the inverse of the asserted rule still has live code.
 *
 * Differs from {@link findTouchpoints}:
 *  - Scope is `diffPaths` (caller is responsible for pre-expanding to 1-hop
 *    importers when desired — this avoids embedding a TS-only importer scanner
 *    here and keeps the function language-agnostic).
 *  - Search terms are *inverse* keywords derived from the AC's keywords (and
 *    inverse English phrasing as a fallback when no symbols match).
 */
export function findSurvivingInverseSymbols(
  ac: AcceptanceCriterion,
  repoRoot: string,
  diffPaths: string[],
): TouchpointHit[] {
  const detection = detectBehaviorRule(ac);
  if (!detection.triggered) return [];
  if (!repoRoot || !existsSync(repoRoot)) return [];
  if (!Array.isArray(diffPaths) || diffPaths.length === 0) return [];

  const inverseTerms = deriveInverseTerms(detection.keywords);
  if (inverseTerms.length === 0) return [];

  const hits: TouchpointHit[] = [];
  const seen = new Set<string>();

  for (const relPath of diffPaths) {
    if (!relPath) continue;
    const fullPath = join(repoRoot, relPath);
    if (!existsSync(fullPath)) continue;

    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (!TOUCHPOINT_EXTENSIONS.some((ext) => fullPath.endsWith(ext))) continue;

    const content = safeReadFile(fullPath);
    if (!content) continue;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!matchesAnyTerm(line, inverseTerms)) continue;

      const key = `${relPath}:${i + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);

      hits.push({
        path: relPath,
        line: i + 1,
        snippet: line.trim().slice(0, 200),
      });

      if (hits.length >= 50) return hits;
    }
  }

  return hits;
}

// ---------- helpers ----------

const SYMBOL_REGEXES: RegExp[] = [
  /`([^`\n]+)`/g, //                backtick-quoted: `spec`, `BUG_LABELS`
  /"([^"\n]{3,})"/g, //             double-quoted phrase
  /\*\*([^*\n]+)\*\*/g, //          bold: **always X unless Y**
  /\b([A-Z][A-Z0-9_]{2,})\b/g, //   SCREAMING_SNAKE: BUG_LABELS, DOCS_LABELS
  /\b([a-z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+){1,})\b/g, // camelCase
  /([a-zA-Z][\w-]*\.(?:ts|tsx|js|jsx|md|json))/g, // file paths
  /([a-z][\w-]+\/[\w./-]+)/g, //    directory paths: src/lib/...
];

function extractSymbols(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const re of SYMBOL_REGEXES) {
    const r = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = r.exec(text)) !== null) {
      const sym = (m[1] || "").trim();
      // Reject common English words and very short tokens.
      if (sym.length < 3) continue;
      if (BEHAVIOR_KEYWORDS.includes(sym.toLowerCase() as BehaviorKeyword))
        continue;
      if (COMMON_WORDS.has(sym.toLowerCase())) continue;
      out.add(sym);
    }
  }
  return [...out];
}

const COMMON_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "into",
  "when",
  "then",
  "than",
  "given",
  "should",
  "becomes",
  "include",
  "exists",
  "true",
  "false",
  "not",
  "yes",
  "no",
  "are",
  "was",
  "but",
  "out",
  "all",
  "any",
  "use",
  "via",
  "etc",
  "issue",
  "code",
  "line",
  "ok",
]);

function matchesBehaviorSite(
  line: string,
  symbols: string[],
  keywords: BehaviorKeyword[],
): boolean {
  if (!line.trim()) return false;
  for (const sym of symbols) {
    if (line.includes(sym)) return true;
  }
  let count = 0;
  for (const kw of keywords) {
    if (new RegExp(`\\b${kw}\\b`, "i").test(line)) {
      count++;
      if (count >= 2) return true;
    }
  }
  return false;
}

function matchesAnyTerm(line: string, terms: string[]): boolean {
  if (!line.trim()) return false;
  for (const t of terms) {
    if (!t) continue;
    if (new RegExp(`\\b${escapeRegex(t)}\\b`, "i").test(line)) return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deriveInverseTerms(keywords: BehaviorKeyword[]): string[] {
  const out = new Set<string>();
  for (const k of keywords) {
    for (const inv of INVERSE_KEYWORDS[k] ?? []) out.add(inv);
  }
  return [...out];
}

function safeReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function* walkFiles(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (WALK_SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walkFiles(full);
    } else if (stat.isFile()) {
      yield full;
    }
  }
}
