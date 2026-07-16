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

\`spec → exec → qa\` with \`-Q\` (skill changes + 3-dir sync + new reference doc + CHANGELOG)
`;

// ─── Verbatim negative fixtures (#760/#761/#762 — cite one doc under
//     ## References, modify none of it; #769 phantom-collision class) ──────

const ISSUE_760_BODY = `## Context

The #604 forensics showed 3 of the 5 recorded chain failures (two rate-limit cascades, one QA API timeout) killed the whole chain even though earlier links had completed and checkpointed — a rerun the next day of one of them (f317530c → b9c08e29) succeeded. Chain mode already writes a \`checkpoint(#N): QA passed\` commit after each successful link (\`createCheckpointCommit\`, \`worktree-manager.ts\`) and describes it as a "recovery point if later issues fail", but **nothing consumes it**: on any link failure the loop does an unconditional \`break\` (\`run-orchestrator.ts\`) and a re-run redoes completed issues from scratch.

This is the highest-leverage chain improvement identified: it converts "chain dead, 1–3 hours wasted" into "re-run picks up at the failed link" for the dominant failure classes.

## Proposal

Re-running \`sequant run A B C --chain\` after a partial failure should skip links that already completed (state.json status \`ready_for_merge\` + existing worktree/branch with checkpoint) and resume execution at the first incomplete link, re-establishing the successor rebase chain from the last good link's committed tip (the #748-fixed \`rebaseOntoLocalBranch\` path). Whether this is automatic on re-run or an explicit \`--resume-chain\` flag is a design decision for /spec — automatic detection must not silently skip an issue the user intended to redo.

## Acceptance Criteria

- [ ] Re-running the same \`--chain\` invocation after a mid-chain failure does not re-execute links whose issues are \`ready_for_merge\` with an intact worktree; execution resumes at the first incomplete link, rebased onto the last completed link's local committed tip.
- [ ] Skipped links are reported explicitly in output (issue number, why it was skipped, which commit the resume point is).
- [ ] A completed link whose worktree/branch has been destroyed (e.g. merged + cleaned mid-way) is handled: either re-established from the merged base or the chain fails fast with a clear message — no silent wrong-base execution.
- [ ] \`createCheckpointCommit\` failure is no longer silent (currently warns and continues, \`worktree-manager.ts\` ~1094-1102): if the recovery point can't be written, the run says so prominently, since resume depends on it.
- [ ] Integration test with real git: run a 3-link chain, force link 2 to fail, re-run, assert link 1 is skipped and link 2 branches from link 1's tip (\`merge-base --is-ancestor\`, same pattern as the #752 test).

## Out of scope

Automatic retry within the same run (separate concern), rate-limit detection/backoff (companion issue), \`--stacked\` PR-base rewriting on resume beyond what the normal path already does.

## References

- \`docs/reference/chain-mode-analysis-2026-05.md\` (#604) — failure taxonomy; per-issue success 61.5% when the chain reaches an issue vs 17% whole-chain at length≥3
- #748 / PR #752 — successor rebase mechanics this must reuse
- #592 — known pre-flight gap for in_progress-but-merged issues, relevant to skip detection
`;

