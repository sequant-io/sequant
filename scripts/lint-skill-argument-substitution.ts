#!/usr/bin/env npx tsx
/**
 * Lint SKILL.md bodies for bare positional `$N` tokens.
 *
 * Claude Code substitutes `$0`, `$1`, ... in a skill's text when the skill is
 * invoked with arguments, and fenced code blocks are NOT exempt (reproduced on
 * 2.1.289, #1289): `awk '{ print substr($0, 2) }'` reaches the model as
 * `substr(1249, 2)`. The escape is a single backslash (`\$0`). Shell and awk
 * that needs a bare `$N` belongs in a script file under the skill's `scripts/`.
 *
 * Only SKILL.md is scanned: references and scripts are read as files, not
 * templated.
 *
 * Usage:
 *   npx tsx scripts/lint-skill-argument-substitution.ts
 *
 * Exit codes: 0 no violations, 1 violations found.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { SKILL_ROOTS } from "./check-skill-sync.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface Violation {
  file: string;
  line: number;
  snippet: string;
}

const POSITIONAL_RE = /(?<!\\)\$[0-9]/;

export function findViolations(
  content: string,
): Array<Omit<Violation, "file">> {
  const found: Array<Omit<Violation, "file">> = [];
  content.split("\n").forEach((text, i) => {
    if (POSITIONAL_RE.test(text)) {
      found.push({ line: i + 1, snippet: text.trim().slice(0, 120) });
    }
  });
  return found;
}

export function scanRoots(root: string = PROJECT_ROOT): Violation[] {
  const violations: Violation[] = [];
  for (const dir of SKILL_ROOTS) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const file = join(base, entry.name, "SKILL.md");
      if (!entry.isDirectory() || !existsSync(file)) continue;
      for (const v of findViolations(readFileSync(file, "utf8"))) {
        violations.push({ file: `${dir}/${entry.name}/SKILL.md`, ...v });
      }
    }
  }
  return violations;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const violations = scanRoots();
  if (violations.length === 0) {
    console.log("✅ No bare positional $N in skill bodies");
  } else {
    console.error(
      `❌ ${violations.length} bare positional $N in skill bodies (Claude Code substitutes them; escape as \\$N or move to a script, #1289):`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.snippet}`);
    }
    process.exit(1);
  }
}
