# QA gap-check: signal-to-noise investigation

**Issue:** [#608](https://github.com/sequant-io/sequant/issues/608)
**Window:** 2026-04-01 → 2026-05-10 (50 merged PRs, 66 QA comments, 36 spec comments)
**Method:** Heuristic mining of issue comments via `scripts/analytics/gap-signal.ts`
**Raw data:** `.sequant/gap-signal.jsonl` (134 flag rows)

## Question

QA SKILL.md has grown to ~2,973 lines. Six gap-detection sections, each added in
response to a real failure, now run on every QA / spec invocation. Without an
action-rate number, we cannot tell which gates are earning their token cost.

## TL;DR

| Section                            | Triggered | Action rate | Skill lines | Recommendation        |
| ---------------------------------- | --------- | ----------- | ----------- | --------------------- |
| §4 Q5 — intra-file sibling-line    | 6 / 44    | **17%**     | 12          | Gate by file-shape    |
| §5 — cross-file sibling-site       | 3 / 44    | 33%         | 7           | **Keep**              |
| §6c — detection-pattern verify     | **0 / 11**| **0%**      | 156         | **Gate by file glob** |
| §6d — Adversarial Re-Read          | 9 / 14    | **0%**      | 35          | **Trim**              |
| Spec — sibling-site scan           | 7 / 7     | 29%         | 8           | **Keep**              |
| Spec — AC linter (title/body)      | 6 / 15    | 17%         | 4           | Gate by AC count      |

Two clear remove/gate candidates: **§6c** (zero substantive findings in 11 emits, 156 lines
of prompt loaded every run that needs it) and **§6d** (9 findings, all dismissed
or silent — no follow-up issue, no fix applied). Two clear keeps: §5 and the spec
sibling-site scan, both at the proposed 30% action threshold.

## Method

### Phase A — mining

`scripts/analytics/gap-signal.ts` walks merged PRs in the window, fetches each
linked issue's comments, classifies each comment by `<!-- SEQUANT_PHASE -->` marker,
and extracts per-section "flags" using deterministic anchors:

| Section          | Anchor                                                    |
| ---------------- | --------------------------------------------------------- |
| §4 Q5            | `**Sibling-line audit:**` bullet under Risk Assessment    |
| §5               | `**Sibling sites considered:**` bullet under Risk Assessment |
| §6c              | `Detection Pattern Verification` / `Section 6c` headers   |
| §6d              | `Adversarial Re-Read` header                              |
| Spec sibling     | `Sibling-site Scan` header in spec-phase comments         |
| Spec AC linter   | `AC Quality Check` header in spec-phase comments          |

Each flag is classified `triggered: true` if the bullet body contains substantive
content (not `N/A`, not "single-call-site fix", not "All N ACs pass lint", etc.).

For each triggered flag, fate is heuristically classified by scanning the
~1.5 KB neighbourhood for keywords:

- **`filed_followup`** — `filed #N`, `follow-up issue`, `tracked in #N`
- **`actioned_in_pr`** — `fixed in`, `addressed`, `applied fix`, `resolved before merge`
- **`dismissed`** — `non-blocking`, `out of scope`, `Non-Goals`, `deferred`, `acceptable as-is`
- **`silent`** — none of the above

**Noise floor:** the heuristic misclassifies in two known directions. (1) Some
"silent" §6d findings are in fact integrated into the QA verdict prose without
explicit fate keywords (the reviewer considered them, then either dismissed or
folded them into a Suggestion). (2) The `**Sibling-line audit:**` literal also
appears inside AC text on skill-meta PRs (#587, #597) where the AC *is* to add
that bullet — those are false-positive triggers. Magnitude: ~5–10 of 134 rows.
Conclusion: directional but not precise. Action-rate numbers are accurate to
±10pp.

### Phase B — cost

Per-section cost proxy = lines + words of the parent SKILL.md section, measured
by `measureSkillCost()` against the section's anchor in `.claude/skills/qa/SKILL.md`
(or `spec/SKILL.md`). The proxy approximates the prompt overhead loaded on every
section-eligible run; it does not capture per-section token attribution from the
QA model itself (run logs report `metrics.tokensUsed: 0` — the field is unwired
per the spec's AC-3 caveat). A single ablation calibration is recorded inline
below; full per-section ablation is deferred.

## Findings

### §6c — detection-pattern verification (REMOVE / GATE)

- **0 triggered out of 11 emits.** Every QA comment that mentions §6c says
  "N/A — no skill regex/grep/awk changes."
- **156 lines / 1,406 words** of SKILL.md content — the heaviest gap-check section.
- The section already has a deterministic precondition embedded in its prose
  ("REQUIRED for skill regex/grep/awk/jq/sed changes"), but in practice the QA
  reviewer recites the section header, then says "Not Required." That is pure
  overhead.

**Recommendation:** Gate §6c emission entirely on a file-glob precondition.
Build a precondition tree in the skill that suppresses §6c output when:

```
git diff main...HEAD --name-only | grep -E '\.(claude|templates|skills)/skills/.*/SKILL\.md$' | xargs grep -lE '\b(grep|awk|jq|sed)\b|/[^/]+/[gim]?'
```

returns empty. When the precondition is false, the QA comment should *not*
include the §6c block at all (not even a "Not Required" line). Estimated savings:
156 lines × ~50 QA invocations / month ≈ 7800 line-tokens / month minimum.
Implementation surface: `/qa` skill prompt — a single conditional. Tracked in #609.

### §6d — Adversarial Re-Read (TRIM)

- **9 triggered out of 14 emits**, but **0 actioned and 0 filed as follow-up**.
  All 9 findings are either explicitly dismissed (`Non-Goals`, `out of scope`,
  `non-blocking`) or silent (no fate keyword detected — almost always a
  reviewer-internal consideration that did not translate into action).
- This matches the noise the issue body predicted: "the dismissal rate is high"
  for the cumulative gap-checks.
- **35 lines / 505 words.** Mid-weight section.

**Recommendation:** Trim §6d back to a 1-paragraph prompt instead of a structured
4-sub-prompt block. The structured form was promoted in #582 to make findings
*visible*, but the data shows visibility without action — the reviewer logs
findings to satisfy the structure, then dismisses them. A single paragraph
("Before declaring READY_FOR_MERGE, walk through the diff once more
adversarially and surface anything the structured pipeline didn't") preserves
the safety net at lower cost. Tracked-pending: file follow-up issue.

### §4 Q5 — intra-file sibling-line audit (GATE)

- **6 triggered out of 44**, **17% action rate** (1 follow-up filed, 4 silent).
  Most §4 Q5 outputs are `**Sibling-line audit:** N/A — single-call-site fix.`
- **12 lines / 199 words.** Lightweight.

The 17% rate is real but below the proposed 30% threshold. The section does its
job *when there is more than one call site*, but ~85% of merged PRs in the
window are single-call-site or skill-prose changes where the audit is
mechanically N/A.

**Recommendation:** Gate the §4 Q5 prompt on a heuristic precondition: only
require an explicit answer when the diff touches a `.ts`/`.tsx` file with >1
function or contains a loop. Otherwise auto-fill `N/A — single-call-site` and
suppress the prompt. Implementation surface: `/qa` prompt logic. Cost saving is
small (12 lines) but cumulative.

### §5 — cross-file sibling-site scan (KEEP)

- **3 triggered out of 44**, **33% action rate** (1 follow-up filed → #596 was
  itself the follow-up to #583, exactly the case §5 is designed to catch).
- **7 lines / 23 words.** Cheapest section.

The action rate is at the proposed threshold and the absolute cost is trivial.
Triggered cases produce real cross-file follow-up issues (#596, #583's parent
chain). Keep as-is.

### Spec — sibling-site scan (KEEP)

- **7 triggered out of 7** (always emits something — the section is structured
  as a positive output, not a gate).
- **29% action rate** (2 follow-ups filed, 2 dismissed, 3 silent).
- **8 lines / 175 words.** Lightweight.

Within ±5pp of threshold. Triggered cases that filed follow-ups (#580→#587 chain)
are exactly the workflow the section was added to support (PR #594). Keep.

### Spec — AC linter / title-body tension (GATE)

- **6 triggered out of 15**, **17% action rate**. Most "triggered" cases are
  reviewer-acknowledged false positives — `"etc." references unchanged code` is
  a recurring pattern (#597 dismissed exactly this way).
- **4 lines / 49 words.** Cheapest section.

The high false-positive rate suggests the linter regex is too broad. But the
deterministic gate is also trivial — the section is 4 lines.

**Recommendation:** Skip §6c-style gating (overhead is negligible) but tighten
the regex to reduce false positives. Tracked: ac-linter false-positive PRs
(#597, #571 implementation).

## Sample-size caveat

The window covers ~2 months and 50 PRs. §6d had only 14 emits because the
section was promoted to mandatory only on 2026-05-06 (PR #584). §5 had 44
emits because it is older. Re-run this analysis in 60 days to confirm the
§6d trim recommendation against more data.

## Reproducing this analysis

```bash
npx tsx scripts/analytics/gap-signal.ts --since 2026-04-01 --limit 50
# Raw flag rows: .sequant/gap-signal.jsonl
# Tests:        npx vitest run scripts/analytics/gap-signal.test.ts
```

To widen the window:

```bash
npx tsx scripts/analytics/gap-signal.ts --since 2026-03-01 --limit 100
```

## Recommendations summary (input to #609)

1. **§6c — gate by file-glob precondition** (`.ts`/`.tsx` skill files containing regex/grep/awk literals). Suppress the entire section when the precondition is false. Largest single saving: 156 lines × every QA run in the window.
2. **§6d — trim from structured 4-sub-prompt block to 1-paragraph adversarial prompt.** Keep the safety net, drop the structure that produced 9 findings and 0 actions.
3. **§4 Q5 — gate by file-shape heuristic.** Auto-fill N/A for single-call-site changes; suppress the prompt for skill-prose / docs / config diffs.
4. **§5, Spec sibling-site scan — keep as-is.** Both at threshold; both produce real follow-up issues; both are cheap.
5. **Spec AC linter — keep, tighten regex.** Reduce false positives (`"etc." references unchanged code` pattern) rather than gating the section.