const ISSUE_761_BODY = `> ### ⚠️ STATUS: ACs rewritten — read [the clarification comment](https://github.com/sequant-io/sequant/issues/761#issuecomment-4982116722) before implementing
>
> The **Acceptance Criteria below have been replaced** (see § at the bottom). Corrections to the Context/Proposal sections, which are otherwise left as filed:
>
> - **The forensic logs are gone.** No \`f317530c\` / \`058048af\` run log survives in \`.sequant/logs/\`. The original AC-1/AC-5 mandated validating signatures against them and were **unsatisfiable**. The log-scraping method is dropped entirely.
> - **#732 superseded the method.** Structured SDK rate-limit signals (\`RateLimitError\` / \`RateLimitMetadata\`) already exist; regex-scraping logs would re-introduce what #732 removed.
> - **"Nothing classifies rate-limit signatures in the chain loop"** — half true. Classification exists in the phase executor; what's missing is that the abort path **discards** it (\`drivers/claude-code.ts:287-294\`). That is the root cause.
> - **The chain does NOT cascade across links** — it already halts at the first failure (\`run-orchestrator.ts:1337-1345\`). The ~30+ min burn is real but happens *inside a single phase* via a retry ladder of up to 4 × 1800s.
> - **Retry-with-backoff does NOT already exist.** The retryable branch is a bare \`continue\` with no delay. Bounded retry ≠ backoff.
>
> **Retitle suggested:** this is not "halt the chain" — the chain already halts. It is *"stop burning ~2 hours of doomed retries inside one phase, and say why it stopped."*

## Context

2 of the 5 recorded chain failures in the #604 forensics were Claude Code 5-hour rate-limit hits mid-run (f317530c 2026-03-23, 058048af 2026-03-25). In both, the limit manifested as 1800s phase timeouts that cascaded — burning ~30+ minutes per timed-out phase before the chain died, with no indication that the root cause was a rate limit rather than a real failure. Chain mode is structurally the most exposed surface: wall clock scales with length (avg 78.9 min, observed up to 228 min), so a 4-issue chain has ~4× the rate-limit window of a single run. #452 (PR #455) added retry-with-backoff for transient spec-phase failures, but nothing classifies rate-limit signatures in the chain loop.

## Proposal

Blocking for a 5-hour window is impractical, so the goal is **fail fast and fail labeled**, not wait-and-retry:

- Detect the rate-limit signature in phase output/exit (the specific patterns should be pulled from the two forensic run logs in \`.sequant/logs/\`).
- On detection mid-chain: skip the remaining 1800s timeout ladder, halt the chain immediately, and report "rate limited — chain halted after #N; resume when the window resets" with the exact resume command.
- Short exponential backoff (à la #452) is appropriate only for transient blips, not window exhaustion — classify the two cases rather than retrying blindly.

Pairs with #760: a labeled rate-limit halt plus chain resume turns this failure class from fatal into a pause.

## Acceptance Criteria

> **Rewritten.** Rationale + evidence in [the clarification comment](https://github.com/sequant-io/sequant/issues/761#issuecomment-4982116722). The original log-signature ACs are dropped (logs gone; #732 supersedes the method). Ordered by dependency — AC-1 is load-bearing.

- [ ] **AC-1:** The abort/timeout path at \`drivers/claude-code.ts:287-294\` attaches \`structuredError\` via \`buildStructuredError(rateLimitInfo, assistantError, apiRetryError)\`, matching the sibling catch path at \`:302\`. A rate limit that manifests as a hang must stay classifiable downstream. *Without this, every AC below is unreachable.*
- [ ] **AC-2:** A rate limit whose \`resetsAt\` is beyond a short threshold does **not** consume cold-start retries. Model on the \`capped\` precedent (\`phase-executor.ts:906-908\`): explicit early return skipping all retries. A window resetting in hours cannot be retried into success.
- [ ] **AC-3:** The MCP fallback gate (\`phase-executor.ts:972-978\`) additionally checks \`!failureIsRateLimited\`, alongside \`!failureIsBilling && !failureIsCapped\`. A throttle must not trigger "retrying without MCP".
- [ ] **AC-4:** Transient rate-limit retries get **real backoff** — reuse the injected \`delayFn\` (\`phase-executor.ts:825\`) rather than inventing a mechanism. **This does not exist today**; the current branch is a bare \`continue\`. Bounded retry alone is not the AC.
- [ ] **AC-5:** On chain halt, the run summary prints the resume affordance. Implement in \`run-display.ts:119 displaySummary\`, not at the orchestrator break — that is where #760 already restates checkpoint failures for the same reason (*"the per-issue warning has long scrolled past by now on a multi-hour chain"*, \`run-display.ts:149-151\`), and \`RunResult\` there carries \`mergedOptions\`. **Note:** #760 added no resume flag — resume is re-running the *identical* command. The output must say so explicitly, or it reads as a bug. Use \`formatRateLimitMessage\` (\`errors.ts:313\`); include \`resetsAt\` when present.
- [ ] **AC-6:** \`structuredError\` is threaded into \`batch-executor.ts:942\` and \`:623\` in preference to \`classifyError\`, and \`rate_limit\` / \`billing\` are added to \`ERROR_CATEGORIES\` (\`error-classifier.ts:19-27\`) and \`errorTypeToCategory\` (\`:34-49\`). Prerequisite for AC-7.
- [ ] **AC-7:** \`.sequant/metrics.json\` records a bounded-enum \`failureCategory\` on \`MetricRunSchema\`, threaded from \`PhaseResult.structuredError\` → \`IssueResult\` → \`recordRun\` (\`run-orchestrator.ts:1545\`). Enum only — no message strings (privacy contract, \`metrics-schema.ts:69-77\`).
- [ ] **AC-8:** Tests. **\`phase-executor.test.ts:722\` — "still retries a transient rate-limit failure (RateLimitError is retryable)" — pins the behavior AC-2 changes and must be inverted.** Copy the shape of the \`BillingError\` non-retryable + MCP-skip tests at \`:651-692\`. Add an abort-path test asserting AC-1 (a hang carrying \`rateLimitInfo\` yields a classified failure, not a bare timeout).
- [ ] **AC-9:** Before implementing AC-2's branch on \`rateLimitType\`, **validate against a real captured rejection** that window exhaustion actually arrives with \`rateLimitType\` populated. **[UNRESOLVED]** whether the SDK can emit a window rejection as \`assistant.error: "rate_limit"\` *without* a paired \`rate_limit_event\` — if it can, window detection degrades to indistinguishable, AC-2 needs a fallback rule, and the metadata-dropping map at \`claude-code.ts:363-376\` needs fixing too. Validate against a real capture, not a mocked event.

### Notes for the implementer

- **Testability wall:** there are no orchestrator tests for \`executeSequential\`'s break path. The #760 commit called this out — *"there were no orchestrator tests at all, which is why the seam the original #748 bug lived in went untested"* — and extracted \`planChainResumeFromState\` (\`chain-resume.ts:231\`) to be testable standalone. AC-5 will hit the same wall and likely wants the same treatment. \`chain-resume.integration.test.ts\` is the natural home for an end-to-end halt-and-print test.

## Out of scope

Scheduling runs around limit windows, token budgeting, resume itself (#760).

## References

- \`docs/reference/chain-mode-analysis-2026-05.md\` (#604) — rate-limit exposure classified as structural
- #452 / PR #455 — existing transient-failure retry precedent

`;

