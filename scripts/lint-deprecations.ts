#!/usr/bin/env npx tsx
/**
 * Lint `@deprecated` tags: each one must say `remove in vX.Y` on the same line.
 *
 * Deprecation is a lifecycle stage, not a label — a tag with no removal
 * version schedules nothing. Scans non-test `*.ts` under `src/` and `bin/`.
 * The same-line rule matches the `deprecatedWithoutRemoval` counter in
 * `scripts/qa/health-report.ts`.
 *
 * Usage:
 *   npx tsx scripts/lint-deprecations.ts
 *
 * Exit codes:
 *   0 - Every tag names a removal version
 *   1 - One or more unversioned tags (printed as file:line)
 *
 * Background: #1510.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";

const REMOVAL = /remove in v\d+\.\d+/;

function collect(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") collect(p, out);
    } else if (/\.ts$/.test(e.name) && !/\.test\./.test(e.name)) {
      out.push(p);
    }
  }
}

/** Returns `file:line` for every `@deprecated` line lacking `remove in vX.Y`. */
export function findUnversionedDeprecations(root: string): string[] {
  const files: string[] = [];
  collect(join(root, "src"), files);
  collect(join(root, "bin"), files);
  const violations: string[] = [];
  for (const f of files.sort()) {
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (line.includes("@deprecated") && !REMOVAL.test(line)) {
          violations.push(`${relative(root, f)}:${i + 1}`);
        }
      });
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = findUnversionedDeprecations(root);
  if (violations.length > 0) {
    console.error("@deprecated without 'remove in vX.Y' on the tag line:");
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log("All @deprecated tags name a removal version.");
}
