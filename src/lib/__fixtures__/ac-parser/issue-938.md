## Motivation

An AC's verification method is currently **inferred by keyword matching** (`inferVerificationMethod`, `src/lib/ac-parser.ts:140-157`): "e2e" → browser test, "api" → integration test, anything unmatched → `"manual"`. The inference drives real routing — `/spec`'s testgen recommendation counts inferred Unit/Integration ACs (`spec/SKILL.md:366-379`), and §3a routes "manual" ACs to `PENDING` → `NEEDS_VERIFICATION`. A misworded AC silently lands in the wrong verification lane.

Transcript evidence (28-episode gap-prompt audit, 2026-07-14 → 08-10): the largest preventable class of real would-ship defects was **unexecuted or unfalsifiable verification** — #853 (detector shipped, corpus check named in the AC never run, marked MET "by construction"), #883 (tests asserting an env-coupled proxy), #842 (test that "cannot fail under any condition"), #817 (unverified e2e wiring). An explicit, runnable evidence declaration per AC converts these from LLM judgment calls into checkable claims. The controlled #819 dogfood found the same: automated QA reliably catches exactly what is a deterministic gate and reliably misses "AC marked MET with no check run."

## Proposal

An optional explicit `Evidence:` clause on the AC line, replacing inference with declaration where present.

**Format — single-line, hard constraint:** the AC parser is line-anchored (`parseACLine` runs per line); wrapped ACs silently truncate (repeated incident class). So the clause lives on the same line:

```markdown
- [ ] **AC-1:** Reset link expires after 24h. Evidence: `npm test -- reset-expiry` (mutation-verified)
```

**Parser:** `parseACLine` splits a trailing `Evidence:` segment into a new `evidence?: string` field on `AcceptanceCriterion`; description keeps the pre-`Evidence:` text. No format change to existing issues — the clause is additive and optional.

**Consumers (each wired here):**
1. `inferVerificationMethod` is bypassed when evidence is declared: a backtick-quoted command → the matching test/execution method; prose evidence ("human review", "visual check") → `manual`. Inference remains the fallback.
2. `/spec` testgen recommendation counts *declared* evidence first, inferred second — grounding the recommendation table instead of keyword guessing.
3. `/qa` §6 execution-evidence: for ACs with a declared runnable command, the QA pass must run (or verify a captured run of) exactly that command before marking MET — the #853 "by construction" path is closed for declared ACs.
4. `ac-linter` new rule: an AC whose inferred method is a test type but which names no evidence → `incomplete` warning ("verification not named"). Stays warning-only in this issue (escalation is a separate decision; see measurement AC).

## Non-Goals

- No Given/When/Then multi-line format — blocked on the line-anchored parser; a future parser-continuation issue may revisit.
- No `Risk:`/`Autonomy:` fields — separate issues, separate consumers.
- No mandatory evidence on all ACs — docs/decision ACs legitimately have none; enforcement level is a measurement-gated later step.
- No change to derived-AC handling or AC ID semantics.

## Tailored caveats

- Every AC in the fixture set must be single-line (parser truncation class).
- Verbatim motivating examples are mandatory fixtures: the #853 AC text ("Detector achieves ≥X on the labeled corpus") and an #842-style tautology AC go into the parser/QA test fixtures as production samples, not synthetic ones.
- Keyword table (`VERIFICATION_KEYWORDS`) ordering bugs are a known hazard — the declared-evidence bypass must be tested against ACs whose prose *also* contains conflicting keywords (declared wins).
- Skill edits sync three dirs; testgen recommendation table lives in `spec/SKILL.md`.

## Acceptance Criteria

- [ ] **AC-1:** `parseACLine` extracts a trailing `Evidence:` clause into `AcceptanceCriterion.evidence` and strips it from `description`; ACs without the clause parse exactly as today. Evidence: parser unit tests over the existing fixture corpus plus new clause-bearing lines; zero diffs on legacy fixtures.
- [ ] **AC-2:** Declared evidence overrides keyword inference for `verificationMethod`, with inference as fallback; conflicts resolve to the declaration. Evidence: unit test where AC prose says "e2e" but Evidence names a unit-test command, asserting `unit_test` wins.
- [ ] **AC-3:** `/spec` testgen recommendation counts declared-evidence ACs before inferred ones. Evidence: spec skill table updated in all three dirs; scoped gate test asserts the recommendation section references declared evidence, mutation-verified by deleting the section.
- [ ] **AC-4:** `/qa` §6 requires the declared command to be executed (or its captured output verified) before an evidence-bearing AC is MET. Evidence: skill-section gate test scoped to §6 asserting the declared-command requirement text, mutation-verified; one live dogfood QA run on an issue with a declared-evidence AC.
- [ ] **AC-5:** `ac-linter` flags test-type ACs with no named evidence as `incomplete`, warning-only. Evidence: linter unit tests, positive and negative.
- [ ] **AC-6:** Measurement — run the extended linter over the last 50 sequant issues and record hit/false-positive counts in the PR body, so the later escalate-to-gate decision is evidence-based (the #922 measure-first pattern). Evidence: counts and the command line recorded in the PR body.

## Human decisions required

- After AC-6's measurement: should missing-evidence escalate from warning to a `/spec` pause (`requirement_gap`, `pause_for_human`)? Deferred to a follow-up decision with the numbers in hand.

## Context

From the 2026-08-13 strategy review (AC-standard design). The prevention-side twin of the structured gap taxonomy's `test_gap`/`requirement_gap` detection classes. Related: #853, #883, #842, #817 (motivating catches), #819 dogfood refinement, #922/#928 (measure-first precedent).

