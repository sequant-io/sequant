---
name: test
description: "Execute structured browser-based testing for admin features"
license: MIT
metadata:
  author: sequant
  version: "1.0"
allowed-tools:
  - Read
  - Bash
  - mcp__chrome-devtools__*  # Optional: falls back to manual checklist if unavailable
  - Glob
  - Grep
  - TodoWrite
  - Bash(gh issue view:*)
  - Bash(gh issue comment:*)
  - Bash({{PM_RUN}} dev:*)
  - Bash(lsof:*)
  - Bash(npx tsx:*)
---

# Browser Testing Command

You are the "Testing Agent" for the current repository.

## Purpose

When invoked as `/test <issue-number>`, execute structured browser-based testing for admin features that require manual QA validation.

**Workflow:**
1. **Setup Phase:** Fetch Issue, prepare test data, start dev server
2. **Execution Phase:** Run tests systematically with browser automation
3. **Reporting Phase:** Generate test results and GitHub comment

## Orchestration Context

When running as part of an orchestrated workflow (e.g., `sequant run` or `/fullsolve`), this skill receives environment variables that indicate the orchestration context:

| Environment Variable | Description | Example Value |
|---------------------|-------------|---------------|
| `SEQUANT_ORCHESTRATOR` | The orchestrator invoking this skill | `sequant-run` |
| `SEQUANT_PHASE` | Current phase in the workflow | `test` |
| `SEQUANT_ISSUE` | Issue number being processed | `123` |
| `SEQUANT_WORKTREE` | Path to the feature worktree | `/path/to/worktrees/feature/...` |

**Behavior when orchestrated (SEQUANT_ORCHESTRATOR is set):**

1. **Skip issue fetch** - Use `SEQUANT_ISSUE` directly, orchestrator has context
2. **Use provided worktree** - Work in `SEQUANT_WORKTREE` path
3. **Reduce GitHub comment frequency** - Defer progress updates to orchestrator
4. **Trust dev server status** - Orchestrator may have started it already

**Behavior when standalone (SEQUANT_ORCHESTRATOR is NOT set):**

- Fetch fresh issue context from GitHub
- Locate or prompt for worktree
- Post progress updates to GitHub
- Start dev server if needed

## Phase 1: Setup

### 1.1 Fetch Issue Context

**If orchestrated (SEQUANT_ORCHESTRATOR is set):**
- Use `SEQUANT_ISSUE` for the issue number
- Skip fetching issue context (orchestrator has already done this)
- Parse any context passed in the orchestrator's prompt

**If standalone:**

```bash
gh issue view <issue-number> --json title,body,labels
gh issue view <issue-number> --comments
```

**Read all GitHub issue comments** to gather complete context:
- Comments often contain clarifications, updates, or additional test cases added after the initial issue description
- Look for discussion about test requirements, edge cases, or expected behaviors mentioned in comments
- Review feedback from previous testing cycles or review comments

Parse the Issue body and all comments to extract:
- Feature description
- Test cases (look for "Test 1:", "**Test N:**", "### Test N", numbered lists)
- Test data requirements (if specified)
- Expected outcomes
- Any clarifications or additional test requirements from comments

### 1.2 Implementation Status Check

Before proceeding with full test setup, verify the feature exists:

**For admin features (`/admin/*`):**
```bash
# Check if main page exists
ls app/admin/<feature>/page.tsx 2>/dev/null && echo "Exists" || echo "Not implemented"
```

**For component features:**
```bash
# Check if main component exists
find components -name "*<FeatureName>*" -type f
```

**Decision based on result:**

**Feature Implemented → Continue to 1.3**
- Proceed with test data preparation and full test execution

**Feature Not Implemented → Two options:**

1. **Quick Status Report (for P2/deferred features):**
   - Verify infrastructure readiness (backend queries, DB schema, dependencies)
   - Document what exists vs. what's missing
   - Post brief status comment to issue
   - Exit testing workflow - let user decide: implement now or defer

2. **Implement First (for P0/P1 features):**
   - Exit `/test` workflow
   - Recommend: Run `/spec <issue>` to plan, then `/exec <issue>` to implement
   - Run `/test <issue>` again after implementation complete

### 1.3 Test Data Preparation

Check for test data requirements:

1. Look for seed script or test fixtures in the project
2. If seed script exists, offer to run it:
   ```bash
   npx tsx scripts/seed-test-<feature>.ts
   ```
