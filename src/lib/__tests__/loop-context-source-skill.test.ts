/**
 * CI gate for `/loop`'s Step 1A context source (issue #960).
 *
 * `/loop`'s Orchestration Context table said "trust issue context" but Step
 * 1A unconditionally re-fetched QA findings from `gh issue view` — ignoring
 * the `promptContext` block the orchestrator (`ready-gate.ts` /
 * `batch-executor.ts`, via `buildLoopContext`) already embedded into loop's
 * own invocation prompt (`getPhasePrompt`, `src/lib/workflow/phase-executor.ts`).
 * Under `sequant ready`, QA defers GitHub comment-posting to the orchestrator
 * (`qa/SKILL.md` §9), so the fetch found no matching comment and silently
 * fell back to a stale/unrelated comment instead.
 *
 * The fix: `getPhasePrompt` wraps the appended `promptContext` in a
 * `<!-- SEQUANT_PROMPT_CONTEXT -->` / `<!-- /SEQUANT_PROMPT_CONTEXT -->`
 * sentinel pair (see `PROMPT_CONTEXT_SENTINEL`,
 * `src/lib/workflow/phase-executor.ts`, and its own unit tests in
 * `phase-executor.test.ts`), and Step 1A checks for that sentinel in its own
 * invocation before ever fetching from GitHub. This is prose with no runtime
 * twin on the skill side — the skill text is what an agent reads and acts
 * on — so these tests assert the skill text itself.
 *
 * Per CLAUDE.md, file-reading gate tests are scoped to the delimited region
 * they mean to check — matching the whole SKILL.md would let an unrelated
 * mention of "gh issue view" or "SEQUANT_ORCHESTRATOR" elsewhere in the file
 * satisfy an assertion about Step 1A. Every assertion below runs against the
 * extracted `step-1a-context-source` span, the Step 1B span, or the
 * Orchestration Context table.
 *
 * Byte-identical mirroring across the three skill dirs is enforced separately
 * by `npm run lint:skill-sync`; these tests run against all three anyway so a
 * partial edit fails here too.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { PROMPT_CONTEXT_SENTINEL } from "../workflow/phase-executor.js";

const SKILL_ROOTS = [".claude/skills", "skills", "templates/skills"] as const;

/**
 * Sentinel markers as the runtime actually emits them (`getPhasePrompt`).
 * Built from the imported constant, NOT hardcoded literals: if the TS
 * constant's value is ever renamed, these assertions then demand the skill
 * text carry the NEW value — closing the drift hole where a rename passes
 * both suites (unit test uses the constant, skill text still says the old
 * string) while runtime and skill silently diverge (#871-class).
 */
const SENTINEL_OPEN = `<!-- ${PROMPT_CONTEXT_SENTINEL} -->`;
const SENTINEL_CLOSE = `<!-- /${PROMPT_CONTEXT_SENTINEL} -->`;

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
  return fs.readFileSync(path.join(REPO_ROOT, root, "loop/SKILL.md"), "utf-8");
}

/**
 * Extract the delimited Step 1A context-source span. Throws rather than
 * returning "" so a deleted/renamed delimiter fails loudly instead of
 * silently making every assertion below go vacuous.
 */
function step1ASpan(root: string): string {
  const full = skillText(root);
  const start = full.indexOf("<!-- BEGIN: step-1a-context-source (#960) -->");
  const end = full.indexOf("<!-- END: step-1a-context-source (#960) -->");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `${root}: step-1a-context-source delimiters not found in loop/SKILL.md`,
    );
  }
  const span = full.slice(start, end);
  if (span.length < 100) {
    throw new Error(
      `${root}: step-1a-context-source span extracted as ${span.length} chars — extractor is broken`,
    );
  }
  return span;
}

/**
 * Extract the Step 1B (standalone mode) section: from its heading up to the
 * next `####`/`###` heading. AC-3 requires this path to be untouched by the
 * #960 fix, so it is checked as its own span rather than assumed via absence.
 */
