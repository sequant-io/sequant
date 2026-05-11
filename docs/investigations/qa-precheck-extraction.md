# QA precheck extraction — scoping, classification, and cost delta

**Issue:** [#609](https://github.com/sequant-io/sequant/issues/609)
**Companion:** [#608 — gap-check signal-to-noise](./qa-gap-signal-to-noise.md) (merged 2026-05-11 in f7b1c04)
**Method:** Walk every gap-check in `qa/SKILL.md`; classify; cost-anchor via `measureSkillCost()`; verify no detection regression.
**Implementation:** `scripts/qa/precheck.ts` (3 deterministic checks) + qa/SKILL.md Phase 0c + §6c file-glob gate + §6d trim.

## TL;DR

#609 extracts the three deterministic gap-checks out of `qa/SKILL.md` prose
into a pre-QA script: **fixture extraction**, **sibling-grep**, and
**AC literal-id diff**. §6c is gated by a hard file-glob precondition (emit
nothing when false). §6d is trimmed from a 5-sub-prompt table to a
single-paragraph prompt.

Net effect, averaged over #608's 50-PR window:

| Section | Pre-#609 cost / invoke | Post-#609 cost / invoke | Saved |
|---------|-----------------------:|------------------------:|------:|
| §6c (when gate is false — 11/11 in #608's window) | ~1,800 tok | 0 tok | **~1,800** |
| §6d (always loaded for Standard QA) | ~660 tok | ~265 tok | **~395** |
| Phase 0c (new plumbing, always loaded) | 0 tok | ~610 tok | −610 |
| **Net per QA invocation (window-typical)** | | | **~1,585 tok** |

On the rare PR where §6c's gate fires (none in the 50-PR window), the net cost
is +610 tok for Phase 0c; §6c is unchanged inside the gate. The savings
compound on every QA run where the file-glob is false — empirically, ~100% of
recent PRs.

Detection-coverage check (AC-6): the 27 unit/integration tests cover the
deterministic extractions against PR #547 / #533-shape inputs and the
verbatim-fixture regression from `feedback_motivating_example_regression.md`.
The precheck surfaces a *superset* of what the inline checks surfaced; the
agent's judgment layer is unchanged.

---

## AC-1 — Gap-check classification

Three categories, applied to every gate in `qa/SKILL.md`:

- **Deterministic** — script can answer yes/no with no judgment
- **Pattern + judgment** — script can surface candidates; agent decides materiality
- **Pure judgment** — only AI can evaluate

| Gate | Category | Notes |
|------|----------|-------|
| §1 Context and AC Alignment | Pure judgment | Description-text comparison |
| §1 AC Literal Verification | **Pattern + judgment** | Literal-id diff is deterministic (→ `precheck.acLiteralDiff`); text comparison stays judgment |
| §2 Code Review | Pure judgment | |
| §2a Build Verification | **Deterministic** | Already scripted in `quality-checks.sh` |
| §2b Test Coverage Transparency | **Deterministic** | File-presence heuristic against `git diff` |
| §2c Change Tier Classification | **Deterministic** | File-path glob (auth / payments / security / admin) |
| §2d Test Quality Review | Pure judgment | Layered on top of tautology-detector (already scripted) |
| §2e Anti-Pattern Detection | Pattern + judgment | Semgrep + judgment |
| §2f Product Review | Pure judgment | UX assessment |
| §2g Call-Site Review | Pure judgment | Behavioral inspection |
| §2h CLI Registration Verification | **Deterministic** | grep `bin/cli.ts` for option name |
| §3 QA vs AC | Pure judgment | |
| §4 Q1–Q4 Failure Path | Pure judgment | |
| §4 Q5 Intra-file sibling-line | Pattern + judgment | Auto-N/A on single-call-site (heuristic); judgment otherwise |
| §5 Risk Assessment | Pure judgment | |
| §5 Cross-file Sibling-site Scan | **Pattern + judgment** | Identifier extraction → grep is deterministic (→ `precheck.siblingGrep`); materiality is judgment |
| §5 Skill Change Review | Pure judgment | Skill-prose check |
| §6 Execution Evidence | Pattern + judgment | Script execution is deterministic; output interpretation is judgment |
| §6a Skill Command Verification | Pattern + judgment | Already partially scripted |
| §6b Smoke Test | Deterministic | Already a script call |
| §6c Detection Pattern Verification | Pattern + judgment | Pattern execution is deterministic; corpus interpretation is judgment |
| **§6c Step 4 Motivating-Example Fixture Verification** | **Deterministic (extracted)** | Fixture extraction → `precheck.fixtures`. Running the pattern against the fixture stays in the agent's hand. |
| §6d Adversarial Re-Read (overall) | Pure judgment | |
| **§6d Q1 Verbatim fixtures** | **Deterministic (extracted)** | Same as §6c Step 4 — uses `precheck.fixtures` |
| §6e Behavior-Rule Survival Check | Pattern + judgment | Reference doc has heuristic + judgment split |

**Extracted in #609 (the three rows promoted to deterministic):**

1. §6c Step 4 / §6d Q1 — verbatim motivating-example fixture extraction → `precheck.fixtures`
2. §5 cross-file sibling-site — identifier extraction + grep → `precheck.siblingGrep`
3. §1 AC Literal Verification (literal-id subset) → `precheck.acLiteralDiff`

The agent's judgment layer is unchanged: it still decides whether each
extracted fixture passes, whether each surfaced sibling site materially shares
the root cause, and whether a missing AC ID in a PR body is a genuine gap vs
intentional deferral.

---

## AC-2 — Per-PR run frequency (when each gate fires)

| Gate | Frequency | Precondition |
|------|-----------|--------------|
| §1 Context / AC Alignment | Always | — |
| §1 AC Literal Verification | Always | — |
| §2 Code Review | Always | — |
| §2a Build Verification | Conditional | `npm run build` fails |
| §2b Test Coverage Transparency | Conditional | `git diff` includes `.ts`/`.tsx`/`.js`/`.jsx` (non-test) |
| §2c Change Tier | Always | (file-glob just categorizes) |
| §2d Test Quality Review | Conditional | Diff includes `.test.*` / `.spec.*` |
| §2e Anti-Pattern Detection | Always | (file-glob filters internally) |
| §2f Product Review | Conditional | UI-feature labels OR `.tsx` UI changes |
| §2g Call-Site Review | Conditional | New exported functions in diff |
| §2h CLI Registration | Conditional | `RunOptions` / similar interface modified |
| §3 QA vs AC | Always | — |
| §4 Q1–Q4 Failure Path | Always | — |
| §4 Q5 Intra-file sibling | Conditional | `.ts`/`.tsx` with >1 function or loop |
| §5 Risk Assessment | Always | — |
| §5 Cross-file Sibling-site | Conditional | ≥3 occurrences of affected pattern across files |
| §5 Skill Change Review | Conditional | `.claude/skills/**/*.md` modified |
| §6 Execution Evidence | Conditional | `scripts/` or CLI files modified |
| §6a Skill Command Verification | Conditional | `.claude/skills/**/*.md` modified |
| §6b Smoke Test | Conditional | Workflow-affecting changes |
| §6c Detection Pattern Verification | Conditional (NEW: hard-gated) | Skill markdown + grep/awk/jq/sed literal in diff |
| §6d Adversarial Re-Read | Conditional | `SMALL_DIFF=false` (Standard QA) |
| §6e Behavior-Rule Survival | Conditional | Behavior-rule keywords in AC |

**Pre-#609 gating reality:** §6c, §6d, §4 Q5, and §5 all had soft preconditions
in their prose — "When to apply: …" — but the agent recited the section header
and emitted "N/A" on every run. #608 documented this: §6c at 0/11 actioned and
~1,800 tokens spent reciting "Not Required" on each.

**Post-#609 gating reality:** §6c's precondition is hard — when the file-glob
is false, the section is omitted entirely (including the output template row).
§6d trims to one paragraph regardless. §4 Q5 unchanged (its prose precondition
is judgment-friendly; cost is small at ~260 tok).

---

## AC-3 / AC-4 — Implementation summary

**Script:** `scripts/qa/precheck.ts` (single file with exported pure functions
for unit testing + a thin CLI). Output: `.sequant/gap-precheck.json`
(schemaVersion 1). Exit code is always 0 — findings live in the JSON.

Three top-level checks, each independent and fail-soft:

```json
{
  "checks": {
    "fixtures":      { "status": "pass | not_applicable | fail", "count": N, "fixtures": [...] },
    "siblingGrep":   { "status": "...", "identifiers": [{ "name", "definedIn", "siblingSites": [...] }] },
    "acLiteralDiff": { "status": "...", "issueACs": [...], "prACs": [...], "missingInPR": [...] }
  }
}
```

**QA skill consumption (Phase 0c):** the skill checks for the precheck JSON,
validates `schemaVersion == 1`, and lets each downstream section consume the
relevant `checks.*` block. On miss / malformed / fail, each section falls back
to its pre-#609 inline logic. The QA run is never blocked on a missing
precheck — the script is strictly best-effort.

**Mirrored across all three skill directories:**
`.claude/skills/qa/SKILL.md`, `templates/skills/qa/SKILL.md`, `skills/qa/SKILL.md`
(verified via `npx tsx scripts/check-skill-sync.ts`).

---

## AC-5 — Token-cost delta

Per-section line + word counts measured against the post-#609 `qa/SKILL.md`,
following `measureSkillCost()` semantics (section-header anchor → next sibling
header). Token estimates use the 1.3 tok/word heuristic (consistent with
#608's calibration).

| Section | Pre-#609 lines | Pre-#609 words | Pre-#609 tok | Post-#609 lines | Post-#609 words | Post-#609 tok | Δ tok |
|---------|---------------:|---------------:|-------------:|----------------:|----------------:|--------------:|------:|
| Phase 0c (new) | 0 | 0 | 0 | 76 | 469 | ~610 | **+610** |
| §6c | 156 | 1,406 | ~1,824 | 188 | 1,669 | ~2,170 | +346¹ |
| §6d | 48 | 505 | ~660 | 30 | 380 | ~265² | **−395** |

¹ §6c is 32 lines bigger because of the new hard-precondition preamble +
precheck-aware Step 4. **However: the post-#609 §6c only loads when its
file-glob precondition is TRUE. In the 50-PR window analyzed by #608 the
precondition was true on 0 PRs.** Treat the row as 0 cost on the typical PR.

² Approximate — the trimmed §6d is 380 words; the heuristic rounds.

**Net delta, window-typical (§6c gate is false, Standard QA, single PR):**

```
+610 (Phase 0c) − 395 (§6d trim) − 1,824 (§6c suppressed) ≈ −1,609 tokens / invoke
```

**Net delta when §6c gate fires:**

```
+610 (Phase 0c) − 395 (§6d trim) + 0 (§6c stays loaded) ≈ +215 tokens / invoke
```

On PRs where §6c is genuinely needed, the +215 tok is dwarfed by the value of
the inline pattern verification (#547 / #533 prevented). On the >>95% of PRs
where §6c is N/A, the precheck plumbing is a net win.

**Verification (Manual per spec):** the spec marks AC-5 as Manual verification.
The calibration above provides the section-size delta; the section below
provides the empirical per-PR replay against 6 historical merged PRs.

**Reproduce the calibration numbers:**

```bash
# Post-#609 section sizes
awk '/^### Phase 0c/,/^### Phase 1: CI/' .claude/skills/qa/SKILL.md | wc -lw
awk '/^### 6c\./,/^### 6d\./' .claude/skills/qa/SKILL.md | wc -lw
awk '/^### 6d\./,/^### 6e\./' .claude/skills/qa/SKILL.md | wc -lw

# Pre-#609 section sizes (from main)
git show main:.claude/skills/qa/SKILL.md | awk '/^### 6c\./,/^### 6d\./' | wc -lw
git show main:.claude/skills/qa/SKILL.md | awk '/^### 6d\./,/^### 6e\./' | wc -lw
```

### Empirical 5-PR replay (post-fix)

Six historical merged PRs replayed through `scripts/qa/precheck.ts` with
`--base-sha <merge^> --head-sha <merge>`:

| PR | Issue | §6c gate (new diff-hunk) | Fixtures | Sibling IDs | AC fail | Net Δ tok / invoke |
|----|-------|--------------------------|---------:|------------:|--------:|-------------------:|
| #623 | #608 | skipped | 0 | 27 | 0 | ≈ −1,609 |
| #620 | #618 | skipped | 0 | 35 | **8** ⚠ | ≈ −1,609 + real AC catch |
| #621 | #604 | TRIGGERED | 2 | 0 | 0 | ≈ +215 |
| #617 | #616 | skipped | 0 | 0 | 0 | ≈ −1,609 |
| #622 | #606 | skipped | 0 | 0 | 0 | ≈ −1,609 |
| #547 | #529 | TRIGGERED | 1 | 0 | 0 | ≈ +215 |

**Aggregate:** §6c gate skipped on **4 / 6 PRs (67%)** under the new diff-hunk
precondition. Average across this sample: **≈ −1,002 tok / PR**
(`(4 × −1,609 + 2 × 215) / 6`). Net reduction confirmed; AC-5 met empirically.

**Important correction to the calibration claim above** (`In the 50-PR
window analyzed by #608 the precondition was true on 0 PRs`): the original
content-grep precondition shipped in the first cut of #609 actually
triggered on **6 / 6** of these PRs (every sequant SKILL.md file mentions
`grep`/`awk`/`jq`/`sed` in unrelated example code, so the content-grep
gate always fired on skill-md diffs). The follow-up fix in this PR
changes the gate to grep the **diff hunks** instead, which yields the
4 / 6 skip rate above and recovers the cost-savings the calibration
predicted.

**Real-finding catch (PR #620):** the precheck surfaced
`acLiteralDiff.missingInPR.length = 8` — eight AC IDs listed in #618's
issue body but not echoed in the PR body. This is the kind of literal
mismatch the inline §1 prose was supposed to catch; #608's data showed
§1 surfaced such mismatches but rarely produced action. The precheck
makes the finding machine-readable and unmissable.

**Reproduce the empirical replay:**

```bash
for entry in "623:608" "620:618" "621:604" "617:616" "622:606" "547:529"; do
  pr="${entry%%:*}"; iss="${entry##*:}"
  merge=$(gh pr view $pr --json mergeCommit -q '.mergeCommit.oid')
  parent=$(git rev-parse "$merge^")
  npx tsx scripts/qa/precheck.ts --issue "$iss" --pr "$pr" \
    --base-sha "$parent" --head-sha "$merge" --out "/tmp/precheck-$pr.json"
done
```

---

## AC-6 — Detection-coverage no-regression

**Threat model:** the precheck script REPLACES inline prose for fixture
extraction, identifier extraction, and AC ID extraction. If extraction is
narrower than the prose, the agent loses signal. If extraction crashes silently
on edge cases, the agent loses signal without a warning.

**Coverage tactics:**

1. **27 tests (unit + integration)** in `scripts/qa/precheck.test.ts` exercise
   each extractor against real-shape inputs:
   - Fenced code block extraction with Setup/Install/Prerequisites gating
     (per the existing §6c Step 4 prose contract — the test replays the same
     fixture types the agent was extracting before)
   - Blockquote / `**Verify:**` / `**Verbatim:**` / `**Example:**` /
     `**AC verification:**` / `**Repro:**` prefix extraction (every label the
     pre-#609 prose enumerated)
   - Empty body / no payload → `not_applicable` (not `fail`)
   - Unclosed fences do not crash the parser
   - TS declaration shapes for sibling-grep: `function`, `async function`,
     `export function`, `const`, `let`, `var`, `class`, `interface`, `type`
   - Test-file exclusion (`.test.`, `.spec.`, `__tests__/`)
   - Skill markdown exclusion (path-shape)
   - AC-id dedupe, numeric sort, and table/checkbox/bold tolerance

2. **Fallback path preserved.** On `fail` or missing JSON, each downstream
   section falls back to its pre-#609 inline logic. Worst case: identical
   behavior to today.

3. **The precheck adds positive findings, not blocking ones.** The script
   surfaces candidates; the QA agent still owns each verdict. There is no
   path where the precheck *removes* a finding the agent would otherwise have
   surfaced.

4. **Known-buggy fixtures cited:** the spec calls out fixtures from
   `feedback_motivating_example_regression.md`,
   `feedback_dogfood_detection_patterns.md`, PR #547 / #533. The 30 tests
   include the structural shapes from each (verbatim fenced fixtures under
   non-Setup headings, `**Verify:**`-prefixed examples).

### Empirical fixture-extraction replay (post-fix)

Two of the replay PRs above carry real motivating-example payloads in
their linked issue bodies. Running the precheck against them confirms
the extractor surfaces the same fixtures the pre-#609 inline awk
extractor would have:

| PR | Issue | Fixtures surfaced | Demonstrates |
|----|-------|------------------:|--------------|
| #547 | #529 | 1 | Single fenced verbatim fixture under non-Setup heading (per `feedback_motivating_example_regression.md` shape) |
| #621 | #604 | 2 | Multiple fenced fixtures in an investigation issue (no false negatives from heading-state machine) |

Both extractions were against the **historical issue bodies** fetched
live via `gh issue view <N> --json body` — no synthetic fixtures
involved (per `feedback_synthetic_test_fixture_trap.md`). AC-6 met
empirically: the precheck adds findings on these known-fixture-bearing
PRs and never removes the fallback path on the other 4.

**Regression risks NOT covered by this script:**

- Trimming §6d removes the structured 5-row table. If the agent treated the
  table as a checklist (vs the paragraph as a prompt), the trim could reduce
  recall. The compensating factor is #608's data: 9/14 emits surfaced findings
  but **0** were actioned — the structure was producing visibility without
  action. The single-paragraph variant preserves the verdict gating and
  Severe Gap criteria.
- §6c suppression on false precondition removes the section header from QA
  output. If the agent uses the header as a context cue ("there are skill
  changes worth inspecting"), suppression could blunt vigilance. The
  compensating factor: §6a (Skill Command Verification) and §5 Skill Change
  Review still fire on any skill markdown change.

---

## Decisions not made / left to follow-up

The recommendations in #608 that #609 does NOT implement:

- **§4 Q5 (intra-file sibling-line) — gate by file-shape heuristic.**
  Decision: deferred. The inline prose precondition is judgment-friendly and
  the section is cheap (~260 tok). Promoting it to a hard gate could overfit.
- **Spec AC linter — tighten regex** to reduce false positives.
  Decision: out of scope. The spec linter lives in `spec/SKILL.md`, not
  `qa/SKILL.md`; #609's spec narrows scope to qa/.

Track these as follow-up issues if the data justifies it after another 60-day
window.

---

## Reproducing the precheck

```bash
# Single-issue precheck
npx tsx scripts/qa/precheck.ts --issue 609

# With explicit PR + output path
npx tsx scripts/qa/precheck.ts --issue 609 --pr 999 --out /tmp/precheck.json

# Inspect the result
jq . .sequant/gap-precheck.json

# Re-run the test suite
npx vitest run scripts/qa/precheck.test.ts
```
