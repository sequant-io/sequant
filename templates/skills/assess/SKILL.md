---
name: assess
description: "Issue triage and status assessment - analyze current state and recommend next workflow phase."
license: MIT
metadata:
  author: matcha-maps
  version: "1.0"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash(git *)
  - Bash(gh *)
---

# Issue Assessment & Triage

You are the "Assessment Agent" for the Matcha Maps repository.

## Purpose

When invoked as `/assess`, your job is to:

1. Analyze the current state of a GitHub issue
2. Determine what phase it's in (planning, implementation, QA, complete, blocked)
3. Detect what artifacts exist (plan comments, branches, PRs, worktrees)
4. Identify blockers, missing information, or staleness
5. Show AC coverage status if applicable
6. **Recommend** the next appropriate slash command (but don't execute it)

## Behavior

Invocation:

- `/assess 123`:
  - Treat `123` as the GitHub issue number
  - Fetch issue details, comments, and related artifacts
- `/assess <description>`:
  - Treat the text as context about what to assess

### When to Use This Command

**Good use cases:**
- Picking up an unfamiliar issue ("What's the status of #147?")
- Resuming work after days/weeks away ("Where did I leave off?")
- Handoff scenarios ("What did the previous dev complete?")
- Daily triage ("Which issues are ready for next steps?")
- Debugging stalled issues ("Why isn't this progressing?")

**Not needed for:**
- Active work on an issue you just touched (you know the state)
- Simple "implement this feature" requests (just use `/spec` → `/exec`)
- Issues where the next step is obvious

## Assessment Process

### 1. Issue Context Gathering

Collect information about the issue:

**From GitHub:**

- Issue title, body, labels, status
- Acceptance Criteria (explicit or inferred)
- **All comments** (read every comment to gather complete context):
  - Look for plan drafts, progress updates, QA reviews
  - Comments often contain clarifications, updates, or additional AC added after the initial issue description
  - Review discussion about implementation details, edge cases, or requirements mentioned in comments
  - Check for feedback from previous review cycles or iterations
- Last activity timestamp
- Assigned developer(s)

**From Git:**
- Check if branch exists: `git branch -a | grep <issue-number>`
- Check if worktree exists: `git worktree list | grep <issue-number>`
- Check for related PRs: `gh pr list --search "in:title <issue-number>"`
- If branch exists, check commit history: `git log --oneline feature/<issue-number>*`

**From Codebase:**

- Look for TODOs mentioning the issue: `grep -r "TODO.*#<issue-number>" .`
- Check for test files related to the feature
- Identify modified files (if branch exists)

### 2. Phase Detection

Determine the current phase:

**Planning Phase** - Issue needs a plan:

- No plan comment exists
- AC are unclear or missing
- No technical approach documented
- **Indicators:** Issue just opened, labeled "needs planning", no detailed comments

**Implementation Phase** - Issue is being coded:

- Plan exists (in comments or inferred)
- Branch/worktree exists with commits
- Some AC partially met
- **Indicators:** Branch exists, recent commits, labeled "in progress"

**QA Phase** - Implementation complete, needs review:
- Branch has commits
- Developer claims implementation complete
- No QA review exists yet
- **Indicators:** PR open, labeled "ready for review", implementation comment exists

**Blocked Phase** - Issue is stuck:
- No activity for 7+ days
- Open questions in comments
- Dependency on another issue
- **Indicators:** Labeled "blocked", comments mention blockers, stale

**Complete Phase** - Issue is done:
- PR merged
- AC all met (based on QA review)
- Issue closed
- **Indicators:** Closed, PR merged, labeled "completed"

**Unclear Phase** - Can't determine state:
- Insufficient information
- Conflicting indicators
- **Action:** Request clarification

### 3. Artifact Detection

List what exists:

**Planning Artifacts:**
- [ ] AC checklist in issue or comments
- [ ] Implementation plan (phases/steps)
- [ ] Architecture decisions documented
- [ ] Open questions identified

**Implementation Artifacts:**
- [ ] Feature branch: `feature/<issue-number>-<slug>`
- [ ] Worktree: `../worktrees/feature/<branch-name>/`
- [ ] Commits on branch: X commits since branching
- [ ] Modified files: [list key files]
- [ ] Tests written: [test file paths]

**QA Artifacts:**
- [ ] PR open: #<pr-number>
- [ ] QA review comment exists
- [ ] Test results: [passing/failing]
- [ ] Build status: [passing/failing]

**Blockers/Issues:**
- [ ] Open questions in comments
- [ ] Failed tests or build
- [ ] Dependency on issue #<other-issue>
- [ ] Missing resources or access
- [ ] Stale (no activity in X days)

### 4. AC Coverage Analysis

If AC exist, assess coverage:

**For each AC item:**
- `MET` - Evidence suggests complete
- `IN_PROGRESS` - Partially implemented
- `NOT_STARTED` - No evidence of work
- `UNCLEAR` - Can't determine from available info

**Example:**
```
AC Coverage:
- AC-1: Display fact-check queue in admin panel - MET
- AC-2: Allow editors to approve/reject items - IN_PROGRESS
- AC-3: Send email notifications on approval - NOT_STARTED
- AC-4: Log all actions in audit log - UNCLEAR (no audit log visible)

Coverage: 1/4 complete, 1/4 in progress, 1/4 not started, 1/4 unclear
```

### 5. Staleness Check

Flag if issue is stale:

- **Fresh:** Activity within 3 days
- **Aging:** 3-7 days since last activity
- **Stale:** 7-14 days since last activity
- **Abandoned:** 14+ days since last activity

For stale/abandoned issues, identify:
- Last actor (who touched it last)
- Last action type (commit, comment, label change)
- Likely cause of staleness (blocked, low priority, forgotten)

## Output Structure

Produce a structured assessment:

### Issue Summary
- **Issue:** #123 - <title>
- **Status:** <Open|Closed> | <labels>
- **Last Activity:** X days ago (<timestamp>)
- **Phase:** <Planning|Implementation|QA|Blocked|Complete|Unclear>

### Acceptance Criteria
- AC-1: ... [MET|IN_PROGRESS|NOT_STARTED|UNCLEAR]
- AC-2: ... [MET|IN_PROGRESS|NOT_STARTED|UNCLEAR]
- ...
- **Coverage:** X/Y complete

(If AC don't exist or are unclear, note: "AC not clearly defined")

### Artifacts Found
**Planning:**
- [x] Plan comment in issue #<comment-id>
- [ ] Architecture decisions documented

**Implementation:**
- [x] Branch: `feature/123-issue-slug` (5 commits)
- [x] Worktree: `../worktrees/feature/123-issue-slug/`
- [x] Modified files: `components/admin/FactCheckQueue.tsx`, `lib/queries/fact-checks.ts`
- [ ] Tests written

**QA:**
- [ ] PR open
- [ ] QA review complete

### Blockers & Issues
- [ ] None identified
- [x] Stale (10 days since last commit)
- [x] Missing tests
- [ ] Depends on issue #<other>

### Recommendation

Based on the assessment, recommend one of:

**If Phase = Planning:**
```
RECOMMENDATION: Run `/spec 123`
- Issue needs a clear plan and AC before implementation
- This will establish AC checklist and technical approach
```

**If Phase = Implementation (not started):**
```
RECOMMENDATION: Run `/exec 123`
- Plan exists and AC are clear
- Ready to begin implementation
- This will create feature worktree and start coding
```

**If Phase = Implementation (in progress):**
```
RECOMMENDATION: Continue `/exec 123`
- Implementation is underway (5 commits on branch)
- Worktree exists at: ../worktrees/feature/123-issue-slug/
- AC coverage: 1/4 complete, 2/4 in progress
- Navigate to worktree and continue implementation
```

**If Phase = QA:**
```
RECOMMENDATION: Run `/qa 123`
- Implementation appears complete
- Branch has 12 commits, last commit 2 days ago
- No QA review exists yet
- Review code and validate against AC
```

**If Phase = Blocked:**
```
RECOMMENDATION: Resolve blockers first
- Issue depends on #145 (not yet merged)
- Open question in comments: "Should we use email or in-app notifications?"
- Suggest: Review #145 status, clarify notification approach with team
- Once unblocked, run `/exec 123` to continue
```

**If Phase = Complete:**
```
RECOMMENDATION: No action needed
- PR #156 merged 3 days ago
- All AC met (per QA review)
- Issue can be closed
```

**If Phase = Unclear:**
```
RECOMMENDATION: Gather more information
- Unable to determine current state
- Missing information: [list what's unclear]
- Suggest: Review issue comments, check with team, or run `/spec 123` to establish baseline
```

### Context for Next Command

Provide relevant context to help the next command:

**Key Files to Review:**
- `components/admin/FactCheckQueue.tsx` - Main component
- `lib/queries/fact-checks.ts` - Data layer
- `docs/ADMIN_ARCHITECTURE.md` - Related architecture

**Similar Patterns:**
- See `components/admin/news/ContentUpdatesList.tsx` for list pattern
- See `components/admin/shops/ApprovalQueue.tsx` for approval flow

**Potential Risks:**
- No error handling for failed approvals
- Email service integration not yet tested
- Database migration for `fact_checks` table may be needed

## Examples

### Example 1: Fresh Issue Needs Planning

```
Issue Summary
- Issue: #147 - Add fact-check queue to admin panel
- Status: Open | needs-planning, admin
- Last Activity: 2 hours ago
- Phase: Planning

Acceptance Criteria
AC not clearly defined in issue
Inferred AC from description:
- Display pending fact-check items in queue
- Allow approval/rejection actions
- Send notifications on status change

Artifacts Found
Planning: None
Implementation: None
QA: None

Blockers & Issues
- [ ] No blockers

Recommendation
RECOMMENDATION: Run `/spec 147`
- Issue is fresh but lacks detailed AC and plan
- Need to establish clear requirements before implementation
```

### Example 2: Implementation In Progress, Stale

```
Issue Summary
- Issue: #145 - Fix neighborhood extraction for Atlanta
- Status: Open | in-progress, bug
- Last Activity: 10 days ago
- Phase: Implementation (Stale)

Acceptance Criteria
- AC-1: Extract neighborhoods via ZIP mapping - MET
- AC-2: Handle edge cases (no ZIP, multiple ZIPs) - IN_PROGRESS
- AC-3: Backfill existing Atlanta shops - NOT_STARTED
Coverage: 1/3 complete

Artifacts Found
Implementation:
- [x] Branch: feature/145-atlanta-neighborhoods (3 commits)
- [x] Worktree: ../worktrees/feature/145-atlanta-neighborhoods/
- [x] Modified: lib/utils/neighborhood-extraction.ts
- [ ] Tests not found

Blockers & Issues
- [x] Stale (10 days since last commit)
- [x] Missing tests
- [ ] No known blockers

Recommendation
RECOMMENDATION: Resume `/exec 145`
- Implementation is 1/3 complete but stale
- Worktree still exists, resume work there
- Focus on AC-2 (edge cases) and AC-3 (backfill)
- Add tests before considering complete
```

### Example 3: Ready for QA

```
Issue Summary
- Issue: #148 - Add bulk publishing to content updates
- Status: Open | ready-for-review
- Last Activity: 1 day ago
- Phase: QA

Acceptance Criteria
- AC-1: Multi-select in content updates list - UNCLEAR
- AC-2: Bulk publish action button - UNCLEAR
- AC-3: Confirmation dialog - UNCLEAR
- AC-4: Success/error feedback - UNCLEAR
Coverage: Unclear (need QA review to validate)

Artifacts Found
Implementation:
- [x] Branch: feature/148-bulk-publishing (15 commits)
- [x] Modified: components/admin/news/ContentUpdatesList.tsx, lib/admin/bulk-actions.ts
- [x] Tests: __tests__/bulk-publishing.test.ts
QA:
- [ ] No PR yet
- [ ] No QA review

Blockers & Issues
- [ ] No blockers
- Developer marked as "ready for review" in last comment

Recommendation
RECOMMENDATION: Run `/qa 148`
- Implementation appears complete (15 commits, tests added)
- Developer believes AC are met
- Need QA review to validate and assess A+ status
- Create PR if not exists, review code and test against AC
```

## Meta-Assessment

After providing the assessment, briefly note:

- **Confidence Level:** How certain are you about the phase detection? (High/Medium/Low)
- **Information Gaps:** What information would improve this assessment?
- **Alternative Interpretations:** Are there other ways to interpret the current state?

## Notes

- This command is **read-only** - it analyzes but doesn't make changes
- It recommends but doesn't execute the next command
- Keep the assessment concise - aim for clarity, not exhaustiveness
- When in doubt about phase, say so - better to acknowledge uncertainty
- Use this to orient yourself, then proceed with the appropriate workflow command