3. If no seed script exists, check Issue for SQL statements or manual setup steps
4. Execute setup or provide clear instructions to user

### 1.4 Dev Server Check

**Extract port from DEV_URL configuration:**
The dev server URL is configured in `.claude/.sequant/config.json` under `tokens.DEV_URL`. Extract the port for the `lsof` check:

```bash
# Get DEV_URL from config (default: {{DEV_URL}})
# Extract port: http://localhost:PORT -> PORT
DEV_PORT=$(echo "{{DEV_URL}}" | sed -E 's/.*:([0-9]+).*/\1/')

# Check if dev server is running on configured port
lsof -ti:$DEV_PORT
```

If not running, start it using the project's package manager:
```bash
{{PM_RUN}} dev
```

Wait for server ready before proceeding.

**Note:** If `{{DEV_URL}}` or `{{PM_RUN}}` are not replaced with actual values, the defaults are:
- DEV_URL: `http://localhost:3000` (Next.js), `http://localhost:4321` (Astro), `http://localhost:5173` (Vite-based)
- PM_RUN: `npm run` (or `bun run`, `yarn`, `pnpm run` based on lockfile)

### 1.5 Test Coverage Analysis (REQUIRED)

**Purpose:** Warn when new/modified source files lack corresponding test files.

**Before executing tests**, analyze coverage for changed files:

1. **Get changed source files:**
   ```bash
   # Get changed source files (excluding tests themselves)
   changed=$(git diff main...HEAD --name-only | grep -E '\.(ts|tsx|js|jsx)$' | grep -v -E '\.test\.|\.spec\.|__tests__' || true)
   echo "Changed source files:"
   echo "$changed"
   ```

2. **Check for corresponding test files:**
   ```bash
   # For each changed file, check if a test file exists
   for file in $changed; do
     base=$(basename "$file" | sed -E 's/\.(ts|tsx|js|jsx)$//')
     dir=$(dirname "$file")

     # Look for test files in common locations
     test_found=false

     # Check co-located test file
     if ls "$dir/$base.test."* 2>/dev/null | grep -q .; then
       test_found=true
     fi

     # Check __tests__ directory
     if ls "$dir/__tests__/$base.test."* 2>/dev/null | grep -q .; then
       test_found=true
     fi

     # Check root __tests__ with path structure
     if ls "__tests__/${file%.ts*}.test."* 2>/dev/null | grep -q .; then
       test_found=true
     fi

     if [ "$test_found" = false ]; then
       echo "⚠️ NO TEST: $file"
     fi
   done
   ```

3. **Generate Coverage Warning Report:**

   ```markdown
   ### Test Coverage Analysis

   | Source File | Has Test? | Notes |
   |-------------|-----------|-------|
   | `src/lib/feature.ts` | ⚠️ No | New file, no test coverage |
   | `src/lib/utils.ts` | ✅ Yes | `src/lib/utils.test.ts` |
   | `app/admin/page.tsx` | - | UI component (browser tested) |

   **Coverage:** X/Y changed source files have corresponding tests

   **Warning:** The following new/modified files lack test coverage:
   - `src/lib/feature.ts` - Consider adding `src/lib/feature.test.ts`
   ```

4. **Coverage Tier Classification:**

   | Tier | File Pattern | Coverage Recommendation |
   |------|--------------|------------------------|
   | **Critical** | `auth/*`, `payment/*`, `security/*`, `middleware/*` | ⚠️ Flag prominently if missing |
   | **Standard** | `lib/*`, `utils/*`, `api/*`, `server/*` | Note if missing |
   | **UI/Browser** | `app/**/page.tsx`, `components/*` | Browser testing covers these |
   | **Config/Types** | `*.config.*`, `types/*`, `*.d.ts` | No test required |

5. **Detection Heuristic for Critical Paths:**
   ```bash
   # Flag critical path changes without tests
   critical=$(echo "$changed" | grep -E 'auth|payment|security|middleware|server-action' || true)
   if [[ -n "$critical" ]]; then
     echo "⚠️ CRITICAL PATH CHANGES - test coverage strongly recommended:"
     echo "$critical"
   fi
   ```

6. **Behavior:**
   - **Warning-only**: Does NOT block test execution
   - Include coverage analysis in test results report
   - Recommend adding tests for uncovered critical paths
   - Note UI files are covered by browser testing (this skill)

