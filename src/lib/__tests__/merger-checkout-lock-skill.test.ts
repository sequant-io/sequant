/**
 * CI gate for `/merger`'s checkout-lock participation (issue #911, AC-1..3, AC-6..8).
 *
 * `/merger` runs branch-mutating git in the MAIN checkout (`git checkout main`,
 * `git checkout -b integrate/…`, `git merge`) but before #911 never claimed the
 * checkout lock (#901): it took no protection and, being a non-holder, was itself
 * refused when another session held the tree. These tests assert the prompt now
 * acquires once before its first guarded verb and releases on every exit path.
 *
 * The acquire fence and every release site run against the built CLI and a
 * temp lock dir (#1512): a release that names a different holder, or lost
 * `--issue`, is refused and leaves `checkout.lock` behind. The placement and
 * orchestrator claims stay text checks, scoped per CLAUDE.md to their region.
 *
 * The real contention assertion from the issue's Test plan (session A holds,
 * session B's first guarded command is refused) drives the hook and therefore
 * lives in the integration project — see
 * `merger-release-checkout-lock.integration.test.ts`.
 *
 * Byte-identical mirroring across the three skill dirs is enforced separately by
 * `npm run lint:skill-sync`; these tests run against all three anyway so a
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

/** Bodies of every ```bash fence in the document, in order. */
function bashBlocks(full: string): string[] {
  return [...full.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/**
 * Extract the acquire section: from its heading up to the next `##`/`###`.
 * Throws rather than returning "" so a renamed heading fails loudly instead of
 * silently making every assertion vacuous.
 */
function acquireSection(root: string): string {
  const full = skillText(root);
  const start = full.search(/^### Acquire the Checkout Lock\b/m);
  if (start === -1) {
    throw new Error(`${root}: "Acquire the Checkout Lock" heading not found`);
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
 * Every exit path: happy-path completion (Step 8), the regression-gate halt
 * (Step 7), and the "Error Handling" failure exit. Pinned as an exact number, not
 * `>=`: a `>=` stays green when a release site is deleted (the trap #906's test
 * was rewritten to close). Bump this deliberately when a genuine new exit path
 * is added.
 */
const EXPECTED_RELEASE_SITES = 3;

describe("#911/AC-1: /merger acquires the checkout lock before its first guarded verb", () => {
  it.each(SKILL_ROOTS)("%s — exactly one acquire block", (root) => {
    // A literal second acquire is not a reentrancy problem for the checkout lock
    // (it is idempotent), but two acquires means two identities can drift; the
    // count is what catches a stray copy.
    const acquires = bashBlocks(skillText(root)).filter((b) =>
      /npx sequant locks checkout acquire/.test(b),
    );
    expect(acquires).toHaveLength(1);
  });

  it.each(SKILL_ROOTS)(
    "%s — the acquire precedes the baseline `git checkout main`",
    (root) => {
      const full = skillText(root);
      const acquireAt = full.indexOf("locks checkout acquire");
      // Anchor on the Step 0 heading, not a bare `git checkout main` (which the
      // acquire prose also mentions), so this proves the fence precedes the
      // section that actually runs the first guarded verb.
      const baselineStep = full.indexOf("### Step 0: Baseline Capture");
      expect(acquireAt).toBeGreaterThan(-1);
      expect(baselineStep).toBeGreaterThan(-1);
      expect(acquireAt).toBeLessThan(baselineStep);
    },
  );
});

describe("#911/AC-3: acquire/release name the same holder (first issue)", () => {
  it.each(SKILL_ROOTS)(
    "%s — the acquire section explains the first-issue identity choice",
    (root) => {
      const section = acquireSection(root);
      // \s+ not a literal space: the phrase wraps across a line in the prose.
      expect(section).toMatch(/first issue\s+number/i);
      expect(section).toContain("#906");
    },
  );
});

const FIRST_ISSUE = "4242";

/** The merger fences that release the checkout lock, in document order. */
const releaseFences = skillFences("merger", {
  contains: "locks checkout release",
});

let locksDir: string;
beforeEach(() => {
  locksDir = fs.mkdtempSync(path.join(os.tmpdir(), "sequant-merger-lock-"));
});
afterEach(() => fs.rmSync(locksDir, { recursive: true, force: true }));

function runSkill(script: string): SpawnSyncReturns<string> {
  return spawnSync("bash", ["-c", withBuiltCli(script)], {
    cwd: locksDir,
    encoding: "utf-8",
    env: skillEnv({ SEQUANT_LOCKS_DIR: locksDir }),
  });
}

describe("#911/AC-2: every release site frees the lock the acquire fence took", () => {
  it("there are exactly the expected release sites", () => {
    expect(releaseFences).toHaveLength(EXPECTED_RELEASE_SITES);
  });

  it.each(releaseFences.map((fence, i) => [i + 1, fence]))(
    "release site %i releases the checkout lock held under <first-issue>",
    (_n, fence) => {
      const acquire = runSkill(
        fill(
          skillFence("merger", {
            section: "### Acquire the Checkout Lock",
            contains: "locks checkout acquire",
          }),
          {
            "<first-issue>": FIRST_ISSUE,
            "<issue-numbers>": `${FIRST_ISSUE} 4243`,
          },
        ),
      );
      expect(acquire.status, acquire.stderr).toBe(0);
      const lock = JSON.parse(
        fs.readFileSync(path.join(locksDir, "checkout.lock"), "utf-8"),
      );
      expect(lock).toMatchObject({
        issue: Number(FIRST_ISSUE),
        skipPidCheck: true,
      });

      // Only the release line: the rest of a site (the regression halt, the
      // summary) is the surrounding workflow, not the lock contract.
      const release = runSkill(
        fill(
          String(fence)
            .split("\n")
            .filter((line) => line.includes("locks checkout release"))
            .join("\n"),
          { "<first-issue>": FIRST_ISSUE },
        ),
      );
      expect(release.status, release.stderr).toBe(0);
      expect(fs.existsSync(path.join(locksDir, "checkout.lock"))).toBe(false);
    },
    20_000,
  );
});

describe("#911/AC-6: /merger's lock calls are orchestrator-safe", () => {
  it.each(SKILL_ROOTS)(
    "%s — documents the SEQUANT_ORCHESTRATOR no-op",
    (root) => {
      const section = acquireSection(root);
      expect(section).toMatch(/SEQUANT_ORCHESTRATOR/);
      expect(section).toMatch(/no-op/i);
    },
  );
});