function step1BSpan(root: string): string {
  const full = skillText(root);
  const start = full.search(/^#### Step 1B: Standalone Mode/m);
  if (start === -1) {
    throw new Error(`${root}: Step 1B heading not found in loop/SKILL.md`);
  }
  const rest = full.slice(start);
  const bodyStart = rest.indexOf("\n") + 1;
  const end = rest.slice(bodyStart).search(/^#{3,4} /m);
  const section = end === -1 ? rest : rest.slice(0, bodyStart + end);
  if (section.length < 50) {
    throw new Error(
      `${root}: Step 1B section extracted as ${section.length} chars — extractor is broken`,
    );
  }
  return section;
}

/** Extract the "Behavior when orchestrated" list from Orchestration Context. */
function orchestratedBehaviorList(root: string): string {
  const full = skillText(root);
  const start = full.indexOf(
    "**Behavior when orchestrated (SEQUANT_ORCHESTRATOR is set):**",
  );
  const end = full.indexOf(
    "**Behavior when standalone (SEQUANT_ORCHESTRATOR is NOT set):**",
  );
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `${root}: orchestrated-behavior list not found in loop/SKILL.md`,
    );
  }
  return full.slice(start, end);
}

describe("AC-1: Step 1A checks embedded promptContext before fetching GitHub", () => {
  it.each(SKILL_ROOTS)(
    "%s — instructs checking the invocation for the runtime's sentinel first",
    (root) => {
      const span = step1ASpan(root);
      expect(span).toMatch(/Check your own invocation first/i);
      expect(span).toContain(SENTINEL_OPEN);
      expect(span).toContain(SENTINEL_CLOSE);
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — explicitly says not to fetch gh issue view when the sentinel is present",
    (root) => {
      const span = step1ASpan(root);
      expect(span).toMatch(/\*\*Do not\*\* fetch `gh issue view`/);
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — maps the embedded gap list to recommendations and scopes the pre-filter claim",
    (root) => {
      // The embedded block is not QA-comment-shaped, so the section must
      // tell the agent the gap list IS the recommendations (the parsing
      // greps below it extract nothing from the block), and must scope the
      // "already filtered" claim to the gap list only — batch-executor's
      // `Suggestions:`/`Last output:` sections are raw, unfiltered context.
      const span = step1ASpan(root);
      expect(span).toMatch(/gap list IS your `recommendations`/);
      expect(span).toContain("Gaps to address:");
      expect(span).toMatch(/never as additional findings to fix/);
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — the fetch fallback is gated on the sentinel being absent, and still contains the fetch",
    (root) => {
      const span = step1ASpan(root);
      expect(span).toMatch(/Only when the sentinel is absent/i);
      expect(span).toMatch(
        /gh issue view "\$ISSUE_NUMBER" --json comments -q '\.comments\[\] \| select\(\.body \| startswith\("## QA Review for Issue"\)\)/,
      );
    },
  );

  it.each(SKILL_ROOTS)(
    "%s — the sentinel-check instruction precedes the fallback fetch in document order",
    (root) => {
      const span = step1ASpan(root);
      const sentinelIdx = span.indexOf("Check your own invocation first");
      const fetchIdx = span.indexOf('gh issue view "$ISSUE_NUMBER"');
      expect(sentinelIdx).toBeGreaterThanOrEqual(0);
      expect(fetchIdx).toBeGreaterThan(sentinelIdx);
    },
  );
});

describe("Orchestration Context point 4 states the operational rule", () => {
  it.each(SKILL_ROOTS)(
    "%s — 'trust embedded context' names the sentinel and says not to re-fetch",
    (root) => {
      const list = orchestratedBehaviorList(root);
      expect(list).toMatch(/Trust embedded context/i);
      expect(list).toContain(PROMPT_CONTEXT_SENTINEL);
      expect(list).toMatch(/do not re-fetch from GitHub/i);
    },
  );
});

describe("Three-way miss (no sentinel, no GH comment, no log file) hard-errors", () => {
  it.each(SKILL_ROOTS)(
    "%s — names both the embedded-context and GH-comment sources in the miss case",
    (root) => {
      const full = skillText(root);
      const idx = full.indexOf(
        `**If neither an embedded \`${PROMPT_CONTEXT_SENTINEL}\` block nor a matching GitHub QA comment is found in orchestrated mode:**`,
      );
      expect(idx, "three-way-miss note not found").toBeGreaterThanOrEqual(0);
      const note = full.slice(idx, idx + 500);
      expect(note).toMatch(/exit with error/i);
      expect(note).toMatch(/do not silently report/i);
    },
  );
});

describe("AC-3: standalone Step 1B is unaffected by the #960 fix", () => {
  it.each(SKILL_ROOTS)(
    "%s — still reads from the log file, with no sentinel or GitHub-fetch logic",
    (root) => {
      const section = step1BSpan(root);
      expect(section).toMatch(/read from the log file/i);
      expect(section).toMatch(/claude-issue-<issue-number>\.log/);
      expect(section).not.toContain(PROMPT_CONTEXT_SENTINEL);
      expect(section).not.toMatch(/gh issue view/);
    },
  );
});
