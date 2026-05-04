/**
 * Tests for predicted-collision detection on PROCEED issues (#556).
 *
 * Fixtures use the verbatim bodies of #551 and #552 — the issues that
 * motivated this feature. They both touch `qa/SKILL.md` (#552 names it
 * directly; #551 implies it via `/qa` slash-command + 3-dir-sync language).
 *
 * Verbatim issue bodies are required by AC-6: synthetic fixtures hide
 * detection gaps that real issue prose surfaces.
 */
import { describe, expect, it } from "vitest";
import {
  EXCLUDED_PATHS,
  detectFileCollisions,
  extractPathsFromIssueBody,
  formatCollisionAnnotations,
} from "../assess-collision-detect.ts";

// ─── Verbatim issue body fixtures ───────────────────────────────────────────

const ISSUE_551_BODY = `## Summary

Three real bugs shipped through \`/qa\` in PR #547 (issue #529, manual-test AC enforcement) before user-driven adversarial review surfaced them. The structured \`/qa\` pipeline marked all 6 ACs MET and verdict \`READY_FOR_MERGE\` on its first two passes — and would have stuck at that verdict without "any gaps?" prompting:

1. The jq filter \`select(contains("SEQUANT_PHASE") and contains("spec"))\` matched **5 unrelated comments** on the issue itself; \`.last\` returned a QA comment instead of the spec plan
2. The awk header regex \`/^### AC-[0-9]+/\` only matched 3-hash headers, missing \`#### AC-N\` and \`**AC-N:**\` styles (~45% of sampled past specs)
3. The grep regex didn't include \`**Verify:**\` as a prefix — even though the issue body's verbatim motivating example used that exact prefix

Each bug was a 30-second diagnostic once the patterns were piped through real corpus. None showed up in static review of the diff against AC text because every pattern was syntactically valid and matched the AC description in the abstract.

## Motivation

Prompt-only skill changes (regex / grep / awk / jq inside SKILL.md) have **no automated test coverage**. The only way to verify they actually work is to run them against real input. Today's \`/qa\` Section 6a (Skill Command Verification) covers \`gh\` CLI commands but not detection patterns — it checks whether \`gh pr checks --json conclusion\` is valid syntax, not whether \`awk '/^### AC-[0-9]+/'\` actually matches real spec headers.

Captured as feedback memories: \`feedback_dogfood_detection_patterns.md\` and \`feedback_motivating_example_regression.md\`.

## Acceptance Criteria

- [ ] AC-1: New \`/qa\` section "Detection Pattern Verification" triggers when diff contains new or modified \`grep\`, \`awk\`, \`jq\`, \`sed\`, or regex literals inside \`.claude/skills/**/*.md\`, \`skills/**/*.md\`, or \`templates/skills/**/*.md\`
- [ ] AC-2: For each detected pattern, QA must (a) identify the intended corpus, (b) sample ≥5 real instances, (c) execute the pattern against each, (d) record match/no-match counts in the QA output table
- [ ] AC-3: Snippets quoted in the issue body **as motivating examples or AC verification targets** (verbatim spec excerpts, blockquoted user inputs, \`**bold:**\`-prefixed examples) are treated as mandatory test fixtures — the new pattern must produce the AC-claimed result on each. Unrelated code blocks (e.g., setup commands) are excluded.
- [ ] AC-4: Verdict gate: if any pattern produces 0 matches against input the AC says should match, → \`AC_NOT_MET\` (cannot be \`READY_FOR_MERGE\`). If verification status = "Failed", maximum verdict is \`AC_NOT_MET\`.
- [ ] AC-5: Add adversarial re-read checkbox to \`/qa\` Output Verification: \`[ ] Adversarial re-read of core logic — list anything the structured pipeline didn't surface\`
- [ ] AC-6: Update SKILL.md across all three skill directories (\`.claude/skills/\`, \`templates/skills/\`, \`skills/\`)
- [ ] AC-7: Update \`CHANGELOG.md\` under [Unreleased]

## Additional context

- Found via \`/reflect\` after PR #547 merge. See merge commits \`bc3bb931\` (#531) and \`6a36f06a\` (#529).
- Section 6a (Skill Command Verification) is the closest existing analog — covers shell command syntax but not pattern matching against real input. Position the new section as 2j or 6c depending on placement preference.
- The three bugs would all have been caught by AC-2 (corpus sampling) alone. AC-3 (motivating-example fixture) is belt-and-suspenders.
- High-priority correctness gap — silent detection failures are the worst kind because the pipeline reports success.

## Complexity

complex (quality loop) — skill logic + 3-dir sync + design of corpus-sampling protocol
`;

