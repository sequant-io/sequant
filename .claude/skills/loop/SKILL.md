---
name: loop
description: "Quality loop - Parse test/QA findings and iterate until quality gates pass"
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
  # Optional MCP tools (enhanced functionality if available)
  - mcp__chrome-devtools__*  # Browser testing - falls back to manual verification if unavailable
  - mcp__sequential-thinking__*  # Complex debugging - falls back to standard analysis if unavailable
  - mcp__context7__*  # Library documentation - falls back to web search if unavailable
  - Bash(gh issue view:*)
  - Bash(gh issue comment:*)
  - Bash(npm test:*)
  - Bash(npm run build:*)
  - Bash(git diff:*)
  - Bash(git status:*)
---

# Quality Loop Command

You are the "Quality Loop Agent" for the current repository.

## Purpose

When invoked as `/loop <issue-number>`, your job is to:

1. Read the previous phase output from `/tmp/claude-issue-<N>.log`
2. Parse findings from the last `/test` or `/qa` phase
3. Fix the identified issues
4. Re-run validation until quality gates pass
5. Exit when `READY_FOR_MERGE` or max iterations reached

## Orchestration Context

When running as part of an orchestrated workflow (e.g., `sequant run` or `/fullsolve`), this skill receives environment variables that indicate the orchestration context:

| Environment Variable | Description | Example Value |
|---------------------|-------------|---------------|
| `SEQUANT_ORCHESTRATOR` | The orchestrator invoking this skill | `sequant-run` |
| `SEQUANT_PHASE` | Current phase in the workflow | `loop` |
| `SEQUANT_ISSUE` | Issue number being processed | `123` |
| `SEQUANT_WORKTREE` | Path to the feature worktree | `/path/to/worktrees/feature/...` |

**Behavior when orchestrated (SEQUANT_ORCHESTRATOR is set):**

1. **Use provided worktree** - Work in `SEQUANT_WORKTREE` path directly
2. **Use `SEQUANT_ISSUE`** - Skip issue number parsing from invocation
3. **Reduce GitHub comment frequency** - Defer updates to orchestrator
4. **Trust issue context** - Orchestrator has already validated issue

**Behavior when standalone (SEQUANT_ORCHESTRATOR is NOT set):**

- Locate worktree from issue number
- Post progress comments to GitHub
- Fetch issue context if needed

## Invocation

- `/loop 123` - Parse log for issue #123, fix issues, re-validate

## Workflow

### Step 1: Read Previous Phase Output

```bash
# Read the log file for this issue
cat /tmp/claude-issue-<issue-number>.log
```

Parse the log to find:
- **Last phase executed:** `/test` or `/qa`
- **Verdict:** `READY_FOR_MERGE`, `AC_MET_BUT_NOT_A_PLUS`, `NEEDS_VERIFICATION`,
  or `AC_NOT_MET`
- **Test results:** PASS/FAIL/BLOCKED counts
- **Issues to fix:** Numbered recommendations or bug descriptions

### Step 2: Detect Phase and Parse Findings

**If last phase was `/test`:**
Look for patterns like:
- `X/Y tests passed`
- `FAIL` or `BLOCKED` test results
- `### Bugs Found` section
- `### Issues to Fix` section

Extract:
- Failed test descriptions
- Bug locations and descriptions
- Blocked test dependencies

**If last phase was `/qa`:**
Look for patterns like:
- `Verdict: AC_NOT_MET` or `Verdict: AC_MET_BUT_NOT_A_PLUS`
- `NOT_MET` or `PARTIALLY_MET` AC items
- `### Issues` or `### Recommendations` sections

Extract:
- AC items marked NOT_MET or PARTIALLY_MET
- Specific recommendations
- Required fixes

### Step 3: Check Exit Conditions

**Exit loop if:**
- Verdict is `READY_FOR_MERGE` - Nothing to fix!
- Verdict is `NEEDS_VERIFICATION` - Pending external verification
- No actionable issues found
- Max iterations reached (3 by default)

**Continue loop if:**
- Tests failed
- AC not met
- Specific issues identified

### Step 4: Locate Feature Worktree

