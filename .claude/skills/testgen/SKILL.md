---
name: testgen
description: "Generate test stubs from /spec verification criteria"
license: MIT
metadata:
  author: sequant
  version: "1.0"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash(gh issue view:*)
  - Bash(gh issue comment:*)
  - Bash(npm test:*)
  - Bash(git worktree list:*)
  - Bash(ls:*)
  - Bash(mkdir:*)
  - Task(general-purpose)
---

# Test Generation Command

You are the "Test Generation Agent" for the current repository.

## Purpose

When invoked as `/testgen <issue-number>`, your job is to:

1. Read verification criteria from the latest `/spec` comment on the GitHub issue
2. Parse each AC's verification method and test scenario
3. Generate appropriate test stubs based on verification method type
4. Output stubs to the correct directories with TODO markers
5. Post a summary comment to the GitHub issue

## Invocation

- `/testgen 123` - Generate test stubs for issue #123 based on /spec comment
- `/testgen` - Generate stubs for the most recently discussed issue in conversation

## Token Optimization with Haiku Sub-Agents

**Purpose:** Test stub generation is highly mechanical and benefits from using haiku sub-agents to minimize token cost.

**Pattern:** Use `Task(subagent_type="general-purpose", model="haiku")` for:
1. Parsing verification criteria from /spec comments
2. Generating individual test stubs from templates
3. Writing test file content

**Benefits:**
- 90% token cost reduction for mechanical generation
- Faster execution for templated operations
- Main agent focuses on orchestration and decisions

### Sub-Agent Usage

**Step 1: Parse Verification Criteria (use haiku)**

```javascript
Task(subagent_type="general-purpose", model="haiku", prompt=`
Parse the following /spec comment and extract verification criteria.

For each AC, extract:
- AC number and description
- Verification method (Unit Test, Integration Test, Browser Test, Manual Test)
- Test scenario (Given/When/Then)
- Integration points
- Assumptions to validate

Return as JSON:
{
  "criteria": [
    {
      "acNumber": "AC-1",
      "description": "...",
      "verificationMethod": "Unit Test",
      "scenario": { "given": "...", "when": "...", "then": "..." },
      "integrationPoints": ["..."],
      "assumptions": ["..."]
    }
  ]
}

/spec comment:
${specComment}
`)
```

**Step 2: Generate Test Stubs (use haiku for each AC)**

```javascript
// For each AC with Unit Test or Integration Test verification method
Task(subagent_type="general-purpose", model="haiku", prompt=`
Generate a Jest test stub for the following verification criteria.

AC: ${ac.acNumber}: ${ac.description}
Verification Method: ${ac.verificationMethod}
Test Scenario:
- Given: ${ac.scenario.given}
- When: ${ac.scenario.when}
- Then: ${ac.scenario.then}

Use the template format:
- Include Given/When/Then as comments
- Add TODO markers where implementation is needed
- Include failure path stubs based on the action verb
- Use throw new Error('Test stub - implement this test')

Return ONLY the test code, no explanation.
`)
```

**Step 3: Write Test Files (main agent)**

