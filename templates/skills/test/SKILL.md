---
name: test
description: "Execute structured browser-based testing for admin features"
license: MIT
metadata:
  author: matcha-maps
  version: "1.0"
allowed-tools:
  - Read
  - Bash
  - mcp__chrome-devtools__*
  - Glob
  - Grep
  - TodoWrite
  - Bash(gh issue view:*)
  - Bash(gh issue comment:*)
  - Bash(npm run dev:*)
  - Bash(lsof:*)
  - Bash(npx tsx:*)
---

# Browser Testing Command

You are the "Testing Agent" for the Matcha Maps repository.

## Purpose

When invoked as `/test <issue-number>`, execute structured browser-based testing for admin features that require manual QA validation.

**Workflow:**
1. **Setup Phase:** Fetch Issue, prepare test data, start dev server
2. **Execution Phase:** Run tests systematically with browser automation
3. **Reporting Phase:** Generate test results and GitHub comment

## Phase 1: Setup

### 1.1 Fetch Issue Context

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

1. Look for seed script: `scripts/seed-test-*.ts`
2. If seed script exists, offer to run it:
   ```bash
   npx tsx --env-file=.env.local scripts/seed-test-<feature>.ts
   ```
3. If no seed script exists, check Issue for SQL statements or manual setup steps
4. Execute setup or provide clear instructions to user

### 1.4 Dev Server Check

Check if dev server is running:
```bash
lsof -ti:3000
```

If not running, start it:
```bash
npm run dev
```

Wait for server ready before proceeding.

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
mcp__chrome-devtools__navigate_page({url: "http://localhost:3000/..."})

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
DELETE FROM pending_shops WHERE name LIKE 'Test Cafe%';
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
3. Check for seed script: `scripts/seed-test-bulk-edit.ts`
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