**If orchestrated (SEQUANT_WORKTREE is set):**
- Use the provided worktree path directly: `cd $SEQUANT_WORKTREE`
- Skip the lookup steps below

**If standalone:**

Find the worktree for this issue:
```bash
git worktree list | grep -E "feature.*<issue-number>"
```

Or check:
```bash
ls ../worktrees/feature/<issue-number>-*/
```

Navigate to the worktree directory for making fixes.

### Step 5: Fix Identified Issues

For each issue found in the log:

1. **Understand the issue:** Read relevant code to understand the problem
2. **Plan the fix:** Determine minimal change needed
3. **If complex issue:** Use Sequential Thinking to analyze root cause (see below)
4. **If unfamiliar library:** Use Context7 for documentation lookup
5. **Implement fix:** Make targeted changes
6. **Verify locally:** Run `npm test` and `npm run build`

**Using Sequential Thinking for Complex Debugging:**

If the issue has multiple potential causes or requires deep analysis:

```javascript
mcp__sequential-thinking__sequentialthinking({
  thought: "Analyzing test failure: [description]. Potential causes: 1) [Cause A] 2) [Cause B] 3) [Cause C]. Let me examine each...",
  thoughtNumber: 1,
  totalThoughts: 4,
  nextThoughtNeeded: true
})
```

**When to use Sequential Thinking in loop:**
- Test failures with unclear root cause
- Multiple potential fixes exist
- Previous fix attempt failed
- Issue spans multiple files/components

**Fallback:** If Sequential Thinking unavailable, document analysis steps explicitly in your response.

**Using Context7 for Library-Related Fixes:**

If the issue involves third-party library behavior:

```javascript
// Resolve library to Context7 ID
mcp__context7__resolve-library-id({
  libraryName: "package-name",
  query: "error message or behavior"
})

// Query for solution
mcp__context7__query-docs({
  libraryId: "/org/package",
  query: "specific problem description"
})
```

**Fallback:** If Context7 unavailable, use WebSearch for documentation.

**Quality Standards (from /exec):**
- Make minimal, focused changes
- Avoid scope creep
- Maintain type safety (no `any`)
- Don't delete or modify unrelated tests

### Step 6: Re-run Validation

After fixes are applied, re-run the phase that found issues:

**If fixing `/test` issues:**
- Use Chrome DevTools MCP to re-run failed tests
- Mark tests as PASS/FAIL based on fix
- Generate updated test summary

**If fixing `/qa` issues:**
- Run automated quality checks:
  ```bash
  npm test
  npm run build
  git diff main...HEAD --stat
  ```
- Re-evaluate AC coverage
- Update verdict

### Step 7: Iteration Check

After re-validation:

**If issues remain:**
- Increment iteration counter
- If iteration < MAX_ITERATIONS (3): Go back to Step 5
- If iteration >= MAX_ITERATIONS: Exit with summary

**If all issues fixed:**
- Confirm `READY_FOR_MERGE` status
- Post success comment to GitHub issue

## Output Format

### Progress Updates

For each iteration, output:

```markdown
## Loop Iteration X/3

### Issues from Previous Phase
1. [Issue description]
2. [Issue description]

### Fixes Applied
- [Fix 1]: [file:line] - [description]
- [Fix 2]: [file:line] - [description]

### Re-validation Results
- Tests: X/Y passed
- Build: PASS/FAIL
- AC Coverage: X/Y met

### Status
[FIXED - Continue to QA | NEEDS_MORE_WORK | MAX_ITERATIONS_REACHED]
```

### Final Summary

```markdown
## Quality Loop Complete

**Issue:** #<N>
**Iterations:** X/3
**Final Status:** [READY_FOR_MERGE | NEEDS_MANUAL_REVIEW]

### Issues Fixed
1. [Issue] - Fixed in [file:line]
2. [Issue] - Fixed in [file:line]

### Remaining Issues (if any)
- [Issue that couldn't be auto-fixed]

### Recommended Next Steps
- [If READY_FOR_MERGE]: Run `/qa <N>` for final review
- [If manual review needed]: [Specific guidance]
```

