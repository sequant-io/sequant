# Sequant Workflow Analysis — March 2026

**Generated:** 2026-03-25
**Data range:** 2026-01-09 to 2026-03-25
**Runs analyzed:** 82 runs, 167 issues

## Baselines

| Metric | Value |
|--------|-------|
| Overall success rate | 68.3% |
| Average run duration | 27m 52s |
| Single-issue success rate | 71.9% |
| Chain-mode success rate | 50.0% |

### Phase Durations (avg)

| Phase | Avg Duration | Count |
|-------|-------------|-------|
| spec | 3m 56s | 139 |
| exec | 6m 11s | 171 |
| qa | 4m 16s | 134 |
| testgen | 4m 33s | 14 |
| test | 2m 26s | 2 |

## Top 5 Optimization Targets (AC-6)

Ranked by estimated impact (frequency x severity):

### 1. Tooling Failures (60.6% of all failures)

**Impact: HIGH** — 43 of 71 failed phases are generic "process exited with code 1" errors. These are opaque and undiagnosable from log data alone.

**Root cause:** Claude Code process crashes are logged as generic exit codes without structured error context. The actual failure reason (context overflow, API error, hook failure) is lost.

**Recommended action:** Improve error capture in the phase runner to extract structured error info before the process exits. Create follow-up issue.

### 2. Low First-Pass QA Rate (38.2%)

**Impact: HIGH** — Only 38.2% of issues pass QA on the first attempt. Each additional QA iteration costs ~4m 16s plus the fix cycle time. 18 issues required multiple QA attempts, with 6 requiring 3 attempts.

**Root cause candidates:**
- 44% of QA phases have no verdict recorded (early logs before verdict tracking)
- Excluding no-verdict phases: first-pass rate among issues with verdicts is higher
- Common first-verdict failures: AC_NOT_MET (8 issues), AC_MET_BUT_NOT_A_PLUS (5 issues)

**Recommended action:** Investigate whether exec quality can be improved to reduce QA iterations. The spec-to-exec handoff may be losing acceptance criteria precision. Create follow-up issue.

### 3. Documentation Issues: 42% Success Rate

**Impact: MEDIUM** — Documentation-labeled issues have the lowest success rate of any significant label category (42% vs 77% for enhancement, 100% for bug).

**Root cause hypothesis:** Documentation issues may require different workflow phases or have ambiguous ACs. The standard spec-exec-qa pipeline may be a poor fit for doc-only work.

**Recommended action:** Review failed documentation runs to identify common patterns. Consider a lighter workflow for docs-only issues (skip spec, simpler QA).

### 4. Chain-Mode Degradation (50% vs 72% single-issue)

**Impact: MEDIUM** — Chain mode (sequential issues branching from each other) succeeds at only 50%, significantly below single-issue runs. Multi-issue runs in general are 67% vs 72%.

**Root cause hypothesis:** Chain mode accumulates technical debt across issues — a small failure in issue N breaks issue N+1. Worktree conflicts and merge issues compound.

**Recommended action:** Evaluate whether chain mode is worth the risk. Consider defaulting to parallel worktrees instead.

### 5. Spec Phase Failures (12 failures, 8.6% of spec runs)

**Impact: MEDIUM** — Spec failures prevent any work from starting. 12 spec failures out of 139 runs (8.6%) means roughly 1 in 12 issues can't even begin.

**Root cause:** Likely GitHub API issues, context overflow on complex issues, or rate limits during issue fetch.

**Recommended action:** Add retry logic to spec phase for transient failures.

## Decision Framework (AC-7)

| Finding | Category | Action Type | Priority | Est. Effort |
|---------|----------|-------------|----------|-------------|
| Opaque tooling failures (60.6%) | Error handling | Code change (phase runner) | P1 | Medium |
| Low first-pass QA rate (38.2%) | Workflow quality | Investigation + prompt change | P1 | Large |
| Doc issues 42% success | Workflow fit | Config change (lighter pipeline) | P2 | Small |
| Chain-mode 50% success | Feature design | Investigation + config | P2 | Medium |
| Spec failures 8.6% | Reliability | Code change (retry logic) | P3 | Small |
| No-verdict QA phases (44%) | Data quality | Code change (backfill) | P3 | Small |
| Rate limits (5.6% of failures) | Infrastructure | Config (throttling) | P3 | Small |

### Action Type Key

- **Code change:** Modify TypeScript source (phase runner, stats, etc.)
- **Prompt change:** Update skill SKILL.md prompts (spec, exec, qa)
- **Config change:** Adjust default settings or workflow parameters
- **Investigation:** Deeper analysis needed before prescribing a fix

## QA Verdict Distribution

| Verdict | Count | Percentage |
|---------|-------|------------|
| no_verdict | 59 | 44.0% |
| READY_FOR_MERGE | 49 | 36.6% |
| AC_NOT_MET | 13 | 9.7% |
| AC_MET_BUT_NOT_A_PLUS | 11 | 8.2% |
| NEEDS_VERIFICATION | 2 | 1.5% |

**Note:** The high no_verdict rate (44%) is an artifact of early log versions before verdict tracking was implemented. Excluding no-verdict phases, the verdict distribution is: READY_FOR_MERGE 65.3%, AC_NOT_MET 17.3%, AC_MET_BUT_NOT_A_PLUS 14.7%, NEEDS_VERIFICATION 2.7%.

## Temporal Trends

Success rate improved from 44% in week 1 to 79% in the most recent week, with a dip during weeks with more complex issues (Jan 26: 68%, Mar 16: 40%). Average duration increased as issues became more complex (11m early to 46m recent).

## Segmentation by Label

| Label | Issues | Success Rate | Avg Duration |
|-------|--------|-------------|-------------|
| bug | 17 | 100% | 10m 12s |
| planned | 17 | 82% | 8m 3s |
| cli | 17 | 82% | 17m 41s |
| enhancement | 84 | 77% | 15m 35s |
| auto-ready | 16 | 88% | 18m 37s |
| multi-agent | 13 | 69% | 22m 13s |
| documentation | 12 | 42% | 8m 44s |

**Key insight:** Bug fixes are 100% successful — well-scoped, clear ACs, predictable changes. Multi-agent and documentation issues are most challenging.

## Repeatable Analysis Approach (AC-10)

To re-run this analysis after workflow changes:

```bash
# Full human-readable report
npx tsx scripts/analytics/analyze-runs.ts

# JSON output for programmatic processing
npx tsx scripts/analytics/analyze-runs.ts --json

# Custom log directory
npx tsx scripts/analytics/analyze-runs.ts --path /path/to/logs

# Enhanced stats with detailed metrics
npx sequant stats --detailed
```

The analysis script loads all `.sequant/logs/run-*.json` files and computes:
1. **Baselines** — success rates, durations, chain vs single mode
2. **Temporal trends** — weekly buckets showing progression
3. **QA analysis** — verdict distribution and first-pass rate
4. **Failure forensics** — categorization by failure mode
5. **Segmentation** — per-label and per-issue-count breakdowns

Compare against this baseline report to measure the impact of optimizations.
