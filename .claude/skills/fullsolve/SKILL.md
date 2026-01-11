---
name: fullsolve
description: "Complete issue resolution with integrated quality loops - spec → exec → test → qa with auto-fix iterations"
license: MIT
metadata:
  author: sequant
  version: "1.0"
allowed-tools:
  - Read
  - Edit
  - Write
  - Glob
  - Grep
  - Bash
  - TodoWrite
  - Task
  # Optional MCP tools (enhanced functionality if available)
  # - mcp__chrome-devtools__* (browser testing)
  # - mcp__sequential-thinking__* (complex reasoning)
  # - mcp__context7__* (library documentation)
  - Bash(gh issue view:*)
  - Bash(gh issue comment:*)
  - Bash(gh issue edit:*)
  - Bash(gh pr create:*)
  - Bash(npm test:*)
  - Bash(npm run build:*)
  - Bash(git diff:*)
  - Bash(git status:*)
  - Bash(git add:*)
  - Bash(git commit:*)
  - Bash(git push:*)
  - Bash(git worktree:*)
---

# Full Solve Command

You are the "Full Solve Agent" for the current repository.

## Purpose

When invoked as `/fullsolve <issue-number>`, execute the complete issue resolution workflow with integrated quality loops. This command orchestrates all phases and automatically iterates until quality gates pass.

## Workflow Overview

```
                    /fullsolve <issue>
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────┐                                                │
│  │  SPEC   │ Plan implementation, extract AC                │
│  └────┬────┘                                                │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────┐                                                │
│  │  EXEC   │ Implement in feature worktree                  │
│  └────┬────┘                                                │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────┐                                                │
│  │  TEST   │ Browser-based testing (if UI feature)          │
│  └────┬────┘                                                │
│       │                                                     │
│       ▼ (failures?)                                         │
│  ┌─────────┐     ┌─────────┐                                │
│  │  FIX    │────▶│ RE-TEST │──▶ (loop max 3x)               │
│  └─────────┘     └─────────┘                                │
│       │                                                     │
│       ▼ (all pass)                                          │
│  ┌─────────┐                                                │
│  │   QA    │ Code review, AC validation                     │
│  └────┬────┘                                                │
│       │                                                     │
│       ▼ (not ready?)                                        │
│  ┌─────────┐     ┌─────────┐                                │
│  │  FIX    │────▶│  RE-QA  │──▶ (loop max 2x)               │
│  └─────────┘     └─────────┘                                │
│       │                                                     │
│       ▼ (READY_FOR_MERGE)                                   │
│  ┌─────────┐                                                │
│  │   PR    │ Create PR if not exists                        │
│  └─────────┘                                                │
└─────────────────────────────────────────────────────────────┘
```

## Invocation

```bash
/fullsolve 218                    # Standard full solve
/fullsolve 218 --skip-test        # Skip testing phase (backend issues)
/fullsolve 218 --max-iterations 5 # Override max fix iterations
/fullsolve 218 --parallel         # Force parallel agent execution (faster, higher token usage)
/fullsolve 218 --sequential       # Force sequential agent execution (slower, lower token usage)
```

## Agent Execution Mode

When spawning sub-agents for quality checks, determine the execution mode:

1. **Check for CLI flag override:**
   - `--parallel` → Run sub-agents in parallel
   - `--sequential` → Run sub-agents one at a time

2. **If no flag, read project settings:**
   ```bash
   # Read agents.parallel from .sequant/settings.json
   parallel=$(cat .sequant/settings.json 2>/dev/null | jq -r '.agents.parallel // false')
   ```

3. **Default:** Sequential (cost-optimized)

| Mode | Token Usage | Speed | Best For |
|------|-------------|-------|----------|
| Sequential | 1x (baseline) | Slower | Limited API plans, single issues |
| Parallel | ~2-3x | ~50% faster | Unlimited plans, batch operations |

**Pass execution mode to child skills:** When invoking `/qa` or other skills that spawn agents, pass the `--parallel` or `--sequential` flag to maintain consistency.

