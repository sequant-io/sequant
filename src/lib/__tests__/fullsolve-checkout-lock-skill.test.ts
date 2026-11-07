/**
 * CI gate for `/fullsolve`'s Phase 0.3 lock text (issue #901, AC-6).
 *
 * AC-6 asks that the Phase 0.3 text "states precisely what the per-issue lock
 * does and does not cover, so it no longer reads as a general concurrency
 * guarantee." That part is prose, so those tests assert the text itself. The
 * lock fences are not prose: the acquire fences and every release site run
 * against the built CLI and a temp lock dir (#1512), so a release that lost
 * `--issue` or its per-issue twin leaves a lock file behind and fails.
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

import { spawnSync, type SpawnSyncReturns } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SKILL_ROOTS } from "../../../scripts/check-skill-sync.js";
import {
  fill,
  skillEnv,
  skillFence,
  skillFences,
  withBuiltCli,
} from "../../../__tests__/helpers/skill-fence.js";

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

/** The fullsolve fences that release the checkout lock, in document order. */
const releaseFences = skillFences("fullsolve", {
  contains: "locks checkout release",
});

let locksDir: string;
beforeEach(() => {
  locksDir = fs.mkdtempSync(path.join(os.tmpdir(), "sequant-fullsolve-lock-"));
});
afterEach(() => fs.rmSync(locksDir, { recursive: true, force: true }));

/** Run a skill fragment with `<issue-number>` filled and the built CLI. */
function runSkill(script: string): SpawnSyncReturns<string> {
  return spawnSync(
    "bash",
    ["-c", withBuiltCli(fill(script, { "<issue-number>": ISSUE }))],
    {
      cwd: locksDir,
      encoding: "utf-8",
      env: skillEnv({ SEQUANT_LOCKS_DIR: locksDir }),
    },
  );
}

const ISSUE = "4242";

describe("AC-6/#906: the Phase 0.3 fences take both locks and every release site frees both", () => {
  it("there are exactly the expected release sites", () => {
    expect(releaseFences).toHaveLength(EXPECTED_RELEASE_SITES);
  });

  it.each(releaseFences.map((fence, i) => [i + 1, fence]))(
    "release site %i frees both locks taken by the Phase 0.3 acquire fences",
    (_n, fence) => {
      const scope = { section: "### 0.3 Acquire Concurrency Lock" };
      for (const contains of [
        "locks acquire <issue-number>",
        "locks checkout acquire",
      ]) {
        const acquire = runSkill(
          skillFence("fullsolve", { ...scope, contains }),
        );
        expect(acquire.status, acquire.stderr).toBe(0);
      }
      // The acquiring shell exits at once, so both locks must be taken with
      // --skip-pid-check or their dead PID makes them stale on the next check.
      for (const file of [`${ISSUE}.lock`, "checkout.lock"]) {
        const lock = JSON.parse(
          fs.readFileSync(path.join(locksDir, file), "utf-8"),
        );
        expect(lock.skipPidCheck, file).toBe(true);
      }

      // Only the release lines: the rest of a site (halt messages, merges)
      // is the surrounding workflow, not the lock contract.
      const releases = String(fence)
        .split("\n")
        .filter((line) => /locks (checkout )?release/.test(line))
        .join("\n");
      const release = runSkill(releases);
      expect(release.status, release.stderr).toBe(0);
      expect(fs.existsSync(path.join(locksDir, `${ISSUE}.lock`))).toBe(false);
      expect(fs.existsSync(path.join(locksDir, "checkout.lock"))).toBe(false);
    },
    20_000,
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