**Why this matters:** Catching missing test coverage early:
- Prevents regressions from shipping untested code
- Ensures new logic has corresponding test validation
- Highlights critical paths that need extra scrutiny

## Decision Point: Feature Implemented or Not?

At this point, you've checked if the feature exists (section 1.2). Based on that result:

### Path A: Feature Implemented

**Continue to Phase 2** - Execute full test suite with browser automation.

**Workflow:**
1. Create test plan with TodoWrite (all test cases)
2. Execute tests systematically using Chrome DevTools MCP
3. Generate test results report
4. Post results to GitHub issue

### Path B: Feature Not Implemented

**Skip to Infrastructure Assessment** - Don't run browser tests, verify readiness instead.

**For P2/Deferred Features:**
1. Check backend infrastructure:
   - Database queries exist? (`lib/queries/`)
   - Database schema ready? (check migrations)
   - Utility functions available? (`lib/utils/`)
   - Dependencies installed? (`package.json`)
2. Create status report:
   - What infrastructure exists
   - What UI/frontend is missing
   - Current workaround (e.g., CLI tool)
3. Post "Feature Not Implemented" comment to GitHub issue
4. Document deferral decision (e.g., add note to `CLAUDE.md`)
5. Exit testing workflow

**For P0/P1 Features:**
1. Note that feature needs implementation
2. Recommend workflow:
   - `/spec <issue>` - Plan implementation
   - `/exec <issue>` - Implement feature
   - `/test <issue>` - Run tests after implementation
3. Exit testing workflow
4. Ask user: "Should I proceed with `/spec` and `/exec` now?"

## Phase 2: Test Execution

**Note:** Only proceed to Phase 2 if feature is implemented (Path A above).

### 2.1 Create Test Plan

Use TodoWrite to create a todo list with all test cases found:

```javascript
[
  { content: "Test 1: Basic functionality", status: "pending", activeForm: "Testing basic functionality" },
  { content: "Test 2: Edge cases", status: "pending", activeForm: "Testing edge cases" },
  // ... etc
]
```

### 2.2 Execute Tests Systematically

For each test case:

**Step 1: Display Test**
- Show test number, description, and steps
- Mark test as "in_progress" in todo list

**Step 2: Browser Automation**

Use Chrome DevTools MCP for browser-based tests:

```javascript
// Navigate to feature
mcp__chrome-devtools__navigate_page({url: "{{DEV_URL}}/..."})

// Get page structure
mcp__chrome-devtools__take_snapshot()

// Interact with elements (use UIDs from snapshot)
mcp__chrome-devtools__click({uid: "..."})
mcp__chrome-devtools__fill({uid: "...", value: "..."})
mcp__chrome-devtools__press_key({key: "Enter"})

// Verify state changes
mcp__chrome-devtools__take_snapshot()

// Document visual state
mcp__chrome-devtools__take_screenshot()

// Handle dialogs if needed
mcp__chrome-devtools__handle_dialog({action: "accept"})
```

**Step 3: Verify Results**

Compare actual vs. expected outcomes:
- Check snapshot for expected elements/state
- Verify visual appearance in screenshot
- Confirm behavior matches test requirements

**Step 4: Record Result**

Mark test status:
- **PASS**: All expectations met
- **FAIL**: Expected behavior not working
- **BLOCKED**: Cannot complete test (prerequisite failed, bug blocking)

Update todo list:
- PASS → status: "completed"
- FAIL/BLOCKED → keep status: "in_progress", document issue

### 2.3 Bug-Fix-Resume Pattern

When a bug is discovered during testing:

1. **Pause Testing**
   - Mark current test as BLOCKED
   - Document the bug clearly (expected vs. actual)

2. **Bug Fix Decision**
   - If bug is critical and fixable now → pause tests, fix bug, resume
   - If bug is non-critical → document, continue other tests
   - If bug blocks multiple tests → fix before continuing

3. **Resume Testing**
   - After fix, restart blocked test
   - Mark as PASS/FAIL based on fix
   - Continue with remaining tests

### 2.4 MCP Availability Check (Graceful Fallback)

**Before starting browser automation**, check if Chrome DevTools MCP is available:

```
Check if mcp__chrome-devtools__* tools are available in your current session.
```

**If MCP IS available:**
- Proceed with automated browser testing (Phase 2.1-2.3)

**If MCP is NOT available:**
- Skip browser automation steps
- Generate a **Manual Testing Checklist** instead

