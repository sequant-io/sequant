# QA First-Pass Rate Analysis

**Date:** 2026-03-25
**Issue:** #448
**Baseline source:** `docs/reference/workflow-analysis-2026-03.md`

## Baseline Calibration

Two baselines exist depending on how "no verdict" phases (early logs) are treated:

| Baseline | Value | Includes | Recommended Use |
|----------|-------|----------|-----------------|
| Raw rate | 38.2% | All 134 QA phases (59 with no verdict) | Historical comparison |
| Tracked rate | 65.3% | 75 QA phases with recorded verdicts | Improvement measurement |

**Recommendation:** Use the **tracked rate (65.3%)** as the operational baseline. The 44% of QA phases with no verdict are artifacts of early log formats before verdict tracking was implemented — they are not failures.

**Target:** >75% first-pass tracked rate.

## Root Cause Analysis

### Issues Analyzed

All 6 issues that required 3+ QA attempts (from workflow analysis):

| Issue | Title | QA Attempts | Root Cause Category |
|-------|-------|-------------|---------------------|
| #215 | Enhanced CLI UI | 3 | Test coverage gap + lint not run pre-PR |
| #223 | Track derived ACs | 3 | Documentation scope iteration |
| #228 | QA caching | 3 | Test environment isolation |
| #239 | Scope assessment | 3 | Test coverage gap (missing tests for new functions) |
| #393 | MCP landing page | 3 | Implementation detection failure (cross-repo) |
| #413 | Design review section | 3 | Implementation detection failure (prompt-only changes) |

### Failure Pattern Categorization

| Pattern | Issues | Frequency | Description |
|---------|--------|-----------|-------------|
| **Implementation detection false negatives** | #393, #413 | 33% (2/6) | QA reports "NOT FOUND" when implementation exists but is in a different repo or consists only of .md file changes |
| **Test coverage gaps** | #215, #228, #239 | 50% (3/6) | Changed source files have no corresponding test files, or tests don't cover the actual change |
| **Lint/build not run pre-PR** | #215 | 17% (1/6) | ESLint errors (require() vs import, unused vars) caught by CI but not by exec locally |
| **Incomplete self-verification** | #223 | 17% (1/6) | Exec declares AC complete but QA finds scope/documentation gaps on re-examination |

### Detail: Implementation Detection Failures (33%)

**#393 — Cross-repo false negative:**
- Issue tracked in `sequant` repo, implementation in `sequant-landing` repo
- QA ran `git diff main..HEAD` in sequant repo — found nothing
- Exec progress comment mentioned cross-repo work, but QA didn't check comments
- Result: 2 QA passes returned "NOT FOUND" before cross-repo awareness was added

**#413 — Prompt-only false negative:**
- Implementation was entirely in SKILL.md files (markdown prompt changes)
- QA detection looked for TypeScript changes; .md changes were not counted as implementation
- Result: 3 QA passes returned "NOT FOUND" before prompt-only detection was fixed

### Detail: Test Coverage Gaps (50%)

**#215 — CLI UI module:**
- New `cli-ui.ts` module (759 lines) had 73 unit tests but QA flagged:
  - Missing tests for `logs.ts` and `bin/cli.ts` integration
  - Bundle size interpretation not tested
- First QA: `AC_MET_BUT_NOT_A_PLUS` (not `READY_FOR_MERGE`)
- Second QA: ESLint failures in CI caught require() vs import issue

**#228 — QA caching:**
- 36 unit tests for `qa-cache.ts` but:
  - Test environment pollution (`SEQUANT_ORCHESTRATOR` env var leaking between tests)
  - Integration test gaps around cache invalidation
- Required iteration to isolate test environments

**#239 — Scope assessment:**
- Implementation complete but:
  - Missing tests for `updateScopeAssessment` and `getScopeAssessment` state functions
  - QA flagged the gap; tests were added post-merge as follow-up

## Changes Implemented

### Change 1: Exec — "Simulate QA" Pre-PR Checkpoint (Section 3e2)

**Targets:** Test coverage gaps (50% of failures), lint issues (17%)

Added a mandatory "Simulate QA Before PR" section that requires exec to:
1. Re-read each AC literally and verify against implementation
2. Check test-to-change alignment (every changed source file should have a corresponding test)
3. Adopt the QA reviewer's perspective before declaring done

**Location:** `.claude/skills/exec/SKILL.md` — between Pre-PR AC Verification and CHANGELOG Update

### Change 2: Exec — Strengthened Self-Evaluation Questions

**Targets:** Test coverage gaps, lint issues

Added 2 questions to the Adversarial Self-Evaluation:
- "For each changed source file, does a corresponding test file exist?"
- "Did I run `npm run lint` and fix all errors?"

**Location:** `.claude/skills/exec/SKILL.md` — Section 5 (Adversarial Self-Evaluation)

### Change 3: QA — Improved Implementation Detection

**Targets:** Implementation detection false negatives (33% of failures)

Enhanced Phase 0 (Implementation Status Check) to:
1. Check `git diff --name-only` for ANY file changes (not just .ts/.tsx)
2. Explicitly document that prompt-only and markdown-only changes are valid implementations
3. Add a "False Negative Prevention" table documenting common causes and fixes
4. Add a safety check before early exit that verifies no files were changed

**Location:** `.claude/skills/qa/SKILL.md` — Phase 0 (Implementation Status Check)

## Measurement Plan

**To measure improvement after these changes:**

```bash
# Run the analytics script
npx tsx scripts/analytics/analyze-runs.ts

# Check QA verdict distribution
# Target: READY_FOR_MERGE > 75% of tracked verdicts (up from 65.3%)
```

**Expected impact by pattern:**
- Implementation detection failures: Should drop to ~0% (explicit .md detection + safety check)
- Test coverage gaps: Should reduce by ~50% (exec now checks before PR creation)
- Lint issues: Should drop to ~0% (exec self-eval now requires lint verification)

**Net target:** First-pass tracked rate from 65.3% to >75%
