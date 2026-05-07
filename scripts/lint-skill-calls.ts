#!/usr/bin/env npx tsx
/**
 * Lint Skill() calls in skill markdown files for unqualified collisions
 * with Anthropic's top-level skill names.
 *
 * Sequant skills that share a name with an Anthropic top-level skill
 * (e.g., `loop`, `security-review`) silently misroute when invoked via the
 * bare name from another sequant skill — the harness resolves the bare name
 * to Anthropic's version. Qualifying as `sequant:<name>` avoids this.
 *
 * Scans every `**\/*.md` under `.claude/skills/`, `templates/skills/`,
 * and `skills/` (not just `SKILL.md`) — referenced markdown files are
 * loaded by the harness too and can contain runtime-dangerous calls.
 * Multi-line `Skill(\n  skill: "...",\n)` invocations are detected.
 *
 * Usage:
 *   npx tsx scripts/lint-skill-calls.ts          # Scan and report
 *
 * Exit codes:
 *   0 - No violations
 *   1 - Violations found
 *
 * Background: #562 (loop misroute), #568 (this guard).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

/**
 * Anthropic top-level skill names that could collide with a sequant skill.
 * Sourced from the `available-skills` block emitted at session start by the
 * Claude Code harness — every name listed here is currently registered as a
 * top-level (non-prefixed) Anthropic skill. Defensive on purpose: includes
 * names sequant doesn't ship today, so the lint catches a future sequant
 * skill that picks the same name. Update when `available-skills` changes —
 * the `/upstream` skill flags Anthropic skill drift.
 */
export const ANTHROPIC_TOP_LEVEL_NAMES: readonly string[] = [
  "loop",
  "security-review",
  "init",
  "review",
  "simplify",
  "schedule",
  "claude-api",
  "update-config",
  "keybindings-help",
  "fewer-permission-prompts",
];

const SCAN_DIRS = [".claude/skills", "templates/skills", "skills"];

export interface Violation {
  file: string;
  line: number;
  name: string;
  snippet: string;
}

// `\s*` between tokens already matches newlines, so this catches both
// `Skill(skill: "loop", ...)` and the multi-line readable form
// `Skill(\n  skill: "loop",\n  ...\n)`. Run against full content (not
// per-line) so multi-line invocations aren't missed.
const SKILL_CALL_RE = /Skill\(\s*skill:\s*"([^"]+)"/g;

function lineNumberAt(content: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) n++;
  return n;
}

export function findViolations(
  content: string,
): Array<Omit<Violation, "file">> {
  const found: Array<Omit<Violation, "file">> = [];
  const lines = content.split("\n");
  SKILL_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SKILL_CALL_RE.exec(content)) !== null) {
    const name = m[1];
    if (name.startsWith("sequant:")) continue;
    if (!ANTHROPIC_TOP_LEVEL_NAMES.includes(name)) continue;
    const line = lineNumberAt(content, m.index);
    found.push({
      line,
      name,
      snippet: lines[line - 1].trim(),
    });
  }
  return found;
}

function walkSkillFiles(baseDir: string): string[] {
  const files: string[] = [];
  if (!existsSync(baseDir)) return files;

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".md")) {
        files.push(full);
      }
    }
  }

  walk(baseDir);
  return files.sort();
}

export interface LintResult {
  scanned: number;
  violations: Violation[];
}

export function lintSkillCalls(projectRoot: string): LintResult {
  const violations: Violation[] = [];
  let scanned = 0;
  for (const rel of SCAN_DIRS) {
    const dir = join(projectRoot, rel);
    const files = walkSkillFiles(dir);
    for (const full of files) {
      scanned++;
      const content = readFileSync(full, "utf-8");
      const found = findViolations(content);
      for (const v of found) {
        violations.push({
          file: relative(projectRoot, full),
          line: v.line,
          name: v.name,
          snippet: v.snippet,
        });
      }
    }
  }
  return { scanned, violations };
}

function printReport(result: LintResult): void {
  console.log(
    `Scanning ${SCAN_DIRS.join(", ")} for unqualified Skill() calls colliding with Anthropic top-level names`,
  );
  console.log(
    `Names: ${ANTHROPIC_TOP_LEVEL_NAMES.map((n) => `"${n}"`).join(", ")}`,
  );
  console.log(`Files scanned: ${result.scanned}`);
  console.log("");

  if (result.violations.length === 0) {
    console.log("No violations.");
    return;
  }

  for (const v of result.violations) {
    console.log(
      `${v.file}:${v.line}: Skill(skill: "${v.name}") collides with Anthropic top-level skill — qualify as "sequant:${v.name}"`,
    );
    console.log(`  ${v.snippet}`);
  }
  console.log("");
  console.log(
    `Found ${result.violations.length} violation(s). Qualify each call as Skill(skill: "sequant:<name>", ...). See #562 / #568.`,
  );
}

// CLI entry — only execute when run directly, not when imported by tests.
const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  const result = lintSkillCalls(PROJECT_ROOT);
  printReport(result);
  process.exit(result.violations.length > 0 ? 1 : 0);
}