**Manual Testing Checklist (No MCP Fallback):**

When browser automation is unavailable, generate a structured manual testing guide:

```markdown
## Manual Testing Checklist for Issue #<N>

**Pre-requisites:**
- [ ] Dev server running at {{DEV_URL}}
- [ ] Browser open with DevTools ready
- [ ] Test data prepared (see section 1.3)

### Test 1: [Description]
**URL:** {{DEV_URL}}/path/to/feature
**Steps:**
1. Navigate to the URL above
2. [Action to perform]
3. [Expected result to verify]

**Expected Result:** [What should happen]
**Actual Result:** [ ] PASS / [ ] FAIL - Notes: ___

### Test 2: [Description]
**URL:** {{DEV_URL}}/path/to/feature
**Steps:**
1. [Step 1]
2. [Step 2]

**Expected Result:** [What should happen]
**Actual Result:** [ ] PASS / [ ] FAIL - Notes: ___

---
**Summary:** Complete each test above and mark PASS/FAIL.
Post results as a comment on this issue.
```

**Why this matters:**
- `/test` skill remains useful even without Chrome DevTools MCP
- Manual testers can follow the structured checklist
- Test results format remains consistent for reporting

## Phase 3: Reporting

### 3.1 Generate Test Summary

Create structured test results:

```markdown
## Testing Results for Issue #<N>

**Summary:** X/Y tests passed

### Test Results

**Test 1: [Description]** - PASS
- Steps executed successfully
- Expected behavior confirmed
- Screenshots: [if applicable]

**Test 2: [Description]** - FAIL
- Steps executed: [list]
- Expected: [what should happen]
- Actual: [what happened]
- Issue: [describe the problem]

**Test 3: [Description]** - BLOCKED
- Blocker: [describe blocking issue]
- Dependency: [what needs to be fixed first]

### Bugs Found

1. **[Bug Title]**
   - Location: [file:line]
   - Issue: [description]
   - Fix: [applied/pending]
   - Status: [fixed/documented for follow-up]

### Coverage

- Completed: X tests
- Failed: Y tests
- Blocked: Z tests
- Remaining: W tests

### Recommendations

- [Next steps]
- [Follow-up issues needed]
- [Areas needing additional testing]
```

### 3.2 GitHub Comment

**If orchestrated (SEQUANT_ORCHESTRATOR is set):**
- Skip posting GitHub comment (orchestrator handles summary)
- Include test summary in output for orchestrator to capture
- Let orchestrator aggregate results across phases

**If standalone:**

Draft comment for Issue #<N>:

```markdown
## Testing Progress Update

[Test summary from above]

### Next Steps

- [ ] [Action item 1]
- [ ] [Action item 2]

**Testing tools used:** Chrome DevTools MCP, manual verification
```

Offer to post comment:
```bash
gh issue comment <issue-number> --body "$(cat <<'EOF'
[comment content]
EOF
)"
```

## Test Case Detection Patterns

Parse Issue body for these test formats:

**Format 1: Numbered headers**
```
### Test 1: Description
Steps...

### Test 2: Description
Steps...
```

**Format 2: Bold labels**
```
**Test 1:** Description
- Step 1
- Step 2

**Test 2:** Description
- Step 1
```

**Format 3: Numbered lists**
```
1. Test basic functionality:
   - Step a
   - Step b
2. Test edge cases:
   - Step a
```

**Format 4: Acceptance Criteria as Tests**
If no explicit tests, use AC as test cases:
```
**AC-1:** User can do X
→ Test 1: Verify user can do X

**AC-2:** System shows Y
→ Test 2: Verify system shows Y
```

## Browser Testing Best Practices

**Reference:** See [Browser Testing Patterns](references/browser-testing-patterns.md) for comprehensive patterns including forms, modals, grids, async content, and troubleshooting.

### Snapshots vs. Screenshots

**Use `take_snapshot()` when:**
- You need to interact with elements (get UIDs)
- Verifying text content or element presence
- Checking accessibility tree structure
- Automating clicks/fills/navigation

**Use `take_screenshot()` when:**
- Documenting visual appearance
- Capturing hover states, colors, layouts
- Creating test evidence for reports
- Comparing before/after states visually

### Common Testing Patterns