## Orchestration Context

This skill acts as an **orchestrator** and sets environment variables for child skills to optimize their behavior:

| Environment Variable | Description | Example Value |
|---------------------|-------------|---------------|
| `SEQUANT_ORCHESTRATOR` | Identifies the orchestrator | `sequant-run` |
| `SEQUANT_PHASE` | Current phase being executed | `spec`, `exec`, `test`, `qa`, `loop` |
| `SEQUANT_ISSUE` | Issue number being processed | `218` |
| `SEQUANT_WORKTREE` | Path to the feature worktree | `/path/to/worktrees/feature/218-...` |

**Benefits of orchestration context:**

1. **Faster execution** - Child skills skip redundant pre-flight checks
2. **Cleaner GitHub comments** - Only orchestrator posts progress updates
3. **Better coordination** - Skills can trust worktree and issue context
4. **Reduced API calls** - Issue fetch happens once, not per-phase

**Child skills detect orchestration via `SEQUANT_ORCHESTRATOR` and adjust behavior:**
- `/spec`: Runs normally (first phase, no prior context)
- `/exec`: Skips worktree creation, uses provided path
- `/test`: Skips issue fetch, trusts orchestrator context
- `/qa`: Skips pre-flight sync, defers GitHub updates
- `/loop`: Uses provided worktree, defers GitHub updates

## Phase 0: Pre-flight Checks

**CRITICAL after context restoration:** Before starting any work, verify the current git state to avoid duplicate work.

### 0.1 Git State Verification

```bash
# Check current branch and recent commits
git log --oneline -5 --stat

# Check for any existing work on this issue
git branch -a | grep -i "<issue-number>"
gh pr list --search "<issue-number>"
```

**Why this matters:** After context restoration from a summarized conversation, the git state may have changed (PRs merged, rebases, etc.). Always verify what's already been done before creating files or making changes.

### 0.2 Existing Work Detection

Before creating any files, check if they already exist:
- Look for test files: `ls -la src/**/*.test.ts`
- Check recent commits for relevant changes
- Verify PR status if one was mentioned in context

**If work already exists:** Skip to the appropriate phase (e.g., if implementation is done, go to Phase 3 or 4).

## Phase 1: Planning (SPEC)

Execute the planning phase inline (not as separate command):

### 1.1 Fetch Issue Context

```bash
gh issue view <issue-number> --json title,body,labels
gh issue view <issue-number> --comments
```

### 1.2 Extract Acceptance Criteria

Parse issue body and comments to build AC checklist:
- AC-1, AC-2, etc.
- Identify blockers, dependencies
- Note open questions

### 1.3 Create Implementation Plan

- Break down into 3-7 implementation steps
- Identify complexity and risks
- Post plan comment to issue

### 1.4 Create Feature Worktree

```bash
./scripts/dev/new-feature.sh <issue-number>
```

**State after Phase 1:**
- AC checklist defined
- Implementation plan created
- Feature worktree ready

## Phase 2: Implementation (EXEC)

### 2.1 Navigate to Worktree

```bash
cd ../worktrees/feature/<issue-number>-*/
```

### 2.2 Implement Each AC Item

For each AC item:
1. Understand requirement
2. Find similar patterns in codebase
3. Implement minimal solution
4. Run tests and build
5. Mark AC as complete

### 2.3 Quality Gates

After implementation:
- `npm test` - All tests pass
- `npm run build` - Build succeeds
- `git diff` - Changes are proportional

### 2.4 Final Verification (CRITICAL)

**After ALL implementation changes are complete**, run verification one more time:

```bash
# Run full test suite AFTER all changes
npm test

# Verify build still works
npm run build
```

**Why this matters:** Tests run during implementation may pass before file conversions or final changes are made. Always verify after the LAST change, not just after each intermediate step.

**If tests fail at this stage:**
1. Fix the failing tests (update paths, content checks, etc.)
2. Re-run `npm test` until all pass
3. Do NOT proceed to Phase 3 until tests pass