const ISSUE_762_BODY = `## Context

\`sequant run --chain\` validates flag combinations only (\`run.ts\`: --stacked/--no-chain, --chain/--batch, etc.); there is zero content-level validation of the issues being chained. Issues run in the order given on the CLI with no check that the order matches actual dependencies, that the issues have acceptance criteria at all, or that declared blockers ("blocked by #N") are consistent with the chain order. The #133 incident (chain 114 → 116: QA fixes on the predecessor invalidated the already-built successor) is the historical example of the class this catches cheapest at the front door.

Most of the machinery already exists: \`src/lib/assess-collision-detect.ts\` does pairwise file-overlap prediction and ordering for /assess, and /assess's chain detection already parses "depends on #N" / "blocked by #N" markers.

## Proposal

A fast pre-flight at chain start, **warn-by-default** (the #604 philosophy: suggest, never auto-decide — false dependency inference is worse than none):

- Each issue exists, is open, and has a non-empty Acceptance Criteria section (warn if missing).
- Declared dependency markers ("blocked by #N", "depends on #N") in issue bodies are checked against the CLI order; warn on contradiction (e.g. \`run 39 38 --chain\` when #39 says blocked by #38).
- Predicted file-overlap ordering (reuse \`detectFileCollisions\`) is compared against the CLI order; warn on mismatch.
- Warnings print before the first worktree is provisioned; a \`--strict-preflight\` (or similar) opt-in turns warnings into a hard stop. Naming/UX is /spec's call.

## Acceptance Criteria

- [ ] \`--chain\` runs print pre-flight warnings for: missing/empty AC section, CLI order contradicting declared dependency markers, CLI order contradicting predicted file-overlap order.
- [ ] Warnings never block by default; an opt-in flag makes them fatal before any worktree is provisioned.
- [ ] Pre-flight reuses \`assess-collision-detect\` rather than reimplementing overlap prediction; no new heuristics beyond what /assess already does.
- [ ] Runs a closed/merged-issue check consistent with the existing #305 guard (and notes the #592 in_progress-but-merged gap if not fixed by then).
- [ ] Unit tests cover each warning against verbatim issue-body fixtures (real markers like "Blocked by #36", not synthetic combined fixtures).

## Out of scope

Spec-completeness scoring or any LLM-based judgment of issue quality; auto-reordering the chain; blocking on unmerged predecessor PRs (chains intentionally branch from local committed work).

## References

- #133 / PR #136 — the downstream-staleness incident this class of check front-loads
- \`docs/reference/chain-mode-analysis-2026-05.md\` (#604) — 0/5 recorded failures were content-caused; hence warn-only default
- \`src/lib/assess-collision-detect.ts\` — existing overlap/order machinery to reuse
`;

// ─── extractPathsFromIssueBody ──────────────────────────────────────────────

