/**
 * CI gate for `/fullsolve`'s merge gate (issue #958).
 *
 * `/fullsolve` merged PRs to main without human confirmation: the
 * Auto-Progression stop-list said to halt at "final summary after PR
 * creation," but Phase 5.3 ran an unconditional `gh pr merge <N> --squash`
 * immediately after, with `Bash(gh pr merge:*)` allowlisted in frontmatter so
 * no permission prompt caught the mismatch. This is prose with no runtime
 * twin (the runtime `sequant run` path never merges), so these tests assert
 * the skill text itself.
 *
 * Per CLAUDE.md, file-reading gate tests are scoped to the delimited region
 * they mean to check — matching the whole SKILL.md would let an unrelated
 * mention of "merge" elsewhere in the 1000+-line file satisfy an assertion
 * about the merge gate. Every assertion below runs against the extracted
 * `merge-gate` span, the §5.3 section, or a specific bash fence.
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
 * Extract the frontmatter block (between the opening and closing `---`).
 * Throws rather than returning "" so a malformed frontmatter fails loudly
 * instead of silently making the AC-3 assertion vacuous.
 */
function frontmatter(root: string): string {
  const full = skillText(root);
  const match = full.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error(
      `${root}: frontmatter block not found in fullsolve/SKILL.md`,
    );
  }
  return match[1];
}

/**
 * Extract the delimited merge-gate span from the Auto-Progression section.
 * Throws rather than returning "" so a deleted/renamed delimiter fails loudly
 * instead of silently making every assertion below go vacuous.
 */
function mergeGateSpan(root: string): string {
  const full = skillText(root);
  const start = full.indexOf("<!-- BEGIN: merge-gate (#958) -->");
  const end = full.indexOf("<!-- END: merge-gate (#958) -->");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `${root}: merge-gate delimiters not found in fullsolve/SKILL.md`,
    );
  }
  const span = full.slice(start, end);
  if (span.length < 100) {
    throw new Error(
      `${root}: merge-gate span extracted as ${span.length} chars — extractor is broken`,
    );
  }
  return span;
}

/**
 * Extract the §5.3 Merge Workflow section: from its heading up to the next
 * `##`/`###` heading. Throws rather than returning "" so a renamed heading
 * fails loudly instead of silently making every assertion below go vacuous.
 */
