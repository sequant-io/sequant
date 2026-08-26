/**
 * CI gate for `/merger`'s Named-Set Boundary rule (issue #961, AC-2).
 *
 * #958 fixed `/fullsolve`'s unconditional `gh pr merge` and flagged
 * `/merger/SKILL.md`'s own unconditional `gh pr merge <PR_NUMBER> --squash` as a
 * sibling site, deferring whether `/merger` needs the same gate. #961's audit
 * concluded `/merger`'s named-issue merge itself IS the user's consent (unlike
 * `/fullsolve`'s hidden side effect) — but two silent widen paths existed where
 * dependency ordering or stacked-PR resolution could pull in a `gh pr merge` for
 * an issue the user never named: an out-of-named-set dependency, and an
 * out-of-named-set stack predecessor. The fix adds a "Named-Set Boundary" rule
 * instructing `/merger` to halt and report instead of merging beyond the named
 * set, and threads it through both sections.
 *
 * This is prose with no runtime twin (`/merger` has no TS implementation), so
 * the gate asserts the prompt text, scoped per CLAUDE.md to the delimited
 * `named-set-boundary` region plus the two sections it amends.
 *
 * Byte-identical mirroring across the three skill dirs is enforced separately
 * by `npm run lint:skill-sync`; these tests run against all three anyway so a
 * partial edit fails here too.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const SKILL_ROOTS = [".claude/skills", "skills", "templates/skills"] as const;

/** src/lib/__tests__ -> repo root (anchor to this file, not process.cwd()). */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function skillText(root: string): string {
  return fs.readFileSync(
    path.join(REPO_ROOT, root, "merger/SKILL.md"),
    "utf-8",
  );
}

/**
 * Extract the delimited Named-Set Boundary region. Throws rather than
 * returning "" so a renamed/removed marker fails loudly instead of silently
 * making every assertion vacuous.
 */
function boundarySection(root: string): string {
  const full = skillText(root);
  const start = full.indexOf("<!-- BEGIN: named-set-boundary (#961) -->");
  const end = full.indexOf("<!-- END: named-set-boundary (#961) -->");
  if (start === -1 || end === -1) {
    throw new Error(`${root}: named-set-boundary markers not found`);
  }
  const section = full.slice(start, end);
  if (section.length < 200) {
    throw new Error(
      `${root}: named-set-boundary section extracted as ${section.length} chars — extractor is broken`,
    );
  }
  return section;
}

/** Extract a heading's section: from its heading up to the next `##`/`###`. */
function headingSection(root: string, heading: string): string {
  const full = skillText(root);
  const start = full.indexOf(heading);
  if (start === -1) {
    throw new Error(`${root}: "${heading}" heading not found`);
  }
  const rest = full.slice(start);
  const bodyStart = rest.indexOf("\n") + 1;
  const end = rest.slice(bodyStart).search(/^#{2,3} /m);
  const section = end === -1 ? rest : rest.slice(0, bodyStart + end);
  if (section.length < 100) {
    throw new Error(
      `${root}: "${heading}" section extracted as ${section.length} chars — extractor is broken`,
    );
  }
  return section;
}

describe("#961/AC-2: /merger defines a Named-Set Boundary rule", () => {
  it.each(SKILL_ROOTS)(
    "%s — the boundary section instructs halting on an out-of-named-set merge",
    (root) => {
      const section = boundarySection(root);
      expect(section).toMatch(/halt/i);
      expect(section).toMatch(/named set/i);
      expect(section).toContain("#958");
    },
  );
});

describe("#961/AC-2: Dependency Detection defers to the Named-Set Boundary", () => {
  it.each(SKILL_ROOTS)(
    "%s — the Dependency Detection section references the boundary rule",
    (root) => {
      const section = headingSection(root, "## Dependency Detection");
      // \s+ not a literal space: the phrase wraps across a line in the prose.
      expect(section).toMatch(/Named-Set\s+Boundary/);
      expect(section).toMatch(/halt/i);
    },
  );
});

describe("#961/AC-2: Stacked PR Detection defers to the Named-Set Boundary", () => {
  it.each(SKILL_ROOTS)(
    "%s — the Stacked PR Detection section covers an out-of-named-set predecessor",
    (root) => {
      const section = headingSection(root, "### Stacked PR Detection (#605)");
      expect(section).toMatch(/Named-Set\s+Boundary/);
      expect(section).toMatch(/not.*in the named set/i);
    },
  );
});