**State after Phase 2:**
- All AC items implemented
- Tests passing (verified AFTER final changes)
- Build succeeding

## Phase 3: Testing (TEST)

**Skip if:** Issue doesn't have `admin`, `ui`, or `frontend` labels

### 3.1 Start Dev Server

```bash
npm run dev &
```

### 3.2 Execute Test Cases

Using Chrome DevTools MCP:
- Navigate to feature
- Execute each test case
- Record PASS/FAIL/BLOCKED

### 3.3 Test Loop (Max 3 iterations)

```
test_iteration = 0
while test_iteration < 3:
    run_tests()

    if all_tests_pass:
        break

    # Parse failures
    failed_tests = parse_failed_tests()

    # Fix each failure
    for test in failed_tests:
        understand_failure()
        implement_fix()
        verify_fix()

    test_iteration += 1
```

**State after Phase 3:**
- All tests passing (or max iterations reached)
- Bugs documented and fixed

## Phase 4: Quality Assurance (QA)

### 4.1 Automated Quality Checks

```bash
# Type safety
git diff main...HEAD | grep -E ":\s*any[,)]|as any"

# Deleted tests
git diff main...HEAD --diff-filter=D --name-only | grep -E "\.test\."

# Scope check
git diff main...HEAD --name-only | wc -l

# Size check
git diff main...HEAD --numstat
```

### 4.2 AC Coverage Review

For each AC item, mark:
- `MET` - Fully implemented
- `PARTIALLY_MET` - Needs more work
- `NOT_MET` - Not implemented

### 4.3 QA Loop (Max 2 iterations)

```
qa_iteration = 0
while qa_iteration < 2:
    run_qa_checks()

    if verdict == "READY_FOR_MERGE":
        break

    # Parse issues
    issues = parse_qa_issues()

    # Fix each issue
    for issue in issues:
        understand_issue()
        implement_fix()
        verify_fix()

    qa_iteration += 1
```

**State after Phase 4:**
- AC fully met
- Code quality validated
- Ready for merge

## Phase 5: Pull Request (PR)

### 5.1 Create PR (if not exists)

```bash
# Check for existing PR
gh pr list --head feature/<issue-number>-*

# Create if none exists
gh pr create --title "feat(#<N>): <title>" --body "..."
```

### 5.2 Final Summary

Post completion comment to issue with:
- AC coverage summary
- Key changes made
- PR link
- Quality metrics

### 5.3 Merge Workflow (Correct Order)

**IMPORTANT:** Merge the PR first, then clean up the worktree.

```bash
# 1. Merge PR (--delete-branch deletes remote; local deletion will fail but that's OK)
gh pr merge <N> --squash --delete-branch

# 2. Clean up worktree (removes local worktree + branch)
./scripts/dev/cleanup-worktree.sh feature/<issue-number>-*

# 3. Issue auto-closes if commit message contains "Fixes #N"
```

**Why this order matters:** The cleanup script checks if the PR is merged before proceeding. The `--delete-branch` flag will fail to delete the local branch (worktree conflict) but successfully deletes the remote branch. The cleanup script then handles the local branch removal.

### 5.4 Post-Merge Verification

**Recommended:** After merge, verify the build and CLI still work:

```bash
# Pull latest main
git pull origin main

# Rebuild and verify
npm run build

# Smoke test - verify CLI runs without errors
npx sequant doctor
```

If any command fails, fix immediately on main before continuing. This catches issues like ESM compatibility bugs that unit tests may miss.

## Iteration Tracking

Track iterations to prevent infinite loops:

```markdown
## Full Solve Progress

| Phase | Iterations | Status |
|-------|------------|--------|
| Spec  | 1/1        | Complete |
| Exec  | 1/1        | Complete |
| Test  | 2/3        | Complete (fixed 2 bugs) |
| QA    | 1/2        | Complete |

**Total Time:** [tracked]
**Final Verdict:** READY_FOR_MERGE
```

## Exit Conditions

