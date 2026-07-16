## Summary

Merge `/solve` into `/assess` to create a single entry point for issue triage. Instead of two commands ("what's the status?" vs "what's the workflow?"), `/assess` becomes the unified command: gather context, evaluate health, recommend an action, and — if the action is "proceed" — output the full workflow plan.

This also adds **lifecycle recommendations** so `/assess` can catch wasted work before it starts: stale PRs that need a rewrite, issues that were silently resolved by other PRs, overlapping issues that should be merged, references that no longer match the codebase, etc.

## Decision (from discussion)

- **Name:** `/assess` (absorbs `/solve`)
- **Mode:** Single mode — always does the full analysis (no `--plan` flag)
- `/solve` becomes an alias during transition, then deprecated

## Design Principles

Informed by Linear, Kubernetes, and Rust project triage patterns:

1. **Decision throughput over information density** — The first thing the user sees is the recommended action, not a wall of metadata. Everything else supports that decision.
2. **Fixed action vocabulary** — Every assessment exits through one of 6 doors. Predictable, learnable, no ambiguity.
3. **Show reasoning** — Every recommendation includes _why_. Users trust systems that explain themselves.
4. **Red flags first** — Surface problems (stale PR, codebase mismatch) before workflow planning. Catching wasted work is the highest-value output.
5. **Read-only, recommend-only** — Assess never takes action. It proposes, the user decides.

## Fixed Action Vocabulary

Every `/assess` output recommends exactly ONE of these actions:

| Action | Meaning | When |
|--------|---------|------|
| **PROCEED** | Ready for work — here's the workflow | Issue is clear, codebase matches, no blockers |
| **CLOSE** | Issue is outdated, resolved, or duplicate | Resolved by another PR, references don't exist, duplicates closed issue |
| **MERGE** | Overlaps with another open issue | Two issues cover 70%+ same scope, or one is a subset of the other |
| **REWRITE** | Existing PR/branch needs a fresh start | PR too far behind main, touched files diverged, stale abandoned PR |
| **CLARIFY** | Issue needs more information before work | No ACs, ambiguous requirements, missing repro steps, multiple valid interpretations |
| **PARK** | Valid but not actionable right now | Blocked on external dep, blocked on another issue, explicitly deferred |

## Health Check Signals

The health check section surfaces red flags that inform the action recommendation. Signals are grouped by category:

### Codebase Match
| Signal | Detection Method | Implication |
|--------|-----------------|-------------|
| Referenced files/APIs don't exist | Glob/Grep for paths and symbols mentioned in issue body | Issue may be outdated |
| Referenced files were heavily changed recently | `git log` on mentioned paths | Issue may have been addressed or invalidated |
| Issue describes behavior that now works differently | Codebase analysis of described patterns | Verify still relevant |

### PR / Branch Health
| Signal | Detection Method | Implication |
|--------|-----------------|-------------|
| PR exists but has merge conflicts | `gh pr view` status | Needs rebase or rewrite |
| PR is far behind main (100+ commits) | `git rev-list --count main..pr-branch` | Likely needs rewrite, not rebase |
| PR touched files that diverged on main | `git diff --name-only` cross-reference | Rebase will be painful or impossible |
| PR/branch is stale (30+ days no activity) | Timestamps | Consider fresh start |
| Draft PR with partial work | PR status | Assess whether to continue or restart |
| Worktree exists with uncommitted work | `git worktree list` + status check | Abandoned work, clean up |

### Overlap / Redundancy
| Signal | Detection Method | Implication |
|--------|-----------------|-------------|
| Another open issue covers similar scope | Compare titles/bodies of open issues | Consider merging |
| Duplicates a closed issue | Compare against recently closed | Close as duplicate |
| Was solved as side effect of another PR | Cross-reference changed files with issue references | Verify and close |

### Staleness / Blockers
| Signal | Detection Method | Implication |
|--------|-----------------|-------------|
| No activity in 14+ days | Timestamps | Flag as stale |
| Blocked on another issue | Issue body/comments mention dependencies | Park until unblocked |
| Blocked on external dependency | Comments indicate external blocker | Park with reason |
| Open questions unanswered in comments | Comment thread analysis | Clarify before proceeding |

## Output Format

The action is the headline. Supporting context follows in priority order.

### When action is PROCEED (healthy issue, ready for work):

```
#152 — Add user dashboard
Status: Open | Labels: ui, enhancement | Last activity: 3 days ago

→ PROCEED — Issue is clear, codebase matches, ready for work.

Health:
  ✓ References match codebase
  ✓ No conflicting PRs or worktrees
  ✓ No overlapping issues detected

AC Coverage: 4 criteria identified
  - Display dashboard widgets     NOT_STARTED
  - User preferences persistence  NOT_STARTED
  - Responsive layout             NOT_STARTED
  - Loading states                NOT_STARTED

Workflow: ui → spec → testgen → exec → test → qa

  npx sequant run 152 -q --testgen

Why this workflow:
  • ui label → includes /test for browser verification
  • Testable ACs → includes /testgen for test stubs
  • New feature → quality loop recommended
```

### When action is REWRITE (PR too far behind):

