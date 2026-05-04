/**
 * Predicted file-collision detection between PROCEED issues.
 *
 * Step 5 of `/assess` already inspects active worktrees for in-flight overlap.
 * This module adds a complementary heuristic: read the bodies of unstarted
 * PROCEED issues and predict which pairs will modify the same file once
 * they're both run in parallel worktrees.
 *
 * The detector scans markdown bodies for file-path mentions outside fenced
 * code blocks and HTML comments, then computes pairwise intersections. A
 * small exclusion list filters paths that nearly every PROCEED issue tends
 * to touch (CHANGELOG.md, lockfiles).
 *
 * Tunables — including the exclusion list, path regex, and the
 * slash-command-skill derivation rule — are documented in
 * `references/predicted-collision-detection.md` so they can change without
 * skill-prose edits.
 */

/**
 * Files that virtually every PROCEED issue mentions. Including them in
 * pairwise intersection would flag every batch as colliding, training
 * users to ignore the warning.
 */
export const EXCLUDED_PATHS: ReadonlySet<string> = new Set([
  "CHANGELOG.md",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

/**
 * Slash-command names recognized as references to a skill's SKILL.md.
 * Used by the slash-command-skill derivation rule when an issue body
 * also signals 3-dir sync — the skill name maps deterministically to the
 * three mirrored SKILL.md files.
 */
const KNOWN_SKILL_NAMES = [
  "assess",
  "spec",
  "exec",
  "qa",
  "test",
  "testgen",
  "verify",
  "loop",
  "merger",
  "security-review",
  "fullsolve",
  "docs",
  "release",
  "clean",
  "improve",
  "reflect",
  "setup",
];

/**
 * Regex matching backtick-quoted file paths under the project's tracked
 * directories. The path component must start with a tracked directory
 * root and end with a known source extension.
 */
const PATH_REGEX =
  /`((?:\.claude|templates|skills|src|bin|docs)\/[A-Za-z0-9_./@-]+\.(?:md|tsx?|json|sh))`/g;

/**
 * Bare-filename match for skill files referenced alongside "3-dir sync"
 * language. Captures e.g. `qa/SKILL.md` so we can expand it to the three
 * skill roots.
 */
const SKILL_FILE_REGEX = /`((?:[a-z][a-z0-9_-]*\/)+SKILL\.md)`/g;

/**
 * Slash-command mention regex (e.g. `/qa`, `/spec`). Captures the name
 * for cross-reference against KNOWN_SKILL_NAMES. The non-word lookahead
 * keeps `/qa-section` from matching as `/qa`.
 */
const SLASH_COMMAND_REGEX = /(?<![\w-])\/([a-z][a-z-]*)(?![\w-])/g;

/**
 * Phrase that signals the cited skill file is mirrored to all three
 * skill-root directories.
 */
const THREE_DIR_SYNC_PATTERN =
  /3[- ]dir(?:ectory)?\s+sync|across\s+all\s+three\s+skill\s+directories|across\s+(?:the\s+)?three\s+skill\s+directories/i;

/**
 * Strip fenced code blocks and HTML comments from a markdown body so the
 * path regex doesn't fire on quoted shell snippets or commented-out drafts.
 *
 * Inline backticks (single ` `) are preserved — the path regex requires a
 * single-backtick wrapper, so this gives us the "paths quoted as code in
 * prose count, paths inside a code block don't" behavior the AC-5 guard
 * specifies.
 */
function stripCodeBlocksAndComments(body: string): string {
  return body.replace(/```[\s\S]*?```/g, "").replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Collapse a fully-qualified skill-mirror path to its canonical bare form.
 *
 * The repo maintains three byte-identical mirrors of every skill file
 * under `.claude/skills/`, `templates/skills/`, and `skills/`. Treating
 * those mirrors as separate paths in collision detection produces 3× the
 * Order: lines and 6× the warnings for one logical conflict, since both
 * sides of the 3-dir-sync expansion match each mirror.
 *
 * Normalizing to the bare subpath (e.g. `qa/SKILL.md`) makes mirrored
 * collisions deduplicate naturally and matches the issue-body shorthand
 * the dashboard's `Order:` annotation already uses.
 */
function normalizeSkillMirrorPath(path: string): string {
  const m = path.match(
    /^(?:\.claude\/skills\/|templates\/skills\/|skills\/)(.+)$/,
  );
  return m ? m[1] : path;
}

/**
 * Extract the set of file paths an issue body identifies as
 * targets-of-modification.
 *
 * Strategy:
 *   1. Strip fenced code blocks and HTML comments (AC-5 guard).
 *   2. Pull every backtick-quoted path matching the source-tree regex,
 *      normalizing skill-mirror paths to their canonical bare form.
 *   3. If the body mentions "3-dir sync", also pull bare
 *      `<name>/SKILL.md` references and `/<skill>` slash-command
 *      mentions (where `<skill>` is in KNOWN_SKILL_NAMES). Both already
 *      live in the canonical bare form.
 *   4. Remove globally excluded paths.
 *
 * The canonical bare form (`qa/SKILL.md`, not `.claude/skills/qa/SKILL.md`)
 * is what the dashboard's `Order:` annotations render, and it makes
 * mirrored collisions deduplicate without a separate post-processing
 * pass.
 */
export function extractPathsFromIssueBody(body: string): Set<string> {
  const paths = new Set<string>();
  const cleaned = stripCodeBlocksAndComments(body);

  for (const m of cleaned.matchAll(PATH_REGEX)) {
    paths.add(normalizeSkillMirrorPath(m[1]));
  }

  const threeDir = THREE_DIR_SYNC_PATTERN.test(cleaned);
  if (threeDir) {
    for (const m of cleaned.matchAll(SKILL_FILE_REGEX)) {
      paths.add(m[1]);
    }
    for (const m of cleaned.matchAll(SLASH_COMMAND_REGEX)) {
      const name = m[1];
      if (KNOWN_SKILL_NAMES.includes(name)) {
        paths.add(`${name}/SKILL.md`);
      }
    }
  }

  for (const excluded of EXCLUDED_PATHS) {
    paths.delete(excluded);
  }

  return paths;
}

/**
 * A predicted file collision: 2+ issues whose bodies both name the same
 * file as a target-of-modification.
 */
export interface CollisionResult {
  /** Issue numbers involved, in ascending order. */
  issues: number[];
  /** Path of the shared file (POSIX-style). */
  file: string;
}

/**
 * Compute file-path overlaps across issue bodies.
 *
 * Each shared file emits one CollisionResult. When N issues all share a
 * file, that's a single result with `issues.length === N` — the caller
 * decides whether to chain-suggest based on count.
 *
 * Sort order: ascending file name, then ascending first-issue number.
 */
export function detectFileCollisions(
  issuePaths: Map<number, Set<string>>,
): CollisionResult[] {
  const fileToIssues = new Map<string, Set<number>>();

  for (const [issueNumber, paths] of issuePaths) {
    for (const file of paths) {
      let bucket = fileToIssues.get(file);
      if (!bucket) {
        bucket = new Set<number>();
        fileToIssues.set(file, bucket);
      }
      bucket.add(issueNumber);
    }
  }

  const results: CollisionResult[] = [];
  for (const [file, issues] of fileToIssues) {
    if (issues.size < 2) continue;
    results.push({
      file,
      issues: [...issues].sort((a, b) => a - b),
    });
  }

  results.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.issues[0] - b.issues[0];
  });

  return results;
}

/**
 * Rendered collision annotations ready for the dashboard output.
 *
 * - `orderLines` — one `Order:` line per pair (or per group).
 * - `warnings` — `⚠ #N  Modifies ... (overlaps #M); land sequentially`,
 *   one per affected issue per collision.
 * - `chainSuggestion` — emitted only when ≥3 issues collide on the same
 *   file (AC-4); suggest-only, never auto-applied.
 */
export interface CollisionAnnotations {
  orderLines: string[];
  warnings: string[];
  chainSuggestion?: string;
}

/**
 * Format collision results as dashboard annotations.
 *
 * - 2-issue collision: `Order: A → B (path)` plus a warning per issue.
 * - 3+-issue collision on the same file: `Order: A → B → C (path)`,
 *   warnings per issue, plus a single `Chain:` suggestion.
 *
 * Multiple shared files between the same pair render as multiple
 * Order: lines (one per file). Callers decide whether to truncate.
 */
export function formatCollisionAnnotations(
  results: CollisionResult[],
): CollisionAnnotations {
  const orderLines: string[] = [];
  const warnings: string[] = [];
  let chainSuggestion: string | undefined;

  for (const r of results) {
    const arrow = r.issues.join(" → ");
    orderLines.push(`Order: ${arrow} (${r.file})`);

    for (const n of r.issues) {
      const others = r.issues.filter((m) => m !== n);
      const overlapStr = others.map((m) => `#${m}`).join(", ");
      warnings.push(
        `⚠ #${n}  Modifies ${r.file} (overlaps ${overlapStr}); land sequentially`,
      );
    }

    if (r.issues.length >= 3 && !chainSuggestion) {
      const ids = r.issues.join(" ");
      chainSuggestion =
        `Chain: npx sequant run ${ids} --chain --qa-gate -q   ` +
        `# alternative — ${r.issues.length} issues modify ${r.file}`;
    }
  }

  return { orderLines, warnings, chainSuggestion };
}
