/**
 * CI gate for `/merger`'s checkout-lock participation (issue #911, AC-1..3, AC-6..8).
 *
 * `/merger` runs branch-mutating git in the MAIN checkout (`git checkout main`,
 * `git checkout -b integrate/…`, `git merge`) but before #911 never claimed the
 * checkout lock (#901): it took no protection and, being a non-holder, was itself
 * refused when another session held the tree. These tests assert the prompt now
 * acquires once before its first guarded verb and releases on every exit path.
 *
 * This is prose with no runtime twin — the lock mechanism (`CheckoutLock`,
 * `sequant locks checkout`, `pre-tool.sh`) is unchanged; only the skill prompt
 * gains participation. So the gate asserts the prompt text, scoped per CLAUDE.md
 * to the delimited region it means to check.
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
    "%s — the acquire fence carries --issue and --skip-pid-check",
    (root) => {
      const fence = bashBlocks(skillText(root)).find((b) =>
        b.includes("locks checkout acquire"),
      );
      expect(fence, "checkout acquire fence not found").toBeDefined();
      expect(fence).toMatch(/--issue=<first-issue>/);
      expect(fence).toMatch(/--skip-pid-check/);
    },
  );

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

describe("#911/AC-2: every checkout release proves ownership with --issue", () => {
  it.each(SKILL_ROOTS)(
    "%s — no `locks checkout release` in a bash block lacks --issue",
    (root) => {
      // Negative over executable content only. NOT anchored on `npx `: a bare
      // `sequant locks checkout release` is just as broken. Scoping to bash
      // fences keeps the inline prose reference (the release-contract note) from
      // reading as an unflagged invocation.
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
    "%s — exactly the expected number of release sites, each on <first-issue>",
    (root) => {
      const release =
        /npx sequant locks checkout release --issue=<first-issue> \|\| true/;
      const releaseBlocks = bashBlocks(skillText(root)).filter((b) =>
        release.test(b),
      );
      expect(releaseBlocks).toHaveLength(EXPECTED_RELEASE_SITES);
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — the regression-gate halt releases before it stops",
    (root) => {
      // The regression `else` branch is a terminal halt that does NOT continue
      // to Step 8, so a leak here wedges the tree after a blocked merge.
      const gate = bashBlocks(skillText(root)).find((b) =>
        b.includes("REGRESSION DETECTED — merge is blocked"),
      );
      expect(gate, "regression-gate halt block not found").toBeDefined();
      expect(gate).toMatch(
        /npx sequant locks checkout release --issue=<first-issue> \|\| true/,
      );
    },
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