const ISSUE_552_BODY = `## Summary

When an issue's AC describes a **behavior rule** (e.g. "default becomes X", "always include Y", "never skip Z"), the rule is often implemented at multiple touchpoints — typically a skill prompt (LLM-interpreted) **and** runtime TypeScript code that duplicates the rule. Today, neither \`/spec\` nor \`/qa\` surfaces this duplication, so PRs frequently land with the skill updated and the runtime stale (or vice versa).

This issue adds a **shared detection heuristic** used in both phases:

- **\`/spec\`** runs it proactively to surface all touchpoints in the plan, so the user can scope the work upfront.
- **\`/qa\`** runs it reactively to verify no old-rule code survives anywhere in the diff's blast radius.

## Motivation — concrete recent miss

Issue #533 ("default /assess spec phase ON, remove bug/docs auto-skip") is the motivating example.

The AC text mentioned \`.claude/skills/assess/SKILL.md\` explicitly. \`/spec\` scoped the work to that skill file + CHANGELOG. \`/exec\` implemented it. \`/qa\` gave \`READY_FOR_MERGE\`. **All while** the runtime CLI (\`phase-mapper.ts\` \`detectPhasesFromLabels\` + \`batch-executor.ts\` auto-detect branch) still short-circuited bug/docs issues to \`exec → qa\`, directly contradicting the new "spec by default" behavior.

The gap was caught only by manual user follow-up ("any other gaps?"), and required:
- Three rounds of adversarial sweeps to find all stale references
- Two additional commits on top of the original PR (2e79778 + e7632d8)
- Updates to runtime code, 4 test files, 4 docs (\`docs-pipeline.md\`, \`exact-label-matching.md\`, \`workflow-phases.md\`, \`state-schema.ts\`), and a CHANGELOG rewrite

A pre-flight grep for \`BUG_LABELS\`/\`DOCS_LABELS\`/\\"skip spec\\" at /spec time would have surfaced 90% of these in one pass.

See the post-mortem in issue #533 comments: https://github.com/sequant-io/sequant/issues/533

## Acceptance Criteria

- [ ] **AC-1: \`/spec\` surfaces touchpoints proactively.** When \`/spec\` parses an AC containing behavior-rule keywords (\`default\`, \`always\`, \`never\`, \`rule\`, \`behavior\`, \`skip\`), it greps the codebase for related symbols/keywords and lists all touchpoints under a new "Rule Touchpoints" section in the plan.

- [ ] **AC-2: \`/qa\` verifies behavior at all touchpoints.** When \`/qa\` reviews a behavior-rule AC, it greps for inverse keywords/symbols (the OLD rule's implementation) across the repo. Any survival → AC marked \`NOT_MET\` with the file paths/line numbers listed under the AC explanation.

- [ ] **AC-3: Shared heuristic documented.** Both detectors reference a single \`references/behavior-rule-detection.md\` page describing: trigger keywords, grep patterns, common symbol categories (constants, function names, comment patterns), and false-positive guards. Both \`/spec\` and \`/qa\` SKILL.md files link to it.

- [ ] **AC-4: 3-dir sync.** Edits applied identically across \`.claude/skills/\`, \`templates/skills/\`, \`skills/\` for both \`spec/SKILL.md\` and \`qa/SKILL.md\` (and the new \`references/behavior-rule-detection.md\`). \`scripts/check-skill-sync.ts\` reports synced 3/3 for all touched files.

- [ ] **AC-5: Tests verify trigger conditions.** Unit/integration tests assert:
  - Triggers fire on behavior-style AC text: "Default rule becomes X", "Always include Y", "Never skip Z"
  - Triggers do NOT fire on file-specific AC text: "Update line 42 of foo.ts", "Add field to interface X"
  - Touchpoint detection finds duplicate implementations across skill+TypeScript layers (use #533's BUG_LABELS/DOCS_LABELS as a fixture)

- [ ] **AC-6: CHANGELOG entry under \\\`[Unreleased] / ### Added\\\`** referencing this issue and #533 as the motivating miss.

## Non-Goals

- **Not** auto-fixing detected drift — surfacing is enough; user/exec applies the fix.
- **Not** a generic "behavior change linter" outside the spec/qa flow — scope is the AC-driven workflow only.
- **Not** modifying the AC linter or scope-assessment logic — this is additive detection, not validation.

## Risks / Open Questions

- **False positive rate on AC-1 trigger keywords.** "Default" appears in many ACs that aren't behavior rules (e.g. "set default value to 5"). Mitigation: require ≥2 behavior keywords OR an explicit pattern ("always X unless Y"). Tunable in \`references/behavior-rule-detection.md\`.
- **Symbol enumeration is heuristic.** Detection relies on grepping for constants/function names that implement the OLD rule. Some rules are inline conditionals with no named symbol. AC-2 should include a fallback: when no symbols match the AC's keywords, search for the inverse English phrasing of the rule.
- **/qa runtime cost.** Adding another grep pass per behavior-AC is cheap (<1s) but compounds in large QA runs. Cache or short-circuit when no behavior-rule ACs are present.

## Complexity

medium — shared heuristic + 2 skill updates + 3-dir sync + tests + docs. Estimated 1–2 days. Single PR.

## Self-assessed workflow

\`spec → exec → qa\` with \`-q\` (skill changes + 3-dir sync + new reference doc + CHANGELOG)
`;

