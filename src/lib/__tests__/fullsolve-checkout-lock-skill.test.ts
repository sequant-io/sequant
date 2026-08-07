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

function skillText(root: string): string {
  return fs.readFileSync(
    path.join(REPO_ROOT, root, "fullsolve/SKILL.md"),
    "utf-8",
  );
}

/** Bodies of every ```bash fence in the document, in order. */
function bashBlocks(full: string): string[] {
  return [...full.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/**
 * Every early-exit path plus Phase 5.5. Pinned as an exact number on purpose:
 * the previous version of this gate compared two counts (`checkout >= issue`),
 * which stayed green when a release site was deleted — 7 >= 7 passes just as
 * well as 8 >= 7. A count that only ever moves when someone intends it to is
 * the point. Bump this deliberately when a genuine new exit path is added.
 */
const EXPECTED_RELEASE_SITES = 7;

describe("AC-6/#906: every checkout release proves ownership with --issue", () => {
  it.each(SKILL_ROOTS)(
    "%s — no `locks checkout release` anywhere lacks --issue",
    (root) => {
      const full = skillText(root);

      // Whole-file negative. Scoped by construction: it can only ever match
      // the exact command it is about, so an unrelated mention elsewhere in
      // the 900-line document cannot satisfy or break it.
      const missing = [
        ...full.matchAll(/npx sequant locks checkout release(?! --issue=)/g),
      ];
      expect(
        missing,
        `${missing.length} release site(s) without --issue`,
      ).toHaveLength(0);

      // And the command must actually appear — a rename would otherwise make
      // the negative above vacuously true.
      expect(
        full.match(
          /npx sequant locks checkout release --issue=<issue-number> \|\| true/g,
        ),
      ).not.toBeNull();
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — each release bash block releases BOTH locks",
    (root) => {
      const blocks = bashBlocks(skillText(root));

      // Deliberately keeps `|| true` in both patterns: a release that aborts
      // the block on a non-zero exit is a different (and worse) contract, and
      // a laxer regex would stop gating it.
      const checkoutRelease =
        /npx sequant locks checkout release --issue=<issue-number> \|\| true/;
      const issueRelease = /npx sequant locks release <issue-number> \|\| true/;

      const releaseBlocks = blocks.filter((b) => checkoutRelease.test(b));
      expect(releaseBlocks).toHaveLength(EXPECTED_RELEASE_SITES);

      // Pairing is per-block, not per-file: a whole-file count cannot tell a
      // block that releases both locks from two blocks that each release one.
      for (const block of releaseBlocks) {
        expect(
          issueRelease.test(block),
          `checkout released without the per-issue lock in:\n${block}`,
        ).toBe(true);
      }
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — the Phase 5.0 branch gate releases before it exits",
    (root) => {
      // The latest-firing halt path, and the one that had no release at all
      // (#906) — post-fix a leak here wedges the tree for the longest.
      const gate = bashBlocks(skillText(root)).find((b) =>
        b.includes("commits must NOT land on main"),
      );
      expect(
        gate,
        "Phase 5.0 branch verification block not found",
      ).toBeDefined();
      expect(gate).toMatch(
        /npx sequant locks checkout release --issue=<issue-number> \|\| true/,
      );
      expect(gate).toMatch(
        /npx sequant locks release <issue-number> \|\| true/,
      );
    },
  );
});

describe("#906: Phase 0.3 acquires once, unconditionally, with an issue in scope", () => {
  it.each(SKILL_ROOTS)("%s — exactly one per-issue acquire block", (root) => {
    // A literal second acquire halts the session against its own lock:
    // `LockManager` has no reentrancy check. The duplicate this replaces was
    // byte-identical to the first, so a count is the only thing that sees it.
    const acquires = bashBlocks(skillText(root)).filter((b) =>
      /npx sequant locks acquire <issue-number>/.test(b),
    );
    expect(acquires).toHaveLength(1);
  });

  it.each(SKILL_ROOTS)(
    "%s — the acquire fence itself carries --issue",
    (root) => {
      // Scoped to the acquire fence, not the whole §0.3 section: a section-wide
      // `toContain("--issue=")` is satisfied by any release site and so could
      // never gate the acquire it is named for.
      const fence = bashBlocks(skillText(root)).find((b) =>
        b.includes("locks checkout acquire"),
      );
      expect(fence, "checkout acquire fence not found").toBeDefined();
      expect(fence).toMatch(/--issue=<issue-number>/);
      expect(fence).toMatch(/--skip-pid-check/);
    },
  );

  it.each(SKILL_ROOTS)("%s — Phase 0 is declared unconditional", (root) => {
    // Two reviewers read the Smart Resumption table in opposite directions.
    // For an LLM-executed skill that ambiguity IS the defect.
    const section = phase03(root);
    expect(section).toMatch(/Phase 0 always runs/i);
    expect(section).toMatch(/resum/i);
  });

  it.each(SKILL_ROOTS)("%s — exports SEQUANT_ISSUE for the guard", (root) => {
    // Without it the hook's issue fallback never fires interactively and the
    // holder is blocked by its own lock.
    const section = phase03(root);
    expect(section).toMatch(/export SEQUANT_ISSUE=<issue-number>/);
  });

  it.each(SKILL_ROOTS)(
    "%s — does not claim dead-PID recovery for a --skip-pid-check lock",
    (root) => {
      // `--skip-pid-check` disables exactly that branch; claiming it sends a
      // reader looking for a recovery path that cannot fire.
      const section = phase03(root);
      expect(section).not.toMatch(/same-host dead PID, age ceiling/);
      expect(section).toMatch(/SEQUANT_SKILL_LOCK_TTL_MS/);
    },
  );
});