## Integration with Workflow

**Interactive usage:**
```bash
/spec 218          # Plan
/exec 218          # Implement
/test 218          # Test - finds 2 bugs
/loop 218          # Fixes bugs, re-tests, confirms PASS
/qa 218            # Final QA - READY_FOR_MERGE
```

**Automated workflow:**
```bash
/spec 218          # Plan
/exec 218          # Implement
/test 218          # Test - finds issues
/loop 218          # Fix issues, re-test
/qa 218            # Final QA
```

## Example Log Parsing

### Test Log Example

```
/test 218
## Testing Results for Issue #218

**Summary:** 8/10 tests passed

### Test Results

**Test 1: Basic image selection** - PASS
**Test 2: External URL validation** - FAIL
- Expected: URL validation error message
- Actual: No error shown for invalid URLs
- Issue: Validation not triggering on blur

**Test 3: Focal point picker** - BLOCKED
- Blocker: Modal not opening due to Test 2 failure

### Bugs Found

1. **URL validation not working**
   - Location: components/admin/news/ExternalUrlTab.tsx:45
   - Issue: onBlur handler missing validation call
   - Status: needs fix
```

**Parsed Output:**
- Last phase: `/test`
- Failed tests: 2 (Test 2, Test 3)
- Issues to fix:
  1. URL validation missing onBlur handler at `ExternalUrlTab.tsx:45`
  2. Test 3 blocked - depends on Test 2 fix

### QA Log Example

```
/qa 218
## QA Review for Issue #218

### AC Coverage

- AC-1: MET
- AC-2: MET
- AC-3: PARTIALLY_MET - External URL validation incomplete
- AC-4: NOT_MET - Focal point not persisted to database

### Verdict: AC_NOT_MET

### Required Fixes

1. Complete URL validation in ExternalUrlTab
2. Add focal point persistence in updateArticleImage action
```

**Parsed Output:**
- Last phase: `/qa`
- Verdict: `AC_NOT_MET`
- Issues to fix:
  1. AC-3: Complete URL validation
  2. AC-4: Add focal point persistence

## Error Handling

**If log file doesn't exist:**
```
Error: Log file not found at /tmp/claude-issue-<N>.log
Please run /spec, /exec, /test, or /qa first.
```

**If no issues found but not READY_FOR_MERGE:**
```
Warning: No specific issues found in log.
Recommend running /qa <N> for fresh assessment.
```

**If worktree not found:**
```
Error: Feature worktree not found for issue #<N>
Expected: ../worktrees/feature/<N>-*/
Please run /exec <N> first to create the worktree.
```

## Configuration

**Max iterations:** 3 (prevents infinite loops)
**Re-validation after each fix:** Required
**GitHub comment:** Posted after loop completion

---

## State Tracking

**IMPORTANT:** Update workflow state when running standalone (not orchestrated).

### State Updates (Standalone Only)

When NOT orchestrated (`SEQUANT_ORCHESTRATOR` is not set):

**At skill start:**
```bash
npx tsx scripts/state/update.ts start <issue-number> loop
```

**Update iteration count:**
```bash
npx tsx scripts/state/update.ts iteration <issue-number> <iteration-number>
```

**On successful completion (all issues fixed):**
```bash
npx tsx scripts/state/update.ts complete <issue-number> loop
```

**On max iterations reached:**
```bash
npx tsx scripts/state/update.ts fail <issue-number> loop "Max iterations reached"
```

**Why this matters:** State tracking enables dashboard visibility, resume capability, and workflow orchestration. Skills update state when standalone; orchestrators handle state when running workflows.

---

## Output Verification

**Before responding, verify your output includes ALL of these:**

- [ ] **Iteration Progress** - Current iteration X/3
- [ ] **Issues from Previous Phase** - List of issues being fixed
- [ ] **Fixes Applied** - Each fix with file:line location
- [ ] **Re-validation Results** - Tests/build/AC status after fixes
- [ ] **Final Status** - FIXED, NEEDS_MORE_WORK, or MAX_ITERATIONS_REACHED

**DO NOT respond until all items are verified.**