// ─── extractPathsFromIssueBody ──────────────────────────────────────────────

describe("extractPathsFromIssueBody", () => {
  it("expands /qa slash-command with 3-dir-sync language to all three skill roots (issue #551)", () => {
    const paths = extractPathsFromIssueBody(ISSUE_551_BODY);

    // #551 mentions /qa and 'across all three skill directories'.
    expect(paths.has(".claude/skills/qa/SKILL.md")).toBe(true);
    expect(paths.has("templates/skills/qa/SKILL.md")).toBe(true);
    expect(paths.has("skills/qa/SKILL.md")).toBe(true);
  });

  it("extracts both bare qa/SKILL.md and full .claude/skills/assess/SKILL.md (issue #552)", () => {
    const paths = extractPathsFromIssueBody(ISSUE_552_BODY);

    // Explicit full path mentioned in motivation:
    expect(paths.has(".claude/skills/assess/SKILL.md")).toBe(true);

    // Bare 'qa/SKILL.md' and 'spec/SKILL.md' under 3-dir-sync:
    expect(paths.has(".claude/skills/qa/SKILL.md")).toBe(true);
    expect(paths.has("templates/skills/qa/SKILL.md")).toBe(true);
    expect(paths.has("skills/qa/SKILL.md")).toBe(true);
    expect(paths.has(".claude/skills/spec/SKILL.md")).toBe(true);
    expect(paths.has("templates/skills/spec/SKILL.md")).toBe(true);
    expect(paths.has("skills/spec/SKILL.md")).toBe(true);
  });

  it("does not extract paths mentioned only inside fenced code blocks", () => {
    const body = `## AC

- [ ] AC-1: Update path foo.

\`\`\`
edit qa/SKILL.md and 3-dir sync across .claude/skills/
\`\`\`
`;
    // Even though qa/SKILL.md and 3-dir-sync language appear, both are
    // inside a fenced code block. The guard strips fences before
    // extraction → no paths.
    const paths = extractPathsFromIssueBody(body);
    expect(paths.size).toBe(0);
  });

  it("does not extract paths mentioned only inside HTML comments", () => {
    const body = `## AC

- [ ] AC-1: Update something.

<!-- earlier draft mentioned \`qa/SKILL.md\` with 3-dir sync -->
`;
    const paths = extractPathsFromIssueBody(body);
    expect(paths.size).toBe(0);
  });

  it("excludes globally-shared paths even when mentioned (CHANGELOG, lockfiles)", () => {
    // Only mentions excluded paths and an irrelevant slash-command (no
    // 3-dir-sync language → no slash-command derivation).
    const bodyA = "Update \`CHANGELOG.md\` and \`package-lock.json\` only.";
    const bodyB = "Touch \`CHANGELOG.md\` and \`yarn.lock\` only.";

    const pathsA = extractPathsFromIssueBody(bodyA);
    const pathsB = extractPathsFromIssueBody(bodyB);

    for (const excluded of EXCLUDED_PATHS) {
      expect(pathsA.has(excluded)).toBe(false);
      expect(pathsB.has(excluded)).toBe(false);
    }
  });

  it("ignores glob patterns like .claude/skills/**/*.md (literal `**` not a path)", () => {
    const body = "Touches \`.claude/skills/**/*.md\` and \`skills/**/*.md\`.";
    const paths = extractPathsFromIssueBody(body);
    expect(paths.size).toBe(0);
  });
});