describe("extractPathsFromIssueBody", () => {
  it("derives qa/SKILL.md (canonical bare form) from /qa + 3-dir-sync language (issue #551)", () => {
    const paths = extractPathsFromIssueBody(ISSUE_551_BODY);

    // #551 mentions /qa and 'across all three skill directories'.
    // The detector normalizes to the canonical bare form so the three
    // mirrored copies don't triple-emit collision warnings.
    expect(paths.has("qa/SKILL.md")).toBe(true);
    expect(paths.has(".claude/skills/qa/SKILL.md")).toBe(false);
    expect(paths.has("templates/skills/qa/SKILL.md")).toBe(false);
    expect(paths.has("skills/qa/SKILL.md")).toBe(false);
  });

  it("extracts #552's real modification targets but not its Motivation-only citation (#769)", () => {
    const paths = extractPathsFromIssueBody(ISSUE_552_BODY);

    // qa/SKILL.md and spec/SKILL.md are #552's actual targets — named in its
    // AC-4 ('3-dir sync ... for both spec/SKILL.md and qa/SKILL.md'), which
    // lives in the foreground Acceptance Criteria section.
    expect(paths.has("qa/SKILL.md")).toBe(true);
    expect(paths.has("spec/SKILL.md")).toBe(true);

    // `.claude/skills/assess/SKILL.md` appears ONLY under
    // '## Motivation — concrete recent miss', where #552 cites it as the file
    // #533's AC named — background, not a file #552 touches. Before #769 this
    // leaked in as a phantom target (normalized to assess/SKILL.md); section
    // stripping now correctly drops it.
    expect(paths.has("assess/SKILL.md")).toBe(false);
  });

  it("normalizes a mirror-qualified path to canonical bare form when it survives to the foreground", () => {
    // Guards normalizeSkillMirrorPath directly: a mirror-qualified path in a
    // non-background section (no heading → foreground) collapses to bare form.
    const paths = extractPathsFromIssueBody(
      "Modifies `.claude/skills/qa/SKILL.md` per the plan.",
    );
    expect(paths.has("qa/SKILL.md")).toBe(true);
    expect(paths.has(".claude/skills/qa/SKILL.md")).toBe(false);
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

  // ─── Section-aware extraction (#769) ──────────────────────────────────────

  it("does not extract a path cited only under a background section (AC-1)", () => {
    const body = `## Summary

Fixes a thing.

## References

- \`docs/reference/chain-mode-analysis-2026-05.md\` (#604) — background reading
- \`src/lib/some-helper.ts\` — machinery to reuse
`;
    const paths = extractPathsFromIssueBody(body);
    expect(paths.has("docs/reference/chain-mode-analysis-2026-05.md")).toBe(
      false,
    );
    expect(paths.has("src/lib/some-helper.ts")).toBe(false);
    expect(paths.size).toBe(0);
  });

  it("strips Context / Motivation / Additional context / See also, case- and suffix-insensitively (AC-1)", () => {
    const body = `## Context

Cites \`src/lib/ctx.ts\`.

## Motivation — concrete recent miss

Cites \`src/lib/mot.ts\`.

## Additional context (see #533)

Cites \`src/lib/add.ts\`.

## See also

Cites \`src/lib/also.ts\`.
`;
    const paths = extractPathsFromIssueBody(body);
    expect(paths.size).toBe(0);
  });

  it("still extracts an AC-bullet path even when the same path is also cited under References (AC-2)", () => {
    const body = `## Acceptance Criteria

- [ ] AC-1: Modify \`src/lib/foo.ts\` to add the guard.

## References

- \`src/lib/foo.ts\` — current implementation
- \`src/lib/bar.ts\` — cited only here, not a target
`;
    const paths = extractPathsFromIssueBody(body);
    // Foreground AC occurrence survives despite the References citation.
    expect(paths.has("src/lib/foo.ts")).toBe(true);
    // A path present only under References is dropped.
    expect(paths.has("src/lib/bar.ts")).toBe(false);
  });
});

// ─── detectFileCollisions ───────────────────────────────────────────────────

describe("detectFileCollisions", () => {
  it("flags exactly one overlap on canonical qa/SKILL.md (verbatim #551 + #552)", () => {
    const issuePaths = new Map<number, Set<string>>([
      [551, extractPathsFromIssueBody(ISSUE_551_BODY)],
      [552, extractPathsFromIssueBody(ISSUE_552_BODY)],
    ]);

    const collisions = detectFileCollisions(issuePaths);

    // The collision must be reported on the canonical bare path only —
    // not three times once per skill-root mirror.
    const qaCollisions = collisions.filter((c) => c.file === "qa/SKILL.md");
    expect(qaCollisions).toHaveLength(1);
    expect(qaCollisions[0].issues).toEqual([551, 552]);

    // No mirror-qualified duplicates leak through.
    for (const c of collisions) {
      expect(c.file).not.toMatch(
        /^(?:\.claude\/skills|templates\/skills|skills)\/qa\/SKILL\.md$/,
      );
    }
  });

  it("returns no collision for #760/#761/#762 — each cites the same doc only under ## References (AC-3)", () => {
    // All three issues cite `docs/reference/chain-mode-analysis-2026-05.md`
    // solely in their ## References section and modify none of it. Before
    // #769 this produced a three-way phantom collision (and, being ≥3, a
    // bogus chain suggestion). Section-aware extraction drops the citation,
    // so there is no collision at all — no order lines, no warnings, no chain.
    const issuePaths = new Map<number, Set<string>>([
      [760, extractPathsFromIssueBody(ISSUE_760_BODY)],
      [761, extractPathsFromIssueBody(ISSUE_761_BODY)],
      [762, extractPathsFromIssueBody(ISSUE_762_BODY)],
    ]);

    const collisions = detectFileCollisions(issuePaths);
    expect(collisions).toEqual([]);

    // Nothing to annotate: no order lines, no warnings, no chain suggestion.
    const annotations = formatCollisionAnnotations(collisions);
    expect(annotations.orderLines).toEqual([]);
    expect(annotations.warnings).toEqual([]);
    expect(annotations.chainSuggestion).toBeUndefined();
  });

  it("does not flag overlap when one issue mentions qa/SKILL.md only inside a code block (AC-6 fixture)", () => {
    // AC-6 verbatim: "One issue mentions qa/SKILL.md, the other only
    // mentions it inside a code-block → no overlap (false-positive guard)."
    // Issue #552 mentions qa/SKILL.md in prose; the second body here
    // mentions qa/SKILL.md only inside a fenced code block.
    const codeBlockOnlyBody = `## Summary

Modifies \`src/lib/unrelated.ts\` only.

## Example output (illustrative — not a target file)

\`\`\`
edit qa/SKILL.md and 3-dir sync
\`\`\`
`;
    const issuePaths = new Map<number, Set<string>>([
      [552, extractPathsFromIssueBody(ISSUE_552_BODY)],
      [999, extractPathsFromIssueBody(codeBlockOnlyBody)],
    ]);
    const collisions = detectFileCollisions(issuePaths);
    expect(collisions).toEqual([]);
  });

  it("does not flag overlap when shared path appears only in a code block (synthetic fixture)", () => {
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
  it("renders Order: line and per-issue ⚠ warnings for a 2-issue collision (canonical bare path matches AC-3 example)", () => {
    const out = formatCollisionAnnotations([
      { issues: [551, 552], file: "qa/SKILL.md" },
    ]);
    expect(out.orderLines).toEqual(["Order: 551 → 552 (qa/SKILL.md)"]);
    expect(out.warnings).toEqual([
      "⚠ #551  Modifies qa/SKILL.md (overlaps #552); land sequentially",
      "⚠ #552  Modifies qa/SKILL.md (overlaps #551); land sequentially",
    ]);
    expect(out.chainSuggestion).toBeUndefined();
  });

  it("emits a Chain: suggestion when 3+ issues collide on the same file (AC-4)", () => {
    const out = formatCollisionAnnotations([
      { issues: [10, 20, 30], file: "src/lib/foo.ts" },
    ]);
    expect(out.chainSuggestion).toBeDefined();
    expect(out.chainSuggestion).toMatch(
      /^Chain: npx sequant run 10 20 30 --chain -Q\b/,
    );
    expect(out.chainSuggestion).not.toContain("--qa-gate");
    expect(out.chainSuggestion).toContain("src/lib/foo.ts");
  });

  it("annotates the Chain: suggestion with the historical length≥3 success rate (#604)", () => {
    const out = formatCollisionAnnotations([
      { issues: [10, 20, 30], file: "src/lib/foo.ts" },
    ]);
    expect(out.chainSuggestion).toContain(
      "chain length≥3 historically 1/6 = 17%, predates the #748/#749 fixes",
    );
    expect(out.chainSuggestion).toContain(
      "docs/reference/chain-mode-analysis-2026-05.md",
    );
  });

  it("does not emit Chain: when only 2 issues collide", () => {
    const out = formatCollisionAnnotations([
      { issues: [10, 20], file: "src/lib/foo.ts" },
    ]);
    expect(out.chainSuggestion).toBeUndefined();
  });
});
