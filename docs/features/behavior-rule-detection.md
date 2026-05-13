# Behavior-Rule Touchpoint Detection

Catches a recurring class of bug where an issue's AC describes a behavior rule (e.g. *"default becomes X"*, *"always include Y"*, *"never skip Z"*) and the rule is implemented at two places — a skill prompt **and** runtime TypeScript — but only one site gets updated.

The detector runs in two phases:

- **`/spec`** — proactively lists every touchpoint that may need to change, so you can scope the work upfront.
- **`/qa`** — verifies the *old* rule's implementation has been removed from every touchpoint in the diff blast radius. Survivors fail the AC.

You don't invoke this directly. Both phases run it automatically when an AC matches the behavior-rule heuristic.

## Trigger Conditions

The detector fires when an AC description matches either:

- **≥ 2 distinct behavior-rule keywords** (case-insensitive): `default`, `always`, `never`, `rule`, `behavior`, `skip`
- **An explicit pattern**: `always X unless Y`, `never X unless Y`, `default X when Y`

Examples that **trigger**:

- "Default `/assess` spec phase becomes ON; never auto-skip bug/docs labels"
- "Always include the worktree path; the rule applies in CI and local runs"

Examples that **don't trigger**:

- "Update line 42 of `foo.ts`" (no behavior keywords)
- "Set the default value to 5" (one keyword, no rule semantics)

When no AC in the issue triggers, both phases short-circuit immediately — no grep cost.

## What You See in `/spec` Output

When at least one AC triggers and touchpoints are found, `/spec`'s plan includes a new section between **Implementation Plan** and **Design Review**:

```markdown
## Rule Touchpoints

| AC   | Touchpoint                              | Snippet                                |
| ---- | --------------------------------------- | -------------------------------------- |
| AC-1 | .claude/skills/assess/SKILL.md:412      | `spec phase defaults to ON`            |
| AC-1 | src/lib/phases/phase-mapper.ts:88       | `if (labels.includes("bug")) ...`      |
| AC-1 | src/lib/workflow/batch-executor.ts:202  | `BUG_LABELS short-circuits to exec→qa` |
```

This is the front-line catch — review the table and decide which touchpoints belong in scope. The section is **omitted entirely** when no AC triggers or no touchpoints are found.

## What You See in `/qa` Output

When the same triggers fire at QA time, `/qa` runs a survival check on the diff blast radius and renders:

```markdown
### Behavior-Rule Survival Check

| AC   | Triggered? | Survivors                                      | Status            |
| ---- | ---------- | ---------------------------------------------- | ----------------- |
| AC-1 | Yes        | src/lib/phases/phase-mapper.ts:88 — `BUG_LABELS includes…` | Survivors Found   |
| AC-2 | No         | —                                              | N/A               |

**Status:** Survivors Found
```

| Status | What it means |
|---|---|
| **Clean** | Detector triggered, no inverse symbols survive in the diff blast radius. |
| **Survivors Found** | One or more inverse symbols / inverse-keyword lines remain. The relevant AC is marked `NOT_MET` and the verdict floors at `AC_NOT_MET`. |
| **N/A** | No AC triggers — section is skipped entirely. |

A survival forces a `/loop` iteration rather than letting `READY_FOR_MERGE` slip through.

## Motivating Example

Issue #533 (*"default `/assess` spec phase ON, remove bug/docs auto-skip"*) shipped with the SKILL.md updated but the runtime CLI's `BUG_LABELS` / `DOCS_LABELS` short-circuit still active. `/qa` originally gave `READY_FOR_MERGE`; the gap was caught only by manual user follow-up and required two additional commits + updates to 4 test files and 4 docs. This detector is designed to catch the next #533-class issue automatically.

## What to Expect

- **No new flags or config.** Detection runs automatically inside `/spec` and `/qa` based on AC text.
- **Cheap when not applicable.** When no AC triggers, both phases skip the grep — no perceptible cost.
- **Heuristic, not perfect.** Some rules are inline conditionals with no named symbol. The `/qa` survival check falls back to inverse English phrasing search when no symbol candidates match.
- **Detection only — no auto-fix.** The user / `/exec` applies fixes. `/spec` surfaces; `/qa` verifies.
- **Internal CI behavior.** Edits to skill prompts must stay in sync across `.claude/skills/`, `templates/skills/`, and `skills/`. The 3-dir sync check verifies this; users typically don't see it.

## Reference

The shared heuristic lives at `.claude/skills/_shared/references/behavior-rule-detection.md` — trigger keywords, grep patterns, symbol categories, false-positive guards. Both `/spec` and `/qa` link to it.

| Behavior | Where |
|---|---|
| Trigger check | `src/lib/heuristics/behavior-rule-detector.ts` → `detectBehaviorRule(ac)` |
| Touchpoint enumeration (used by `/spec`) | same module → `findTouchpoints(ac, cwd)` |
| Survivor enumeration (used by `/qa`) | same module → `findSurvivingInverseSymbols(ac, cwd, diffPaths)` |
| Reference doc consumed by both skills | `.claude/skills/_shared/references/behavior-rule-detection.md` |

## Troubleshooting

### `/spec` did not produce a "Rule Touchpoints" section but I expected one

**Cause:** Either no AC matched the heuristic (< 2 keywords AND no explicit pattern), or touchpoint search found nothing in the codebase for the AC's symbols.

**Fix:** Reword the AC to include explicit behavior phrasing (`always X unless Y`, `default X when Y`), or add the missed touchpoint manually to your implementation plan.

### `/qa` reports "Survivors Found" but the survivor is intentional (out of scope)

**Cause:** The survivor lives in the diff blast radius and matches an inverse pattern of the new rule. The detector treats this as a contradiction.

**Fix:** Either remove the survivor, scope it explicitly into the issue (and update the AC to mention it), or close the issue as `wontfix` if the divergence is intentional. There is no per-rule allow-list — the design favors surfacing over false negatives.

### Detection runs on every `/qa` even when the AC has nothing to do with behavior

**Cause:** The trigger check itself is cheap (regex on AC text); only the per-AC grep is conditional. If no AC triggers, no grep runs.

**Fix:** No fix needed — the cost is the trigger check alone (sub-millisecond) when nothing applies.

---

*Documents issue #552 (detect behavior-rule implementations across skill+runtime touchpoints).*