// ─── detectFileCollisions ───────────────────────────────────────────────────

describe("detectFileCollisions", () => {
  it("flags overlap when two issue bodies both target qa/SKILL.md (verbatim #551 + #552)", () => {
    const issuePaths = new Map<number, Set<string>>([
      [551, extractPathsFromIssueBody(ISSUE_551_BODY)],
      [552, extractPathsFromIssueBody(ISSUE_552_BODY)],
    ]);

    const collisions = detectFileCollisions(issuePaths);

    // At minimum, .claude/skills/qa/SKILL.md (and the two mirrored
    // mirrors) must be flagged.
    const qaSkillFiles = collisions
      .filter((c) => c.file.endsWith("qa/SKILL.md"))
      .map((c) => c.file);
    expect(qaSkillFiles).toContain(".claude/skills/qa/SKILL.md");

    for (const c of qaSkillFiles) {
      const collision = collisions.find((x) => x.file === c)!;
      expect(collision.issues).toEqual([551, 552]);
    }
  });

  it("does not flag overlap when shared path appears only in a code block", () => {
    const bodyA = "Modifies \`src/lib/foo.ts\`.";
    const bodyB =
      "Modifies \`src/lib/bar.ts\`.\n\n```\nedit src/lib/foo.ts\n```\n";
    const issuePaths = new Map<number, Set<string>>([
      [100, extractPathsFromIssueBody(bodyA)],
      [101, extractPathsFromIssueBody(bodyB)],
    ]);
    const collisions = detectFileCollisions(issuePaths);
    expect(collisions).toEqual([]);
  });

  it("does not flag overlap when both issues mention only excluded paths", () => {
    const bodyA = "Update \`CHANGELOG.md\` only.";
    const bodyB = "Update \`CHANGELOG.md\` and \`package-lock.json\`.";
    const issuePaths = new Map<number, Set<string>>([
      [200, extractPathsFromIssueBody(bodyA)],
      [201, extractPathsFromIssueBody(bodyB)],
    ]);
    const collisions = detectFileCollisions(issuePaths);
    expect(collisions).toEqual([]);
  });

  it("groups three issues colliding on the same file into one result", () => {
    const issuePaths = new Map<number, Set<string>>([
      [10, new Set(["src/lib/foo.ts"])],
      [20, new Set(["src/lib/foo.ts"])],
      [30, new Set(["src/lib/foo.ts"])],
    ]);
    const collisions = detectFileCollisions(issuePaths);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].issues).toEqual([10, 20, 30]);
    expect(collisions[0].file).toBe("src/lib/foo.ts");
  });
});

// ─── formatCollisionAnnotations ─────────────────────────────────────────────

describe("formatCollisionAnnotations", () => {
  it("renders Order: line and per-issue ⚠ warnings for a 2-issue collision", () => {
    const out = formatCollisionAnnotations([
      { issues: [551, 552], file: ".claude/skills/qa/SKILL.md" },
    ]);
    expect(out.orderLines).toEqual([
      "Order: 551 → 552 (.claude/skills/qa/SKILL.md)",
    ]);
    expect(out.warnings).toEqual([
      "⚠ #551  Modifies .claude/skills/qa/SKILL.md (overlaps #552); land sequentially",
      "⚠ #552  Modifies .claude/skills/qa/SKILL.md (overlaps #551); land sequentially",
    ]);
    expect(out.chainSuggestion).toBeUndefined();
  });

  it("emits a Chain: suggestion when 3+ issues collide on the same file (AC-4)", () => {
    const out = formatCollisionAnnotations([
      { issues: [10, 20, 30], file: "src/lib/foo.ts" },
    ]);
    expect(out.chainSuggestion).toBeDefined();
    expect(out.chainSuggestion).toMatch(
      /^Chain: npx sequant run 10 20 30 --chain --qa-gate -q\b/,
    );
    expect(out.chainSuggestion).toContain("src/lib/foo.ts");
  });

  it("does not emit Chain: when only 2 issues collide", () => {
    const out = formatCollisionAnnotations([
      { issues: [10, 20], file: "src/lib/foo.ts" },
    ]);
    expect(out.chainSuggestion).toBeUndefined();
  });
});