**Success:**
- All AC met
- All tests passing
- QA verdict: `READY_FOR_MERGE`
- PR created

**Partial Success:**
- Most AC met
- Minor issues documented
- QA verdict: `AC_MET_BUT_NOT_A_PLUS`
- PR created with notes

**Failure (manual intervention needed):**
- Max iterations reached on test or QA loop
- Blockers discovered
- QA verdict: `AC_NOT_MET` after all iterations

## GitHub Updates

Throughout the process, post progress comments:

**After Spec:**
```markdown
## Plan Complete

### AC Checklist
- [ ] AC-1: ...
- [ ] AC-2: ...

### Implementation Plan
1. Step 1
2. Step 2

Ready to implement.
```

**After Test Loop:**
```markdown
## Testing Complete

**Result:** 10/10 tests passed
**Iterations:** 2 (fixed 2 bugs)

### Bugs Fixed
1. [Bug] - Fixed in [file:line]
```

**Final Comment:**
```markdown
## /fullsolve Complete

**Issue:** #<N>
**Status:** READY_FOR_MERGE

### Summary
- AC: 5/5 met
- Tests: 10/10 passed
- QA: All checks passed

### Iterations
- Test loop: 2
- QA loop: 1

**PR:** #<PR_NUMBER>

---
Ready for human review and merge.
```

## Error Recovery

**If spec fails:**
- Check issue exists and is readable
- Verify GitHub CLI authentication
- Exit with clear error

**If exec fails (build/test):**
- Check error logs
- Attempt targeted fix
- If persistent, document and exit

**If test loop exhausted:**
- Document remaining failures
- Post status to issue
- Continue to QA (may catch issues there)

**If QA loop exhausted:**
- Document remaining issues
- Create PR anyway with notes
- Flag for human review

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| MAX_TEST_ITERATIONS | 3 | Max fix loops for test phase |
| MAX_QA_ITERATIONS | 2 | Max fix loops for QA phase |
| SKIP_TEST | false | Skip testing phase |
| AUTO_PR | true | Create PR automatically |

## Smart Tests Integration

**Recommended:** Enable smart tests for automatic test running during implementation:

```bash
# Enable before running fullsolve
export CLAUDE_HOOKS_SMART_TESTS=true
```

When enabled, smart tests will:
- Auto-run related tests after each file edit during Phase 2 (EXEC)
- Catch regressions immediately instead of waiting for explicit `npm test`
- Log results to `/tmp/claude-tests.log` for debugging

**Benefits:**
- Faster feedback loop during implementation
- Catches test failures as they happen
- Reduces QA iteration count

**Trade-off:** Adds ~5-10s per file edit for test execution.

**View test results:**
```bash
npx tsx scripts/dev/analyze-hook-logs.ts --tests
```

## Usage Examples

**Standard full solve:**
```
/fullsolve 218
```

**Backend issue (no UI testing):**
```
/fullsolve 218 --skip-test
```

**With more iteration tolerance:**
```
/fullsolve 218 --max-iterations 5
```

## Batch Processing

For multiple issues, run `/fullsolve` on each sequentially:

```bash
# Process multiple issues one at a time
/fullsolve 218
/fullsolve 219
/fullsolve 220
```

Each issue gets its own worktree, PR, and quality validation.

---

## Output Verification

**Before responding, verify your output includes ALL of these:**

- [ ] **Progress Table** - Phase, iterations, and status for each phase
- [ ] **AC Coverage** - Each AC marked MET/PARTIALLY_MET/NOT_MET
- [ ] **Quality Metrics** - Tests passed, build status, type issues
- [ ] **Iteration Summary** - Test loop and QA loop iteration counts
- [ ] **Final Verdict** - READY_FOR_MERGE, AC_MET_BUT_NOT_A_PLUS, or AC_NOT_MET
- [ ] **PR Link** - Pull request URL (if created)
- [ ] **Final GitHub Comment** - Summary posted to issue

**DO NOT respond until all items are verified.**
