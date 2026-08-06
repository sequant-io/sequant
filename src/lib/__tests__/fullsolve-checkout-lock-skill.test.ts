/**
 * CI gate for `/fullsolve`'s Phase 0.3 lock text (issue #901, AC-6).
 *
 * AC-6 asks that the Phase 0.3 text "states precisely what the per-issue lock
 * does and does not cover, so it no longer reads as a general concurrency
 * guarantee." That is prose with no runtime twin, so these tests assert the
 * text itself.
 *
 * Per CLAUDE.md, file-reading gate tests are scoped to the delimited region
 * they mean to check — matching the whole SKILL.md would let an unrelated
 * mention of "checkout lock" elsewhere in the 900-line file satisfy an
 * assertion about Phase 0.3. Every assertion below runs against the extracted
 * §0.3 span only.
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

/**
 * Anchor to this file's own location, not `process.cwd()`. Under CI the two
 * agree, but a worktree run (`vitest --root <worktree>`) leaves cwd at the main
 * checkout — so a cwd-based read silently asserts against the *other* copy of
 * the repo and reports failures that have nothing to do with the diff.
 * src/lib/__tests__ -> repo root
 */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/**
 * Extract the Phase 0.3 section: from its heading up to the next `##`/`###`
 * heading. Throws rather than returning "" so a renamed heading fails loudly
 * instead of silently making every assertion vacuous.
 */
function phase03(root: string): string {
  const full = fs.readFileSync(
    path.join(REPO_ROOT, root, "fullsolve/SKILL.md"),
    "utf-8",
  );
  const start = full.search(/^### 0\.3 Acquire Concurrency Locks?\b/m);
  if (start === -1) {
    throw new Error(
      `${root}: Phase 0.3 heading not found in fullsolve/SKILL.md`,
    );
  }
  const rest = full.slice(start);
  // Skip past the heading's own line before looking for the next heading —
  // searching from index 1 re-matches this very heading and yields "#".
  const bodyStart = rest.indexOf("\n") + 1;
  const end = rest.slice(bodyStart).search(/^#{2,3} /m);
  const section = end === -1 ? rest : rest.slice(0, bodyStart + end);

  // A section this short means the extractor broke, not that the doc is thin.
  // Fail loudly rather than letting every assertion below go vacuous.
  if (section.length < 200) {
    throw new Error(
      `${root}: Phase 0.3 section extracted as ${section.length} chars — extractor is broken`,
    );
  }
  return section;
}

describe("AC-6: Phase 0.3 states what the per-issue lock does NOT cover", () => {
  it.each(SKILL_ROOTS)(
    "%s — scopes the per-issue lock to the same issue",
    (root) => {
      const section = phase03(root);
      expect(section).toMatch(
        /keyed on the \*issue number\*|keyed on the issue number/,
      );
      expect(section).toMatch(/the same issue/i);
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — explicitly denies being a general concurrency guarantee",
    (root) => {
      const section = phase03(root);
      // The exact miss AC-6 names: a reader taking the old text as covering
      // "another /fullsolve in a different window" generally.
      expect(section).toMatch(/not\*{0,2} a general concurrency guarantee/i);
      expect(section).toMatch(/different issues.*never contend|never contend/i);
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — names the branch-mutating operations the per-issue lock says nothing about",
    (root) => {
      const section = phase03(root);
      for (const verb of [
        "checkout",
        "switch",
        "reset",
        "rebase",
        "merge",
        "cherry-pick",
      ]) {
        expect(section, `missing verb: ${verb}`).toContain(verb);
      }
      expect(section).toMatch(/global to (a|the) checkout/i);
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — points at the checkout lock as the cover",
    (root) => {
      const section = phase03(root);
      expect(section).toContain("locks checkout acquire");
      expect(section).toContain("--issue=");
      expect(section).toMatch(/pre-tool\.sh/);
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — documents stale recovery and the orchestrator no-op",
    (root) => {
      const section = phase03(root);
      expect(section).toContain("SEQUANT_MAX_LOCK_AGE_MS");
      expect(section).toMatch(/SEQUANT_ORCHESTRATOR/);
      expect(section).toMatch(/no-op/i);
    },
  );
});

describe("AC-6: the release contract covers both locks", () => {
  it.each(SKILL_ROOTS)(
    "%s — every abort path releases the checkout lock",
    (root) => {
      const full = fs.readFileSync(
        path.join(REPO_ROOT, root, "fullsolve/SKILL.md"),
        "utf-8",
      );
      const issueReleases = full.match(
        /npx sequant locks release <issue-number> \|\| true/g,
      );
      const checkoutReleases = full.match(
        /npx sequant locks checkout release \|\| true/g,
      );

      // Each per-issue release site must be paired with a checkout release, or
      // an abort path leaks the working tree until the age ceiling expires.
      expect(issueReleases).not.toBeNull();
      expect(checkoutReleases).not.toBeNull();
      expect(checkoutReleases!.length).toBeGreaterThanOrEqual(
        issueReleases!.length,
      );
    },
  );
});
