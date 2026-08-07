/**
 * CI gate for `/release`'s checkout-lock participation (issue #911, AC-4..8).
 *
 * `/release` mutates the MAIN checkout (version bump → commit → tag → push, plus
 * a guarded `git reset --soft` on rollback) but before #911 never claimed the
 * checkout lock (#901). The fix sketch's "express the verbs as `git -C` and it
 * needs no lock" does NOT hold — `/release` mutates the main checkout itself,
 * there is no worktree to route through — so `/release` must hold the lock.
 *
 * `/release` has no issue number, and the lock proves ownership by a POSITIVE
 * INTEGER (both `sequant locks checkout` and the numeric-only `pre-tool.sh`
 * guard). The chosen resolution to that fork (OQ #1) is a reserved sentinel id,
 * `999999999`, which works with the existing CLI and hook unchanged — the
 * `--label=release` alternative would require changing the schema, CLI, and hook
 * and is out of scope for this skill-only fix. These tests pin that decision.
 *
 * Prose with no runtime twin — asserted against the prompt text, scoped per
 * CLAUDE.md to the delimited region. The real contention assertion (session A
 * holds, session B's first guarded command is refused) drives the hook and lives
 * in `merger-release-checkout-lock.integration.test.ts`.
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

const SENTINEL = "999999999";

function skillText(root: string): string {
  return fs.readFileSync(
    path.join(REPO_ROOT, root, "release/SKILL.md"),
    "utf-8",
  );
}

/** Bodies of every ```bash fence in the document, in order. */
function bashBlocks(full: string): string[] {
  return [...full.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/** Extract the acquire section (Step 0) up to the next `##`/`###`. */
function acquireSection(root: string): string {
  const full = skillText(root);
  const start = full.search(/^### Step 0: Acquire the Checkout Lock\b/m);
  if (start === -1) {
    throw new Error(`${root}: "Step 0: Acquire the Checkout Lock" not found`);
  }
  const rest = full.slice(start);
  const bodyStart = rest.indexOf("\n") + 1;
  const end = rest.slice(bodyStart).search(/^#{2,3} /m);
  const section = end === -1 ? rest : rest.slice(0, bodyStart + end);
  if (section.length < 200) {
    throw new Error(
      `${root}: acquire section extracted as ${section.length} chars — extractor is broken`,
    );
  }
  return section;
}

/**
 * Every exit path after the Step 0 acquire: happy-path completion (Post-Release
 * Verification), a mid-release error (Error Handling), and the Rollback
 * Procedure. Pinned as an exact number, not `>=`, so deleting a release site
 * fails the count (the trap #906's test was rewritten to close).
 */
const EXPECTED_RELEASE_SITES = 3;

describe("#911/AC-4: /release acquires the checkout lock once, on the sentinel", () => {
  it.each(SKILL_ROOTS)("%s — exactly one acquire block", (root) => {
    const acquires = bashBlocks(skillText(root)).filter((b) =>
      /npx sequant locks checkout acquire/.test(b),
    );
    expect(acquires).toHaveLength(1);
  });

  it.each(SKILL_ROOTS)(
    "%s — the acquire fence uses the sentinel id and --skip-pid-check",
    (root) => {
      const fence = bashBlocks(skillText(root)).find((b) =>
        b.includes("locks checkout acquire"),
      );
      expect(fence, "checkout acquire fence not found").toBeDefined();
      expect(fence).toContain(`--issue=${SENTINEL}`);
      expect(fence).toMatch(/--skip-pid-check/);
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — acquire lands after read-only pre-flight, before the first mutation",
    (root) => {
      const full = skillText(root);
      // Pre-flight (a read-only section) must come before the acquire, and the
      // acquire before the version bump (`npm version`), the first mutation.
      const preflight = full.indexOf("## Pre-flight Checks");
      const acquireAt = full.indexOf("locks checkout acquire");
      // Anchor on the Step 4 heading, not a bare `npm version` (which appears in
      // the allowed-tools frontmatter), so this proves the fence precedes the
      // first mutation, the version bump.
      const bump = full.indexOf("### Step 4: Bump Version");
      expect(preflight).toBeGreaterThan(-1);
      expect(acquireAt).toBeGreaterThan(preflight);
      expect(bump).toBeGreaterThan(acquireAt);
    },
  );
});

describe("#911: OQ #1 resolution (sentinel, not --label) is documented", () => {
  it.each(SKILL_ROOTS)(
    "%s — the acquire section justifies the sentinel and names the rejected alternative",
    (root) => {
      const section = acquireSection(root);
      expect(section).toContain(SENTINEL);
      expect(section).toMatch(/sentinel/i);
      // The rejected alternative is named so a future reader does not "simplify"
      // it back in without knowing the cost (schema + CLI + hook).
      expect(section).toMatch(/--label/);
      // And the reason the fix sketch's `git -C` route does not apply.
      expect(section).toMatch(/positive integer/i);
    },
  );
});

describe("#911/AC-5: every checkout release proves ownership with --issue", () => {
  it.each(SKILL_ROOTS)(
    "%s — no `locks checkout release` in a bash block lacks --issue",
    (root) => {
      const missing = bashBlocks(skillText(root)).flatMap((block) => [
        ...block.matchAll(/\bsequant locks checkout release(?! --issue=)/g),
      ]);
      expect(
        missing,
        `${missing.length} release site(s) without --issue`,
      ).toHaveLength(0);
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — exactly the expected number of release sites, each on the sentinel",
    (root) => {
      const release = new RegExp(
        `npx sequant locks checkout release --issue=${SENTINEL} \\|\\| true`,
      );
      const releaseBlocks = bashBlocks(skillText(root)).filter((b) =>
        release.test(b),
      );
      expect(releaseBlocks).toHaveLength(EXPECTED_RELEASE_SITES);
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — the rollback procedure releases after its guarded git reset",
    (root) => {
      // `git reset --soft` is the one guarded verb in /release; it runs unrefused
      // only while /release holds the lock, so the rollback must hand it back.
      const rollback = bashBlocks(skillText(root)).find(
        (b) => b.includes("git reset --soft") && b.includes("git tag -d"),
      );
      expect(rollback, "rollback procedure block not found").toBeDefined();
      expect(rollback).toContain(
        `npx sequant locks checkout release --issue=${SENTINEL} || true`,
      );
    },
  );
});

describe("#911/AC-6: /release's lock calls are orchestrator-safe", () => {
  it.each(SKILL_ROOTS)(
    "%s — documents the SEQUANT_ORCHESTRATOR no-op",
    (root) => {
      const section = acquireSection(root);
      expect(section).toMatch(/SEQUANT_ORCHESTRATOR/);
      expect(section).toMatch(/no-op/i);
    },
  );
});