**Pattern 1: Form Submission**
```javascript
// 1. Navigate to form
navigate_page({url: "..."})

// 2. Get form structure
take_snapshot()

// 3. Fill form fields
fill({uid: "name_field", value: "Test Name"})
fill({uid: "email_field", value: "test@example.com"})

// 4. Submit
click({uid: "submit_button"})

// 5. Verify result
wait_for({text: "Success"})
take_snapshot()
```

**Pattern 2: Modal Interactions**
```javascript
// 1. Open modal
click({uid: "open_modal_button"})

// 2. Verify modal content
take_snapshot()  // Should show modal in tree

// 3. Interact with modal
fill({uid: "modal_input", value: "test"})
click({uid: "modal_confirm"})

// 4. Verify modal closed
take_snapshot()  // Modal should be gone
```

**Pattern 3: Multi-Selection Testing**
```javascript
// 1. Get initial state
take_snapshot()  // Note initial selection count

// 2. Select items
click({uid: "checkbox_1"})
take_snapshot()  // Verify count updated

click({uid: "checkbox_2"})
take_snapshot()  // Verify count updated

// 3. Perform bulk action
click({uid: "bulk_action_button"})
take_snapshot()  // Verify action UI
```

**Pattern 4: Escape/Cancel Testing**
```javascript
// 1. Open UI element (modal, dropdown, etc.)
click({uid: "trigger"})

// 2. Press Escape
press_key({key: "Escape"})

// 3. Verify closed
take_snapshot()  // Element should not be present
```

## Test Data Cleanup

After testing completes, ask user if test data should be cleaned up:

**Option 1: Delete test data**
```sql
-- Clean up test records created during testing
DELETE FROM <table> WHERE name LIKE 'Test %';
```

**Option 2: Keep for future testing**
- Document that test data exists
- Note: May need to update or regenerate for next test session

## Exit Conditions

Testing session is complete when:

1. All test cases executed (or explicitly skipped)
2. Test results documented with PASS/FAIL/BLOCKED status
3. Bugs found have been fixed or documented
4. Test summary generated
5. GitHub comment drafted (and optionally posted)
6. Recommendations for next steps provided

## Example Invocation

```bash
/test 151
```

**Expected workflow:**
1. Fetch Issue #151
2. Detect 10 test cases in Issue body
3. Check for seed script or test fixtures
4. Start dev server if needed
5. Execute tests 1-10 using Chrome DevTools MCP
6. Generate test summary with PASS/FAIL/BLOCKED status
7. Draft GitHub comment with results
8. Offer to post comment and identify next steps

## Integration with Development Workflow

**Typical usage pattern:**

```
/spec <issue>    → Plan the feature
/exec <issue>    → Implement the feature
/test <issue>    → Test the feature (browser-based)
/qa <issue>      → Code review and quality assessment
```

**Alternative: Test-Driven Development**
```
/spec <issue>    → Plan the feature
/test <issue>    → Run tests (expect failures)
/exec <issue>    → Implement until tests pass
/qa <issue>      → Final code review
```

**When to use `/test` vs `/qa`:**
- **`/test`**: Browser-based functional testing, user workflows, UI interactions
- **`/qa`**: Code review, AC validation, architecture assessment, merge readiness

Both can be used together:
1. `/test` → Verify feature works for users
2. `/qa` → Verify code quality and completeness

---

## State Tracking

**IMPORTANT:** Update workflow state when running standalone (not orchestrated).

### State Updates (Standalone Only)

When NOT orchestrated (`SEQUANT_ORCHESTRATOR` is not set):

**At skill start:**
```bash
npx tsx scripts/state/update.ts start <issue-number> test
```

**On successful completion:**
```bash
npx tsx scripts/state/update.ts complete <issue-number> test
```

**On failure:**
```bash
npx tsx scripts/state/update.ts fail <issue-number> test "X/Y tests failed"
```

**Why this matters:** State tracking enables dashboard visibility, resume capability, and workflow orchestration. Skills update state when standalone; orchestrators handle state when running workflows.

---

## Output Verification

**Before responding, verify your output includes ALL of these:**

- [ ] **Test Summary** - X/Y tests passed
- [ ] **Test Results Table** - Each test marked PASS, FAIL, or BLOCKED
- [ ] **Bugs Found** - List of bugs with file:line locations (if any)
- [ ] **Coverage** - Completed, failed, blocked, remaining counts
- [ ] **Recommendations** - Next steps for failures or follow-up

**DO NOT respond until all items are verified.**
