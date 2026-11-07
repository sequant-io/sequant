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
 * The Step 0 fence and every release site run against the built CLI and a
 * temp lock dir (#1512); the placement and the OQ #1 reasoning stay text
 * checks, scoped per CLAUDE.md to the delimited region. The real contention assertion (session A
 * holds, session B's first guarded command is refused) drives the hook and lives
 * in `merger-release-checkout-lock.integration.test.ts`.
 */

import { spawnSync, type SpawnSyncReturns } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SKILL_ROOTS } from "../../../scripts/check-skill-sync.js";
import {
  skillEnv,
  skillFence,
  skillFences,
  withBuiltCli,
} from "../../../__tests__/helpers/skill-fence.js";

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
 * Verification), a mid-release error (Error Handling), and both Rollback
 * Procedures (before-publish, and after-push-before-publish). Pinned as an
 * exact number, not `>=`, so deleting a release site fails the count (the trap
 * #906's test was rewritten to close).
 */
const EXPECTED_RELEASE_SITES = 4;

describe("#911/AC-4: /release acquires the checkout lock once, on the sentinel", () => {
  it.each(SKILL_ROOTS)("%s — exactly one acquire block", (root) => {
    const acquires = bashBlocks(skillText(root)).filter((b) =>
      /npx sequant locks checkout acquire/.test(b),
    );
    expect(acquires).toHaveLength(1);
  });

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

/** The release fences that release the checkout lock, in document order. */
const releaseFences = skillFences("release", {
  contains: "locks checkout release",
});

let locksDir: string;
beforeEach(() => {
  locksDir = fs.mkdtempSync(path.join(os.tmpdir(), "sequant-release-lock-"));
});
afterEach(() => fs.rmSync(locksDir, { recursive: true, force: true }));

function runSkill(script: string): SpawnSyncReturns<string> {
  return spawnSync("bash", ["-c", withBuiltCli(script)], {
    cwd: locksDir,
    encoding: "utf-8",
    env: skillEnv({ SEQUANT_LOCKS_DIR: locksDir }),
  });
}

describe("#911/AC-5: every release site frees the lock the Step 0 fence took", () => {
  it("there are exactly the expected release sites", () => {
    expect(releaseFences).toHaveLength(EXPECTED_RELEASE_SITES);
  });

  it.each(releaseFences.map((fence, i) => [i + 1, fence]))(
    "release site %i releases the checkout lock held on the sentinel",
    (_n, fence) => {
      const acquire = runSkill(
        skillFence("release", {
          section: "### Step 0: Acquire the Checkout Lock",
          contains: "locks checkout acquire",
        }),
      );
      expect(acquire.status, acquire.stderr).toBe(0);
      const lock = JSON.parse(
        fs.readFileSync(path.join(locksDir, "checkout.lock"), "utf-8"),
      );
      expect(lock).toMatchObject({
        issue: Number(SENTINEL),
        skipPidCheck: true,
      });

      // Only the release line: the rest of a site (git reset, git revert,
      // tag deletion) must never run against this checkout.
      const release = runSkill(
        String(fence)
          .split("\n")
          .filter((line) => line.includes("locks checkout release"))
          .join("\n"),
      );
      expect(release.status, release.stderr).toBe(0);
      expect(fs.existsSync(path.join(locksDir, "checkout.lock"))).toBe(false);
    },
    20_000,
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
