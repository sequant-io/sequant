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
  - Skill  # For invoking child skills (/spec, /exec, /test, /qa)
  # Optional MCP tools (enhanced functionality if available)
  - mcp__chrome-devtools__*  # Browser testing - falls back to manual checklist if unavailable
  - mcp__sequential-thinking__*  # Complex reasoning - falls back to standard analysis if unavailable
  - mcp__context7__*  # Library documentation - falls back to web search if unavailable
  - Bash(gh issue view:*)
  - Bash(gh issue comment:*)
  - Bash(gh issue edit:*)
  - Bash(gh pr create:*)
  - Bash(gh pr list:*)
  - Bash(gh pr merge:*)
  - Bash(npm test:*)
  - Bash(npm run build:*)
  - Bash(git diff:*)
  - Bash(git status:*)
  - Bash(git log:*)
  - Bash(git add:*)
  - Bash(git commit:*)
  - Bash(git push:*)
  - Bash(git worktree:*)
  - Bash(./scripts/dev/*:*)
---

# Full Solve Command

You are the "Full Solve Agent" for the current repository.

## Purpose

When invoked as `/fullsolve <issue-number>`, execute the complete issue resolution workflow with integrated quality loops. This command orchestrates all phases and automatically iterates until quality gates pass.

## CRITICAL: Auto-Progression Between Phases

**DO NOT wait for user confirmation between phases.** This is an autonomous workflow.

After each phase completes successfully, **immediately proceed** to the next phase:
1. `/spec` completes → **immediately** invoke `/exec`
2. `/exec` completes → **immediately** invoke `/test` (if UI) or `/qa`
3. `/test` completes → **immediately** invoke `/qa`
4. `/qa` completes → **immediately** create PR

**The user invoked `/fullsolve` expecting end-to-end automation.** Only stop for:
- Unrecoverable errors (after retry attempts exhausted)
- Final summary after PR creation
- Explicit user interruption

```
WRONG: "Spec complete. Ready for exec phase." [waits]
RIGHT: "Spec complete. Proceeding to exec..." [invokes /exec immediately]
```

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
   Use the Read tool to check project settings:
   ```
   Read(file_path=".sequant/settings.json")
   # Parse JSON and extract agents.parallel (default: false)
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

## Phase Detection (Smart Resumption)

**Before starting any phase**, detect the current workflow state from GitHub issue comments to enable smart resumption:

```bash
# Get all phase markers from issue comments
comments_json=$(gh issue view <issue-number> --json comments --jq '[.comments[].body]')
markers=$(echo "$comments_json" | grep -o '{[^}]*}' | grep '"phase"' || true)

if [[ -n "$markers" ]]; then
  echo "Phase markers detected:"
  echo "$markers" | jq -r '"  \(.phase): \(.status)"'

  # Determine resume point
  latest_completed=$(echo "$markers" | jq -r 'select(.status == "completed") | .phase' | tail -1)
  latest_failed=$(echo "$markers" | jq -r 'select(.status == "failed") | .phase' | tail -1)

  echo "Latest completed: ${latest_completed:-none}"
  echo "Latest failed: ${latest_failed:-none}"
fi
```

**Resume Logic:**

| Detected State | Action |
|---------------|--------|
| No markers | Start from Phase 1 (spec) — fresh start |
| `spec:completed` | Skip to Phase 2 (exec) |
| `exec:completed` | Skip to Phase 3 (test) or Phase 4 (qa) |
| `exec:failed` | Resume at Phase 2 (exec) — retry |
| `test:completed` | Skip to Phase 4 (qa) |
| `qa:completed` | Skip to Phase 5 (PR) |
| `qa:failed` | Resume at Phase 4 (qa) — retry with /loop |
| All completed | Skip to PR creation (if no PR exists) |

**Backward Compatibility:**
- Issues without markers → treat as fresh start (no phase detection)
- If detection fails (API error) → fall through to standard Phase 0 checks

**Phase Marker Emission:**

When posting progress comments after each phase, append the appropriate marker:
```markdown
<!-- SEQUANT_PHASE: {"phase":"<phase>","status":"<completed|failed>","timestamp":"<ISO-8601>"} -->
```

## Phase 0: Pre-flight Checks

**CRITICAL after context restoration:** Before starting any work, verify the current git state to avoid duplicate work.

### 0.1 Git State Verification

```bash
# Check current branch and recent commits
git log --oneline -5 --stat

# Check for any existing work on this issue
git branch -a | grep -i "<issue-number>" || true
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

**Invoke the `/spec` skill** to plan implementation and extract acceptance criteria.

### 1.1 Invoke Spec Skill

Use the `Skill` tool to invoke `/spec`:

```
Skill(skill: "spec", args: "<issue-number>")
```

The `/spec` skill will:
- Fetch issue context from GitHub
- Extract acceptance criteria (AC-1, AC-2, etc.)
- Create implementation plan (3-7 steps)
- Post plan comment to the issue
- Create feature worktree

### 1.2 Capture Spec Output

After `/spec` completes, extract and store:
- **AC Checklist:** List of acceptance criteria for tracking
- **Worktree Path:** Location for subsequent phases
- **Recommended Phases:** Whether `/test` is needed (UI features)

```markdown
## Spec Output Captured

**Issue:** #<N>
**Worktree:** ../worktrees/feature/<issue-number>-*/
**AC Count:** <N> items
**Needs Testing:** Yes/No (based on labels)
```

### 1.3 Handle Spec Failures

If `/spec` fails:
- Check if issue exists and is readable
- Verify GitHub CLI authentication
- Report failure and exit workflow

```markdown
## Spec Failed

**Error:** [error message]
**Action Required:** [what the user needs to do]

Workflow halted. Fix the issue and re-run `/fullsolve <issue-number>`.
```

**State after Phase 1:**
- AC checklist defined
- Implementation plan created (and posted to GitHub)
- Feature worktree ready

**→ IMMEDIATELY proceed to Phase 2 (do not wait for user input)**

## Phase 2: Implementation (EXEC)

**Invoke the `/exec` skill** to implement all acceptance criteria.

### 2.1 Invoke Exec Skill

Use the `Skill` tool to invoke `/exec`:

```
Skill(skill: "exec", args: "<issue-number>")
```

The `/exec` skill will:
- Navigate to the feature worktree
- Implement each AC item
- Run tests and build after changes
- Verify quality gates pass

### 2.2 Pass Orchestration Context

Set environment variables before invoking `/exec` so it can optimize its behavior:

```bash
export SEQUANT_ORCHESTRATOR=fullsolve
export SEQUANT_PHASE=exec
export SEQUANT_ISSUE=<issue-number>
export SEQUANT_WORKTREE=../worktrees/feature/<issue-number>-*/
```

When `/exec` detects `SEQUANT_ORCHESTRATOR`, it:
- Skips worktree creation (already done by `/spec`)
- Uses the provided worktree path
- Defers GitHub comment updates to orchestrator

### 2.3 Handle Exec Failures

If `/exec` fails (tests or build):

**Attempt fix (max 3 iterations):**
```
exec_iteration = 0
while exec_iteration < MAX_EXEC_ITERATIONS:
    result = Skill(skill: "exec", args: "<issue-number>")

    if result.success:
        break

    # Parse and log failure
    log_failure(result.error)
    exec_iteration += 1
```

**If all iterations exhausted:**
```markdown
## Exec Failed

**Iterations:** 3/3 exhausted
**Last Error:** [error message]

Workflow halted. Manual intervention required.
```

### 2.4 Capture Exec Output

After successful `/exec`:
- Verify tests passed
- Verify build succeeded
- Record files changed

```markdown
## Exec Complete

**Tests:** ✅ All passing
**Build:** ✅ Succeeded
**Files Changed:** <N>
```

**State after Phase 2:**
- All AC items implemented
- Tests passing (verified AFTER final changes)
- Build succeeding

**→ IMMEDIATELY proceed to Phase 3 or 4 (do not wait for user input)**
- If UI labels present → invoke `/test`
- Otherwise → skip to `/qa`

## Phase 3: Testing (TEST)

**Skip if:** Issue doesn't have `admin`, `ui`, or `frontend` labels (determined from `/spec` output)

**Invoke the `/test` skill** for browser-based UI testing.

### 3.1 Invoke Test Skill

Use the `Skill` tool to invoke `/test`:

```
Skill(skill: "test", args: "<issue-number>")
```

The `/test` skill will:
- Start development server
- Navigate to feature in browser (Chrome DevTools MCP)
- Execute each test case
- Record PASS/FAIL/BLOCKED results

### 3.2 Pass Orchestration Context

```bash
export SEQUANT_ORCHESTRATOR=fullsolve
export SEQUANT_PHASE=test
export SEQUANT_ISSUE=<issue-number>
export SEQUANT_WORKTREE=../worktrees/feature/<issue-number>-*/
```

When `/test` detects `SEQUANT_ORCHESTRATOR`, it:
- Skips issue fetch (trusts orchestrator context)
- Uses provided AC checklist
- Defers GitHub updates to orchestrator

### 3.3 Test Loop (Max 3 iterations)

If tests fail, invoke `/loop` to fix and re-test:

```
test_iteration = 0
while test_iteration < MAX_TEST_ITERATIONS:
    result = Skill(skill: "test", args: "<issue-number>")

    if result.all_tests_pass:
        break

    # Use /loop to fix failures
    Skill(skill: "loop", args: "<issue-number> --phase test")
    test_iteration += 1
```

### 3.4 Handle Test Exhaustion

If max iterations reached:

```markdown
## Test Loop Exhausted

**Iterations:** 3/3
**Remaining Failures:** [list]

Proceeding to QA phase. Failures will be documented.
```

**State after Phase 3:**
- All tests passing (or max iterations reached)
- Bugs documented and fixed

**→ IMMEDIATELY proceed to Phase 4 (do not wait for user input)**

## Phase 4: Quality Assurance (QA)

**Invoke the `/qa` skill** for code review and AC validation.

### 4.1 Invoke QA Skill

Use the `Skill` tool to invoke `/qa`:

```
Skill(skill: "qa", args: "<issue-number>")
```

The `/qa` skill will:
- Run automated quality checks (type safety, deleted tests, scope)
- Review AC coverage (MET/PARTIALLY_MET/NOT_MET/PENDING)
- Generate review comment draft
- Return verdict: READY_FOR_MERGE, AC_MET_BUT_NOT_A_PLUS, NEEDS_VERIFICATION,
  or AC_NOT_MET

### 4.2 Pass Orchestration Context

```bash
export SEQUANT_ORCHESTRATOR=fullsolve
export SEQUANT_PHASE=qa
export SEQUANT_ISSUE=<issue-number>
export SEQUANT_WORKTREE=../worktrees/feature/<issue-number>-*/
```

When `/qa` detects `SEQUANT_ORCHESTRATOR`, it:
- Skips pre-flight sync
- Defers GitHub comment posting to orchestrator
- Returns structured verdict for orchestrator to process

### 4.3 QA Loop (Max 2 iterations)

If verdict is not `READY_FOR_MERGE`, invoke `/loop` to fix and re-run QA:

```
qa_iteration = 0
while qa_iteration < MAX_QA_ITERATIONS:
    result = Skill(skill: "qa", args: "<issue-number>")

    if result.verdict == "READY_FOR_MERGE":
        break

    if result.verdict == "AC_MET_BUT_NOT_A_PLUS":
        # Good enough, proceed with notes
        break

    if result.verdict == "NEEDS_VERIFICATION":
        # ACs are met but pending external verification
        # Proceed to PR - verification can happen post-PR
        break

    # Use /loop to fix issues (AC_NOT_MET)
    Skill(skill: "loop", args: "<issue-number> --phase qa")
    qa_iteration += 1
```

### 4.4 Handle QA Exhaustion

If max iterations reached with `AC_NOT_MET`:

```markdown
## QA Loop Exhausted

**Iterations:** 2/2
**Verdict:** AC_NOT_MET
**Remaining Issues:** [list]

Creating PR with notes for human review.
```

**State after Phase 4:**
- AC fully met (or documented as partial)
- Code quality validated
- Ready for merge (or flagged for human review)

**→ IMMEDIATELY proceed to Phase 5 after self-evaluation (do not wait for user input)**

### 4.5 Adversarial Self-Evaluation (REQUIRED)

**Before proceeding to PR creation**, you MUST complete this adversarial self-evaluation to catch issues that all automated phases missed.

**Why this matters:** The full workflow passes automated checks, but honest self-reflection catches:
- Features that don't actually work as expected
- Edge cases that weren't tested
- Integration issues with existing features
- Success metrics reported without honest evaluation

**Answer these questions honestly:**
1. "Did anything not work as expected during the entire workflow?"
2. "If this feature broke tomorrow, would the current tests catch it?"
3. "What's the weakest part of this implementation?"
4. "Am I reporting success because checks passed, or because I verified it actually works?"

**Include this section in your output:**

```markdown
### Self-Evaluation

- **Worked as expected:** [Yes/No - if No, explain what didn't work]
- **Test coverage confidence:** [High/Medium/Low - explain why]
- **Weakest part:** [Identify the weakest aspect of the implementation]
- **Honest assessment:** [Any concerns or caveats about this PR?]
```

**If any answer reveals concerns:**
- Address the issues before proceeding to PR creation
- Re-run relevant quality checks
- Update the self-evaluation after fixes

**Do NOT skip this self-evaluation.** This is the last opportunity to catch issues before the PR is created.

---

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

**Pending Verification:**

- All AC met or pending
- External verification required (CI, manual test)
- QA verdict: `NEEDS_VERIFICATION`
- PR created, verification can happen post-PR

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

### Post-Batch: Merge Verification

After processing a batch, run `sequant merge` to catch cross-issue integration gaps before merging:

```bash
/fullsolve 218
/fullsolve 219
/fullsolve 220
sequant merge --check         # Verify no cross-issue conflicts
/merger 218 219 220           # Merge all issues
```

`sequant merge --check` detects merge conflicts, template mirroring gaps, and file overlaps at zero AI cost. See `docs/reference/merge-command.md`.

---

## State Tracking

**IMPORTANT:** `/fullsolve` is an orchestrator and manages state for child skills.

### Orchestrator Responsibilities

As an orchestrator, `/fullsolve` must:

1. **Set orchestration context** for child skills:
   ```bash
   export SEQUANT_ORCHESTRATOR=fullsolve
   export SEQUANT_PHASE=<current-phase>
   export SEQUANT_ISSUE=<issue-number>
   export SEQUANT_WORKTREE=<worktree-path>
   ```

2. **Initialize issue state at workflow start:**
   ```bash
   npx tsx scripts/state/update.ts init <issue-number> "<issue-title>"
   ```

3. **Update phase status** at each transition:
   ```bash
   # Before invoking child skill
   npx tsx scripts/state/update.ts start <issue-number> <phase>

   # After child skill completes
   npx tsx scripts/state/update.ts complete <issue-number> <phase>

   # If child skill fails
   npx tsx scripts/state/update.ts fail <issue-number> <phase> "Error"
   ```

4. **Update final status** after workflow completes:
   ```bash
   # On READY_FOR_MERGE
   npx tsx scripts/state/update.ts status <issue-number> ready_for_merge

   # On failure
   npx tsx scripts/state/update.ts status <issue-number> blocked
   ```

**Why child skills skip state updates:** When `SEQUANT_ORCHESTRATOR` is set, child skills defer state management to the orchestrator to avoid duplicate updates.

---

## Output Verification

**Before responding, verify your output includes ALL of these:**

- [ ] **Self-Evaluation Completed** - Adversarial self-evaluation section included in output
- [ ] **Progress Table** - Phase, iterations, and status for each phase
- [ ] **AC Coverage** - Each AC marked MET/PARTIALLY_MET/NOT_MET
- [ ] **Quality Metrics** - Tests passed, build status, type issues
- [ ] **Iteration Summary** - Test loop and QA loop iteration counts
- [ ] **Final Verdict** - READY_FOR_MERGE, AC_MET_BUT_NOT_A_PLUS, NEEDS_VERIFICATION,
  or AC_NOT_MET
- [ ] **PR Link** - Pull request URL (if created)
- [ ] **Final GitHub Comment** - Summary posted to issue

**DO NOT respond until all items are verified.**