```
#87 — Refactor auth middleware
Status: Open | Labels: backend, refactor | Last activity: 45 days ago

→ REWRITE — PR #91 is 200+ commits behind main.
  3 of 5 files modified in the PR have diverged on main.
  Recommend closing PR #91 and starting fresh.

Health:
  ⚠ PR #91: 200 commits behind, last updated 43 days ago
  ⚠ Diverged files: src/middleware/auth.ts, src/lib/session.ts, src/api/routes.ts
  ✓ Issue requirements still match current codebase

AC Coverage: 3 criteria (from prior /spec comment)
  - Extract middleware to separate module  IN_PROGRESS (partial in PR)
  - Add request validation                NOT_STARTED
  - Update tests                          NOT_STARTED

If restarting:
  npx sequant run 87 -q
```

### When action is CLOSE (resolved by another PR):

```
#64 — Support custom theme colors
Status: Open | Labels: ui | Last activity: 90 days ago

→ CLOSE — Likely resolved by PR #142 (merged 2 weeks ago).
  PR #142 added theme customization to src/components/ThemeProvider.tsx,
  covering the core functionality described in this issue.

Health:
  ⚠ Core referenced files changed substantially by PR #142
  ⚠ No activity in 90 days
  ℹ Verify with issue author before closing
```

### When action is MERGE (overlapping issues):

```
#201 — Add CSV export to reports
Status: Open | Labels: feature | Last activity: 5 days ago

→ MERGE — Significant overlap with #198 (Add export functionality).
  #198 covers CSV, PDF, and JSON export for the same report components.
  Recommend consolidating into #198 as the comprehensive issue.

Health:
  ⚠ #198 is a superset — covers all export formats including CSV
  ⚠ Both issues reference src/components/ReportView.tsx
  ✓ Neither issue has work in progress
```

### When action is CLARIFY:

```
#310 — Improve performance
Status: Open | Labels: enhancement | Last activity: 1 day ago

→ CLARIFY — Issue is too vague to plan a workflow.
  No specific components, metrics, or acceptance criteria identified.
  Need: which pages/operations are slow, target metrics, reproduction steps.

Health:
  ⚠ No acceptance criteria (explicit or inferable)
  ⚠ No specific files or components referenced
  ✓ Issue is fresh (1 day old)
```

### When action is PARK:

```
#189 — Integrate with Stripe webhooks
Status: Open | Labels: backend, blocked | Last activity: 20 days ago

→ PARK — Blocked on #175 (Payment service refactor).
  #175 is restructuring the payment module that webhooks depend on.
  Resume after #175 is merged.

Health:
  ⚠ Depends on #175 (currently in implementation phase)
  ⚠ No activity in 20 days (expected — waiting on dependency)
  ✓ Issue requirements are clear and still valid
```

## What Gets Absorbed from /solve

The following `/solve` capabilities move into `/assess` under the PROCEED path:

- **Label-based workflow detection** — ui/backend/bug/complex/security labels → phase selection
- **Quality loop recommendation** — based on labels and issue complexity
- **Chain mode detection** — dependency analysis for multi-issue runs
- **QA gate detection** — for chained issues with tight dependencies
- **Feature branch detection** — `--base` flag recommendation
- **Testgen detection** — testable ACs trigger testgen phase
- **Conflict detection** — in-flight worktree overlap warnings
- **CLI command generation** — the `npx sequant run` command with flags
- **Phase signal integration** — solve-comment-parser.ts compatibility

## Migration Plan

1. **Phase 1: Merge** — Add /solve capabilities + lifecycle actions to /assess skill
2. **Phase 2: Alias** — `/solve` invokes `/assess` with a deprecation notice
3. **Phase 3: Remove** — Delete `/solve` skill, update all references
4. **Code changes:** `solve-comment-parser.ts` → rename to `assess-comment-parser.ts` or generalize. Phase signal system continues to work — the comment format is what matters, not the skill name.

## What Reviewers Should Validate

- [ ] Single `/assess` command replaces both `/assess` and `/solve` without losing capabilities
- [ ] All 6 actions are reachable and correctly triggered by their signals
- [ ] Health check catches real problems without false positives (especially codebase match and overlap detection)
- [ ] PROCEED path generates the same quality workflow recommendations as current `/solve`
- [ ] Output format prioritizes the action — scannable in under 5 seconds
- [ ] Overlap/duplicate detection doesn't make `/assess` noticeably slower
- [ ] Phase signal integration still works (solve-comment-parser compatibility)
- [ ] Edge case: issue with BOTH a stale PR and overlapping issue — which action wins? (Recommend: most actionable one, with others noted in Health)

## Acceptance Criteria

- [ ] `/assess <issue>` produces a unified assessment with one of 6 actions (PROCEED, CLOSE, MERGE, REWRITE, CLARIFY, PARK)
- [ ] PROCEED action includes full workflow recommendation (phases, CLI command, flags) — equivalent to current `/solve` output
- [ ] Health check detects: codebase reference mismatches, stale/diverged PRs, overlapping open issues, staleness, blockers
- [ ] Each action includes reasoning (why this recommendation)
- [ ] Output format leads with the action recommendation, not metadata
- [ ] `/solve` works as an alias for `/assess` with deprecation notice
- [ ] `solve-comment-parser.ts` updated or generalized to parse new assess output format
- [ ] Phase signal system (`phase-signal.ts`) continues to work with assess output
- [ ] Multi-issue support: `/assess 152 153` assesses each issue independently
- [ ] Skill remains read-only (allowed-tools unchanged from current /assess)
- [ ] Label review section preserved from current /assess
- [ ] Confidence level / meta-assessment preserved from current /assess
