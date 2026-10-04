/**
 * CI gate for `/qa`'s review-dimensions reference (#1135, AC-4).
 *
 * `qa/references/review-dimensions.md` folds in the security and performance
 * bullets of the native `engineering:code-review` rubric — but only the ones
 * `qa/SKILL.md` §2 does not already carry. Prose with no runtime twin, so the
 * assertions run against the skill text, scoped per CLAUDE.md:
 *
 * - the pointer must sit in the `### 2. Code Review` body (up to `### 2a.`),
 *   so a mention in some other section cannot satisfy it;
 * - the "absent from §2" check runs against the whole §2 family
 *   (`### 2. Code Review` up to `### 3. QA vs AC`, i.e. §2 plus §2a–§2h) —
 *   the stricter reading, since §2e already pattern-matches some risks;
 * - checklist items are read only from the reference's `## Security` and
 *   `## Performance` sections, not from its intro prose.
 *
 * All three skill copies are checked so a partial edit fails here even before
 * `lint:skill-sync` runs.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
  collectFiles,
  SKILL_ROOTS,
} from "../../../scripts/check-skill-sync.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const REFERENCE = "qa/references/review-dimensions.md";
const POINTER = "(references/review-dimensions.md)";

/**
 * Read `rel` from each skill root, located through `collectFiles` — the
 * production walker `lint:skill-sync` uses — so a file missing from any copy
 * fails loudly instead of being skipped.
 */
function readFromEachRoot(rel: string): Array<{ root: string; text: string }> {
  return SKILL_ROOTS.map((root) => {
    const base = path.join(REPO_ROOT, root);
    const found = collectFiles(base).find((f) => f === rel);
    if (!found) throw new Error(`${rel} not found under ${root}`);
    return { root, text: fs.readFileSync(path.join(base, found), "utf-8") };
  });
}

/** Slice `text` from `startMarker` up to (not including) `endMarker`. */
function span(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + 1);
  if (start === -1 || end === -1) {
    throw new Error(`span ${startMarker} .. ${endMarker} not found`);
  }
  return text.slice(start, end);
}

/** The `### 2. Code Review` body only (up to `### 2a.`). */
function section2Body(skill: string): string {
  return span(skill, "### 2. Code Review", "### 2a. ");
}

/** The whole §2 family: `### 2. Code Review` through §2h, up to `### 3.`. */
function section2Family(skill: string): string {
  return span(skill, "### 2. Code Review", "### 3. QA vs AC");
}

/** Bold item terms from the reference's Security and Performance sections. */
function checklistTerms(reference: string): string[] {
  const region = span(reference, "## Security", "## Reporting");
  const terms: string[] = [];
  for (const line of region.split("\n")) {
    if (!line.startsWith("- **")) continue;
    const close = line.indexOf("**", 4);
    if (close === -1) continue;
    terms.push(line.slice(4, close));
  }
  return terms;
}

describe("qa review-dimensions reference (AC-4)", () => {
  it("exists in all three skill dirs with identical content", () => {
    const copies = readFromEachRoot(REFERENCE);
    for (const { root, text } of copies) {
      expect(text.length, root).toBeGreaterThan(200);
      expect(text, root).toBe(copies[0].text);
    }
  });

  it("is referenced from the qa/SKILL.md §2 Code Review body", () => {
    for (const { root, text } of readFromEachRoot("qa/SKILL.md")) {
      expect(section2Body(text), root).toContain(POINTER);
    }
  });

  it("carries the security and performance items missing from §2", () => {
    for (const { root, text } of readFromEachRoot(REFERENCE)) {
      const terms = checklistTerms(text).map((t) => t.toLowerCase());
      for (const expected of [
        "xss",
        "csrf",
        "command injection",
        "authentication and authorization flaws",
        "insecure deserialization",
        "path traversal",
        "ssrf",
        "unnecessary allocations",
        "algorithmic complexity in hot paths",
        "missing database indexes",
        "unbounded queries and loops",
        "resource leaks",
      ]) {
        expect(terms, `${root}: ${expected}`).toContain(expected);
      }
    }
  });

  it("contains only items absent from qa/SKILL.md §2", () => {
    const skills = readFromEachRoot("qa/SKILL.md");
    const references = readFromEachRoot(REFERENCE);
    for (let i = 0; i < SKILL_ROOTS.length; i++) {
      const family = section2Family(skills[i].text).toLowerCase();
      const terms = checklistTerms(references[i].text);
      expect(terms.length, SKILL_ROOTS[i]).toBeGreaterThanOrEqual(10);
      for (const term of terms) {
        expect(
          family,
          `${SKILL_ROOTS[i]}: "${term}" already in §2`,
        ).not.toContain(term.toLowerCase());
      }
      // Items §2e already pattern-matches must not be repeated as checklist items.
      const checklist = span(
        references[i].text,
        "## Security",
        "## Reporting",
      ).toLowerCase();
      for (const covered of ["n+1", "hardcoded secret", "sql concatenation"]) {
        expect(family, `${SKILL_ROOTS[i]}: §2 lost "${covered}"`).toContain(
          covered,
        );
        expect(
          checklist,
          `${SKILL_ROOTS[i]}: repeats "${covered}"`,
        ).not.toContain(covered);
      }
    }
  });
});