function section53(root: string): string {
  const full = skillText(root);
  const start = full.search(/^### 5\.3 Merge Workflow/m);
  if (start === -1) {
    throw new Error(`${root}: §5.3 heading not found in fullsolve/SKILL.md`);
  }
  const rest = full.slice(start);
  const bodyStart = rest.indexOf("\n") + 1;
  const end = rest.slice(bodyStart).search(/^#{2,3} /m);
  const section = end === -1 ? rest : rest.slice(0, bodyStart + end);
  if (section.length < 100) {
    throw new Error(
      `${root}: §5.3 section extracted as ${section.length} chars — extractor is broken`,
    );
  }
  return section;
}

/**
 * Extract the §5.5 Release Concurrency Locks section: from its heading up to
 * the next `##`/`###` heading.
 */
function section55(root: string): string {
  const full = skillText(root);
  const start = full.search(/^### 5\.5 Release Concurrency Locks/m);
  if (start === -1) {
    throw new Error(`${root}: §5.5 heading not found in fullsolve/SKILL.md`);
  }
  const rest = full.slice(start);
  const bodyStart = rest.indexOf("\n") + 1;
  const end = rest.slice(bodyStart).search(/^#{2,3} /m);
  const section = end === -1 ? rest : rest.slice(0, bodyStart + end);
  if (section.length < 100) {
    throw new Error(
      `${root}: §5.5 section extracted as ${section.length} chars — extractor is broken`,
    );
  }
  return section;
}

describe("AC-3: gh pr merge is not in the default allowed-tools grant", () => {
  it.each(SKILL_ROOTS)(
    "%s — frontmatter carries no gh pr merge entry",
    (root) => {
      const fm = frontmatter(root);
      expect(fm).not.toMatch(/Bash\(gh pr merge:\*\)/);
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — other gh pr allowed-tools entries are untouched",
    (root) => {
      // Confirms AC-3 removed exactly the merge grant, not the whole family —
      // a regex broad enough to strip `gh pr merge` could just as easily
      // strip `gh pr create`/`gh pr list`, which the workflow still needs
      // for PR creation and existence checks pre-merge-gate.
      const fm = frontmatter(root);
      expect(fm).toMatch(/Bash\(gh pr create:\*\)/);
      expect(fm).toMatch(/Bash\(gh pr list:\*\)/);
    },
  );
});

describe("AC-2: Auto-Progression and Phase 5 no longer contradict each other", () => {
  it.each(SKILL_ROOTS)(
    "%s — declares PR + final summary as the terminal state, not merge",
    (root) => {
      const span = mergeGateSpan(root);
      expect(span).toMatch(/terminal state/i);
      expect(span).toMatch(/not merged/i);
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — names all three opt-in conditions for the merge phases",
    (root) => {
      const span = mergeGateSpan(root);
      expect(span).toMatch(/--auto-merge/);
      expect(span).toMatch(/run\.autoMerge/);
      expect(span).toMatch(/explicitly instructed/i);
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — a bare /fullsolve invocation does not itself satisfy the gate",
    (root) => {
      const span = mergeGateSpan(root);
      expect(span).toMatch(/invoking `\/fullsolve` alone does not count/i);
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — the stop-list's final-summary entry is marked as the terminal state",
    (root) => {
      const span = mergeGateSpan(root);
      // The original ambiguity: "Final summary after PR creation" read as a
      // pause, not an end state. Pin the disambiguating language.
      expect(span).toMatch(/Final summary after PR creation/);
      expect(span).toMatch(/terminal state.{0,20}not a pause/is);
    },
  );
});

describe("AC-2/AC-4: §5.3 merge workflow is gated, not unconditional", () => {
  it.each(SKILL_ROOTS)("%s — opens with an explicit STOP gate", (root) => {
    const section = section53(root);
    // "Opens with" means directly after the heading, not merely present
    // anywhere in the section — a STOP gate buried after the merge command
    // would already be too late to prevent the unconditional run.
    expect(section).toMatch(/^### 5\.3[^\n]*\n\n\*\*STOP/);
    expect(section).toMatch(/--auto-merge/);
    expect(section).toMatch(/run\.autoMerge/);
  });

  it.each(SKILL_ROOTS)(
    "%s — still contains the merge command for the gated (opt-in) path",
    (root) => {
      // AC-4: the previous end-to-end behavior must be preserved when the
      // gate DOES fire — the merge command itself must survive, just gated.
      const section = section53(root);
      const blocks = bashBlocks(section);
      const mergeBlock = blocks.find((b) => b.includes("gh pr merge"));
      expect(
        mergeBlock,
        "no bash block with gh pr merge in §5.3",
      ).toBeDefined();
      expect(mergeBlock).toMatch(/gh pr merge <N> --squash/);
      expect(mergeBlock).toMatch(/cleanup-worktree\.sh/);
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — the STOP gate precedes the merge command in document order",
    (root) => {
      const section = section53(root);
      const stopIdx = section.indexOf("STOP");
      const mergeIdx = section.indexOf("gh pr merge <N> --squash");
      expect(stopIdx).toBeGreaterThanOrEqual(0);
      expect(mergeIdx).toBeGreaterThan(stopIdx);
    },
  );
});

describe("AC-5: lock-release contract matches the new default flow", () => {
  it.each(SKILL_ROOTS)(
    "%s — Phase 0.3 release contract distinguishes default vs auto-merge path",
    (root) => {
      const full = skillText(root);
      const contractStart = full.indexOf("**Release contract (#958):**");
      expect(
        contractStart,
        "Phase 0.3 release contract (#958) text not found",
      ).toBeGreaterThanOrEqual(0);
      const contract = full.slice(contractStart, contractStart + 700);
      expect(contract).toMatch(/right after §5\.2/);
      expect(contract).toMatch(/Merge Gate.{0,20}fire/is);
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — §5.5 documents the default path releasing after §5.2, not §5.5",
    (root) => {
      const section = section55(root);
      expect(section).toMatch(/Default path/i);
      expect(section).toMatch(/Auto-merge path/i);
      expect(section).toMatch(/immediately after\s*\n?§5\.2/);
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — §5.4 post-merge verification is itself gated on §5.3 having run",
    (root) => {
      const full = skillText(root);
      const start = full.search(/^### 5\.4 Post-Merge Verification/m);
      expect(start, "§5.4 heading not found").toBeGreaterThanOrEqual(0);
      const rest = full.slice(start, start + 300);
      expect(rest).toMatch(/Skip this section if §5\.3 did not run/i);
    },
  );
});

describe("Merge Gate resolution section exists and mirrors Agent Execution Mode", () => {
  it.each(SKILL_ROOTS)(
    "%s — flag, then settings, then default-off, mirroring the parallel/sequential pattern",
    (root) => {
      const full = skillText(root);
      const start = full.search(/^## Merge Gate \(#958\)/m);
      expect(start, "Merge Gate section not found").toBeGreaterThanOrEqual(0);
      const rest = full.slice(start);
      const end = rest.slice(1).search(/^## /m);
      const section = end === -1 ? rest : rest.slice(0, end + 1);

      expect(section).toMatch(/--auto-merge/);
      expect(section).toMatch(/run\.autoMerge \(default: false\)/);
      expect(section).toMatch(/Default:\*\* off/);
      expect(section).toMatch(/#817–#819/);
    },
  );
});