The main agent handles file operations to ensure proper coordination:
- Check if files exist (don't overwrite)
- Create directories if needed
- Write generated stubs to correct locations

### When to Use Sub-Agents vs Main Agent

| Task | Agent | Reasoning |
|------|-------|-----------|
| Parse /spec comment | haiku | Mechanical text extraction |
| Generate test stub code | haiku | Templated generation |
| Identify failure scenarios | haiku | Pattern matching |
| Decide file locations | main | Requires codebase context |
| Write files | main | File system coordination |
| Post GitHub comment | main | Session context needed |

### Parallel Sub-Agent Execution

When multiple ACs need test stubs, spawn haiku agents in parallel:

```javascript
// Spawn all stub generation agents in a single message
const stubPromises = criteria
  .filter(ac => ac.verificationMethod === 'Unit Test' || ac.verificationMethod === 'Integration Test')
  .map(ac => Task(subagent_type="general-purpose", model="haiku", prompt=`Generate test stub for ${ac.acNumber}...`))

// Collect results
// Main agent writes all files
```

**Cost savings example:**
- 5 AC items with Unit Test verification
- Without haiku: ~50K tokens (main agent generates all)
- With haiku: ~5K tokens (main orchestrates, haiku generates)
- Savings: ~90%

## Workflow

### Step 1: Read Verification Criteria from GitHub Issue

```bash
gh issue view <issue-number> --json comments --jq '.comments | reverse | .[0].body'
```

Look for the `/spec` planning comment containing verification criteria blocks:

```markdown
### AC-1: [Description]

**Verification Method:** Unit Test | Integration Test | Manual Test | Browser Test

**Test Scenario:**
- Given: [Initial state]
- When: [Action]
- Then: [Expected outcome]

**Integration Points:**
- [External system or component]

**Assumptions to Validate:**
- [ ] [Assumption 1]
- [ ] [Assumption 2]
```

### Step 2: Parse Verification Criteria

For each AC, extract:
- **AC number and description**
- **Verification method** (Unit Test, Integration Test, Browser Test, Manual Test, N/A)
- **Test scenario** (Given/When/Then)
- **Integration points**
- **Assumptions to validate**

### Step 2.1: Identify Failure Scenarios from /spec

Scan the `/spec` comment for failure scenarios to generate additional test stubs:

**Explicit Error Handling Sections:**
Look for these section headers in the `/spec` output:
- "Error handling"
- "Edge cases"
- "What could go wrong"
- "Risks & Mitigations"

Extract scenarios from these sections and add as failure path stubs.

**Negative Requirements:**
Look for patterns indicating what should NOT happen:
- "should NOT allow"
- "must NOT"
- "reject"
- "block"
- "prevent"
- "deny"
- "fail when"
- "throw when"

Each negative requirement becomes a failure path test stub.

**Inferred Failure Scenarios:**
Based on the action verb in each AC, infer common failure scenarios:

| Action Verb | Happy Path | Inferred Failure Paths |
|-------------|------------|------------------------|
| Create | Successfully creates X | - Fail to create when invalid input<br>- Handle duplicate X<br>- Reject unauthorized create |
| Fetch/Read | Returns X data | - Handle missing X (404)<br>- Handle fetch timeout<br>- Handle malformed response |
| Update | Successfully updates X | - Reject update with invalid data<br>- Handle concurrent updates<br>- Reject unauthorized update |
| Delete | Successfully deletes X | - Handle delete of non-existent X<br>- Handle delete when X is in use<br>- Reject unauthorized delete |
| Submit | Successfully submits form | - Show validation errors<br>- Handle server rejection<br>- Handle network timeout |
| Authenticate | Login succeeds | - Reject invalid credentials<br>- Handle locked account<br>- Handle session timeout |

### Step 3: Generate Test Stubs by Verification Method

#### Unit Test → Jest stub in `__tests__/`

**Output file:** `__tests__/[feature-name].test.ts`

**Template:**
```typescript
// Generated test stub for Issue #<issue-number>
// AC-<N>: <description>
// Run with: npm test -- __tests__/<feature-name>.test.ts

describe('<Feature Name>', () => {
  describe('AC-<N>: <description>', () => {
    it('should <expected behavior from Then clause>', () => {
      // Given: <initial state>
      // TODO: Set up test fixtures

      // When: <action>
      // TODO: Call the function/method being tested

      // Then: <expected outcome>
      // TODO: Add assertions

      throw new Error('Test stub - implement this test');
    });

    // === FAILURE PATHS ===
    describe('error handling', () => {
      it('should throw when <invalid condition>', () => {
        // Given: <invalid input or state>
        // TODO: Set up invalid test conditions

        // When: <action with invalid input>
        // TODO: Call the function with invalid input

        // Then: <error thrown or graceful failure>
        // TODO: Expect error to be thrown or handled gracefully

        throw new Error('Failure path stub - implement this test');
      });

      it('should return null/empty when <edge case>', () => {
        // Given: <edge case condition>
        // TODO: Set up edge case (empty array, null input, etc.)

        // When: <action>
        // TODO: Call the function

        // Then: <graceful handling>
        // TODO: Assert null, empty, or default value returned

        throw new Error('Edge case stub - implement this test');
      });
    });
  });
});
```

#### Integration Test → Template in `__tests__/integration/`

**Output file:** `__tests__/integration/[feature-name].integration.test.ts`

**Template:**
```typescript
// Generated integration test stub for Issue #<issue-number>
// AC-<N>: <description>
// Run with: npm test -- __tests__/integration/<feature-name>.integration.test.ts

import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

describe('<Feature Name> - Integration', () => {
  // === SANDBOX ISOLATION ===
  // Each test run gets a unique temp directory to prevent test pollution
  // and support parallel test execution.
  const TEST_DIR = `/tmp/sequant-test-${process.pid}-${Date.now()}`;

  // Integration Points:
  // - <integration point 1>
  // - <integration point 2>

  // Assumptions to Validate:
  // - [ ] <assumption 1>
  // - [ ] <assumption 2>

  beforeAll(async () => {
    // Create isolated test directory
    fs.mkdirSync(TEST_DIR, { recursive: true });
    process.env.TEST_TMP_DIR = TEST_DIR;

    // TODO: Set up integration test environment
    // - Ensure external dependencies are available
    // - Set up test data/fixtures
  });

  afterAll(async () => {
    // TODO: Clean up integration test environment
    // - Remove test data
    // - Reset external state

    // DEBUGGING: Comment out the next line to inspect test artifacts after failure
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.TEST_TMP_DIR;
  });

  // For database isolation (future): Create test schema in beforeAll,
  // drop in afterAll. Pattern: `test_schema_${process.pid}_${Date.now()}`

  describe('AC-<N>: <description>', () => {
    it('should <expected behavior from Then clause>', async () => {
      // Given: <initial state>
      // TODO: Set up test preconditions
      // Use TEST_DIR for any file operations, e.g.:
      // const testFile = path.join(TEST_DIR, 'test-output.log');

      // When: <action>
      // TODO: Execute the integration action

      // Then: <expected outcome>
      // TODO: Verify integration result

      throw new Error('Integration test stub - implement this test');
    });

    // Assumption validation tests
    it('validates assumption: <assumption 1>', async () => {
      // TODO: Verify this assumption holds true
      // This test documents and validates a critical assumption

      throw new Error('Assumption validation stub - implement this test');
    });
  });

  // === ERROR SCENARIOS ===
  describe('error scenarios', () => {
    it('should handle <external service failure>', async () => {
      // Given: <external dependency is unavailable/erroring>
      // TODO: Mock external service to return error

      // When: <action that depends on external service>
      // TODO: Execute the integration action

      // Then: <graceful degradation or clear error>
      // TODO: Verify error is caught and handled appropriately

      throw new Error('Error scenario stub - implement this test');
    });

    it('should recover from <transient failure>', async () => {
      // Given: <temporary failure condition>
      // TODO: Simulate transient failure (network timeout, temporary 503)

      // When: <action with retry logic>
      // TODO: Execute with potential retry

      // Then: <successful recovery or clear failure after retries>
      // TODO: Verify retry behavior or graceful degradation

      throw new Error('Recovery stub - implement this test');
    });

    it('should handle concurrent operations safely', async () => {
      // Given: <multiple simultaneous operations>
      // TODO: Set up parallel execution

      // When: <concurrent actions>
      // TODO: Run operations in parallel

      // Then: <no data corruption, proper isolation>
      // TODO: Verify data integrity

      throw new Error('Concurrency stub - implement this test');
    });
  });
});
```

#### Browser Test → Scenarios for `/test` command

**Output:** GitHub comment with test scenarios (not a file)

**Template:**
```markdown
## Browser Test Scenarios for AC-<N>

**For use with `/test <issue-number>`**

### Scenario 1: <scenario name>

**Given:**
- <precondition 1>
- <precondition 2>

**Steps:**
1. Navigate to <URL>
2. <action 1>
3. <action 2>

**Expected:**
- [ ] <verification 1>
- [ ] <verification 2>

**Chrome DevTools MCP Commands:**
```javascript
// Navigation
mcp__chrome-devtools__navigate_page({ url: "<URL>" })

// Snapshot to find elements
mcp__chrome-devtools__take_snapshot()

// Interact with elements
mcp__chrome-devtools__click({ uid: "<element-uid>" })
mcp__chrome-devtools__fill({ uid: "<input-uid>", value: "<test-value>" })

// Verify results
mcp__chrome-devtools__take_screenshot()
```

### Negative Test Scenarios

**Scenario: Invalid form submission**
- Given: Form is displayed with required fields
- When: Submit with empty required fields
- Expected:
  - [ ] Validation errors displayed inline
  - [ ] Form not submitted to server
  - [ ] Focus moves to first error field
  - [ ] Error message is descriptive

**Scenario: Unauthorized access attempt**
- Given: User is not logged in / lacks permission
- When: Navigate to protected route directly
- Expected:
  - [ ] Redirect to login or access denied page
  - [ ] No protected content visible in DOM
  - [ ] Appropriate error message shown
  - [ ] No sensitive data in network requests

**Scenario: Network failure graceful degradation**
- Given: Page is loaded successfully
- When: Network becomes unavailable during action
- Expected:
  - [ ] User-friendly error message displayed
  - [ ] No unhandled exceptions in console
  - [ ] Retry option available (if applicable)
  - [ ] User can recover by retrying
```

#### Manual Test → Checklist

**Output:** GitHub comment with checklist (not a file)

**Template:**
```markdown
## Manual Test Checklist for AC-<N>

### Prerequisites
- [ ] <prerequisite 1>
- [ ] <prerequisite 2>

### Test Steps
1. **Setup:** <setup step>
2. **Action:** <action to perform>
3. **Verify:** <what to check>

### Expected Results
- [ ] <expected result 1>
- [ ] <expected result 2>

### Error Handling Verification
- [ ] Invalid input shows appropriate error message
- [ ] Network failure shows user-friendly error
- [ ] Timeout shows loading state then error
- [ ] Concurrent operations don't cause data corruption

### Edge Cases
- [ ] Empty state displays correctly (no data)
- [ ] Maximum values handled (long strings, large numbers)
- [ ] Minimum values handled (0, empty string, null)
- [ ] Special characters handled properly (unicode, emojis, HTML)

### Notes
- <any special considerations>
```

#### N/A - Trivial → Skip with note

If an AC has verification method "N/A - Trivial", skip test generation and note why.

### Step 4: Locate Feature Worktree

If generating file-based tests (Unit Test, Integration Test), find the worktree:

```bash
git worktree list | grep -E "feature.*<issue-number>" || true
```

Or check:
```bash
ls ../worktrees/feature/<issue-number>-*/
```

Create test directories if needed:
```bash
mkdir -p __tests__/integration
```

### Step 5: Write Test Files

For each test file generated:
1. Check if file already exists (don't overwrite)
2. Write the generated stub to the appropriate directory
3. Ensure file is executable and has proper imports

### Step 6: Post Summary to GitHub Issue

Create a comment summarizing what was generated:

```markdown
## Test Stubs Generated

| AC | Verification | Happy Path | Failure Paths |
|----|--------------|------------|---------------|
| AC-1 | Unit Test | 1 test | 2 error cases |
| AC-2 | Integration | 1 test | 3 error scenarios |
| AC-3 | Browser Test | 2 scenarios | 3 negative scenarios |
| AC-4 | Manual Test | 2 items | 8 failure checks |
| AC-5 | N/A - Trivial | Skipped | - |

**Counts explained:**
- **Happy Path:** Number of positive/success test stubs or scenarios
- **Failure Paths:** Number of error handling, edge case, and negative test stubs

### Unit Test Stubs
- `__tests__/<feature>.test.ts`
  - Happy path: X test cases
  - Error handling: Y failure stubs

### Integration Test Stubs
- `__tests__/integration/<feature>.integration.test.ts`
  - Happy path: X test cases
  - Assumption validators: Y tests
  - Error scenarios: Z failure stubs

### Browser Test Scenarios
**Positive scenarios:** [count]
[Browser test scenarios here]

**Negative scenarios:** [count]
[Negative scenarios here]

### Manual Test Checklists
**Expected results:** [count] items
[Manual test checklists here]

**Error handling verification:** 4 items
**Edge cases:** 4 items

---

**Next steps:**
1. Implement the test stubs (replace `throw new Error(...)` with actual test logic)
2. Run `/exec <issue>` to implement the feature
3. Verify tests pass with `npm test`

---
Generated with [Claude Code](https://claude.com/claude-code)
```

## Error Handling

### No Verification Criteria Found

If the issue doesn't have verification criteria in the /spec comment:

```markdown
## Unable to Generate Tests

No verification criteria found in the latest /spec comment for Issue #<N>.

**Next steps:**
1. Run `/spec <issue>` first to create a plan with verification criteria
2. Ensure each AC has a "Verification Method" and "Test Scenario"
3. Then run `/testgen <issue>` again
```

### Missing Worktree

If generating file-based tests and no worktree exists:

```markdown
## Worktree Not Found

Cannot generate test files - no feature worktree exists for Issue #<N>.

**Options:**
1. Run `/exec <issue>` first (creates worktree automatically)
2. Create worktree manually: `./scripts/dev/new-feature.sh <issue>`
3. Use the browser/manual test scenarios from this comment
```

### Existing Test Files

If test files already exist:
- Don't overwrite existing tests
- Note which files were skipped
- Suggest reviewing existing tests against new verification criteria

## Example Output

For Issue #452 (hooks):

**Generated files:**
- `__tests__/integration/hooks.integration.test.ts`

**GitHub comment:**
```markdown
## Test Stubs Generated for Issue #452

| AC | Verification | Happy Path | Failure Paths |
|----|--------------|------------|---------------|
| AC-1 | Integration | 1 test | 3 error scenarios |

### Integration Test Stubs

**File:** `__tests__/integration/hooks.integration.test.ts`
- Happy path: 1 test case
- Assumption validators: 1 test
- Error scenarios: 3 failure stubs

**Assumptions to validate before implementation:**
- [ ] Claude Code passes tool data via stdin JSON (NOT env vars)
- [ ] stdin JSON contains tool_name field
- [ ] stdin JSON contains tool_input field
- [ ] Hook can parse JSON with jq
- [ ] Hook has write permission to /tmp

---
Generated with [Claude Code](https://claude.com/claude-code)
```

---

## State Tracking

**IMPORTANT:** Update workflow state when running standalone (not orchestrated).

### State Updates (Standalone Only)

When NOT orchestrated (`SEQUANT_ORCHESTRATOR` is not set):

**At skill start:**
```bash
npx tsx scripts/state/update.ts start <issue-number> testgen
```

**On successful completion:**
```bash
npx tsx scripts/state/update.ts complete <issue-number> testgen
```

**On failure:**
```bash
npx tsx scripts/state/update.ts fail <issue-number> testgen "Failed to generate test stubs"
```

**Note:** `/testgen` is an optional skill that generates test stubs. State tracking is informational - it doesn't block subsequent phases.

---

## Output Verification

**Before responding, verify your output includes ALL of these:**

- [ ] **AC Parsing** - Each AC identified with verification method
- [ ] **Test Stubs Generated** - Files created for Unit/Integration tests
- [ ] **Browser/Manual Scenarios** - Written for applicable AC items
- [ ] **Failure Paths** - Error handling stubs for each AC
- [ ] **Summary Table** - AC count, happy path count, failure path count
- [ ] **GitHub Comment** - Summary posted to issue

**DO NOT respond until all items are verified.**
