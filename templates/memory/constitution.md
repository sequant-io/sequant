# {{PROJECT_NAME}} Agent Contract

This document is the enforceable contract surface for AI-assisted development in this project. Every section either machine-checked or referenced by a named skill at a named decision point. Values with no consumer are not present.

---

## 1. Definition of Done

Every PR must pass all gates below before merge. Verified by `/qa` §7 — the table is generated from that section and cannot drift from it (`lint:constitution-dod` fails CI on divergence).

**These are project-wide gates. Do not restate them as issue-level ACs.**

<!-- BEGIN:DOD-GATES -->
| Gate | Trigger | Verdict impact |
|------|---------|----------------|
| All ACs MET | any `NOT_MET` or `PARTIALLY_MET` | `AC_NOT_MET` — blocks merge |
| Detection patterns (§6c) | `Failed` | `AC_NOT_MET` — blocks merge |
| Behavior-rule check (§6e) | `Survivors Found` | `AC_NOT_MET` — blocks merge |
| Trust boundary (§6f) | `Injection Acted On` | `AC_NOT_MET` — blocks merge |
| CLI registration (§2h) | `Failed` | `AC_NOT_MET` — blocks merge |
| Mutation verification (§6i) | `Failed` | `AC_NOT_MET` — blocks merge |
| Adversarial re-read (§6d) | `Severe Gap` | `AC_NOT_MET` — blocks merge |
| Skill verification (§6a) | `Failed` | `AC_MET_BUT_NOT_A_PLUS` — cannot be A+ |
| Script execution evidence | `Incomplete` | `AC_MET_BUT_NOT_A_PLUS` — cannot be A+ |
| Declared evidence (§6h) | `Incomplete` | `AC_MET_BUT_NOT_A_PLUS` — cannot be A+ |
| Mutation verification (§6i) | `Missing` | `AC_MET_BUT_NOT_A_PLUS` — cannot be A+ |
| Script verification (§11) | `Not Verified` | `AC_MET_BUT_NOT_A_PLUS` — cannot be A+ |
| CHANGELOG entry (§10a) | both conditions true | `AC_MET_BUT_NOT_A_PLUS` — cannot be A+ |
| Quality plan (Phase 0b) | both conditions true | `AC_MET_BUT_NOT_A_PLUS` — cannot be A+ |
| Browser test | condition true | `AC_MET_BUT_NOT_A_PLUS` — cannot be A+ |
| Pending verifications | count `> 0` | `NEEDS_VERIFICATION` — holds for external verification |
| Quality plan (Phase 0b) | `Partial` | `AC_MET_BUT_NOT_A_PLUS` — cannot be A+ |
| Smoke tests (§6b) | `Partial` | `AC_MET_BUT_NOT_A_PLUS` — cannot be A+ |
| Detection patterns (§6c) | `Insufficient Samples` | `AC_MET_BUT_NOT_A_PLUS` — cannot be A+ |
| Detection patterns (§6c) | `Skipped` | `AC_MET_BUT_NOT_A_PLUS` — cannot be A+ |
| Adversarial re-read (§6d) | `Gaps Found` | `AC_MET_BUT_NOT_A_PLUS` — cannot be A+ |
| Improvement suggestions | list non-empty | `AC_MET_BUT_NOT_A_PLUS` — cannot be A+ |
<!-- END:DOD-GATES -->

---

## 2. AC Authoring Standard

Referenced by `/spec`'s AC Quality Check step when flagging lint warnings.

### Format rules

**Write each AC on a single line.** The parser is line-anchored; an AC that wraps to a second line is silently truncated at the first newline, producing a partial description with no `Evidence:` or `Risk:` clause. This is the most common AC-hygiene defect in this repo.

**Required fields for testable ACs:**

| Field | Purpose | Required when |
|-------|---------|---------------|
| `Evidence:` | Names the artifact that proves the AC was met | AC is verifiable by code review or test |
| `Risk:` | Names the failure mode if this AC is wrong | AC has a non-obvious failure mode |
| `Human decision` | Flags the AC as requiring human judgment | AC cannot be verified mechanically |

**Non-Goals section:** Every issue must have a `## Non-Goals` section. Scope without a boundary is unbounded scope. The Non-Goals section is where you declare what the issue explicitly does not do.

### Examples

**Bad** (three violations on one AC):
```
- [ ] **AC-3:** The feature should work correctly and handle errors
  gracefully with good test coverage.
```
Problems: wraps to second line (parser truncates), "work correctly" is not measurable, no `Evidence:` clause.

**Good** (single line, measurable, evidence declared):
```
- [ ] **AC-3:** `/spec`'s AC Quality Check output references the constitution AC standard. Evidence: scoped gate test on the spec skill's reference string, mutation-verified.
```

---

## 3. Boundaries

Every rule below names its enforcing mechanism. Rules without a named enforcer are not in this section.

| Rule | Enforcing mechanism |
|------|---------------------|
| No force-push or amend on pushed branches | `templates/hooks/pre-tool.sh` (pre-tool hook, `HOOK_BLOCKED: Force push`) |
| No edits outside the issue worktree | `templates/hooks/pre-tool.sh` (worktree-only editing guard) |
| Protected paths require explicit override | `settings.riskPaths` (settings key; override prompt required) |
| Gate tests must be mutation-verified | `/qa` §6i + `SEQUANT_MUTATION` marker in PR body (#939); `Missing` caps at `AC_MET_BUT_NOT_A_PLUS`, `Failed` floors at `AC_NOT_MET` |
| All §1 Definition of Done gates | `/qa` §7 verdict algorithm (see §1 above) |

---

## 4. Budgets & Stop Conditions

### Iteration and token caps

| Cap | Setting key | Default |
|-----|-------------|---------|
| Quality-loop max iterations | `ready.maxIterations` | 3 |
| Auto-wait budget (rate-limit windows) | `run.autoWaitMinutes` | 0 (off) |

When a cap is reached, the run stops at the human merge gate rather than continuing indefinitely.

### Stop and hold states

The workflow stops or holds at these states — do not attempt to continue past them:

| State | Meaning | Action |
|-------|---------|--------|
| `waiting_for_human_merge` | All gates passed; PR is open | Human reviews and merges |
| `awaiting_verification` | At least one AC is `PENDING` external verification | Wait for the external signal; see [`docs/features/qa-verdict-workflow-states.md`](../../docs/features/qa-verdict-workflow-states.md) |
| `blocked` | A guard halted the run | Investigate the block; do not bypass |

### Gap-prompt discipline

**Diagnostic prompts are cheap and high-yield. Imperative prompts require triage first.**

- **Diagnostic** ("what are the gaps?"): run freely. Surfaces unknowns at low cost.
- **Imperative** ("fix all gaps"): requires triage first. An unfocused imperative prompt against a list of gaps produces shallow patches for every item rather than deep fixes for the real ones. The 2026-08 incident (#930) demonstrated this directly: an imperative "fix all gaps" run against a QA verdict produced 12 surface-level changes that passed re-QA but left the root-cause gap intact, requiring a third QA cycle.

When QA returns gaps: run a diagnostic first ("which gap is the most blocking?"), then issue a targeted imperative for that gap specifically.

---

## 5. Stack-Specific Notes

{{STACK_NOTES}}

---

## Project-Specific Notes

<!-- Add your project-specific guidelines below this line.
     This section is preserved across `sequant update` and `sync` runs
     (it is in CUSTOMIZABLE_FILES). Everything above is updated automatically. -->
