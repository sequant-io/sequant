---
name: spec
description: "Plan review vs Acceptance Criteria for a single GitHub issue, plus issue comment draft."
license: MIT
metadata:
  author: sequant
  version: "1.0"
allowed-tools:
  - Bash(npm test:*)
  - Bash(gh issue view:*)
  - Bash(gh issue comment:*)
  - Bash(gh issue edit:*)
  - Bash(gh label:*)
  - Bash(git worktree:*)
  - Bash(git -C:*)
  - Task(Explore)
  - AgentOutputTool
---

# Planning Agent

You are the Phase 1 "Planning Agent" for the current repository.

## Purpose

When invoked as `/spec`, your job is to:

1. Understand the issue and Acceptance Criteria (AC).
2. Review or synthesize a clear plan to address the AC.
3. Identify ambiguities, gaps, or risks.
4. Draft a GitHub issue comment summarizing AC + the agreed plan.

## Phase Detection (Smart Resumption)

**Before executing**, check if this phase has already been completed by reading phase markers from issue comments:

```bash
# Check for existing phase markers
phase_data=$(gh issue view <issue-number> --json comments --jq '[.comments[].body]' | \
  grep -oP '<!-- SEQUANT_PHASE: \K\{[^}]+\}' | tail -1)

if [[ -n "$phase_data" ]]; then
  phase=$(echo "$phase_data" | jq -r '.phase')
  status=$(echo "$phase_data" | jq -r '.status')

  # Skip if spec is already completed or a later phase is completed
  if [[ "$phase" == "spec" && "$status" == "completed" ]] || \
     [[ "$phase" == "exec" || "$phase" == "test" || "$phase" == "qa" ]]; then
    echo "⏭️ Spec phase already completed (detected: $phase:$status). Skipping."
    # Exit early — no work needed
  fi
fi
```

**Behavior:**
- If `spec:completed` or a later phase is detected → Skip with message
- If `spec:failed` → Re-run spec (retry)
- If no markers found → Normal execution (fresh start)
- If detection fails (API error) → Fall through to normal execution

**Phase Marker Emission:**

When posting the spec plan comment to GitHub, append a phase marker at the end:

```markdown
<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"<ISO-8601>"} -->
```

Include this marker in every `gh issue comment` that represents phase completion.

## Behavior

When called like `/spec 123`:
1. Treat `123` as a GitHub issue number.
2. **Read all GitHub issue comments** for complete context.
3. Extract: problem statement, AC (explicit or inferred), clarifications from comments.

When called like `/spec <freeform description>`:
1. Treat the text as the problem/AC source.
2. Ask clarifying questions if AC are ambiguous or conflicting.

**Flag:** `--skip-ac-lint`
- Usage: `/spec 123 --skip-ac-lint`
- Effect: Skips the AC Quality Check step
- Use when: AC are intentionally high-level or you want to defer linting

**Flag:** `--skip-scope-check`
- Usage: `/spec 123 --skip-scope-check`
- Effect: Skips the Scope Assessment step
- Use when: Issue scope is intentionally complex or you want to defer assessment

### AC Extraction and Storage — REQUIRED

**After fetching the issue body**, extract and store acceptance criteria in workflow state:

```bash
# Extract AC from issue body and store in state
npx tsx -e "
import { extractAcceptanceCriteria } from './src/lib/ac-parser.js';
import { StateManager } from './src/lib/workflow/state-manager.js';

const issueBody = \`<ISSUE_BODY_HERE>\`;
const issueNumber = <ISSUE_NUMBER>;
const issueTitle = '<ISSUE_TITLE>';

const ac = extractAcceptanceCriteria(issueBody);
console.log('Extracted AC:', JSON.stringify(ac, null, 2));

if (ac.items.length > 0) {
  const manager = new StateManager();
  // Initialize issue if not exists
  const existing = await manager.getIssueState(issueNumber);
  if (!existing) {
    await manager.initializeIssue(issueNumber, issueTitle);
  }
  await manager.updateAcceptanceCriteria(issueNumber, ac);
  console.log('AC stored in state for issue #' + issueNumber);
}
"
```

**Why this matters:** Storing AC in state enables:
- Dashboard visibility of AC progress per issue
- `/qa` skill to update AC status during review
- Cross-skill AC tracking throughout the workflow

**AC Format Detection:**
The parser supports multiple formats:
- `- [ ] **AC-1:** Description` (bold with hyphen)
- `- [ ] **B2:** Description` (letter + number)
- `- [ ] AC-1: Description` (no bold)

**If no AC found:**
- Log a warning but continue with planning
- The plan output should note that AC will need to be defined

### AC Quality Check — REQUIRED (unless --skip-ac-lint)

**After extracting AC**, run the AC linter to flag vague, untestable, or incomplete requirements:

```bash
# Lint AC for quality issues (skip if --skip-ac-lint flag is set)
npx tsx -e "
import { parseAcceptanceCriteria } from './src/lib/ac-parser.js';
import { lintAcceptanceCriteria, formatACLintResults } from './src/lib/ac-linter.js';

const issueBody = \`<ISSUE_BODY_HERE>\`;

const criteria = parseAcceptanceCriteria(issueBody);
const lintResults = lintAcceptanceCriteria(criteria);
console.log(formatACLintResults(lintResults));
"
```

**Why this matters:** Vague AC lead to:
- Ambiguous implementations that don't match expectations
- Subjective /qa verdicts ("does it work properly?")
- Wasted iteration cycles when requirements are clarified late

**Pattern Detection:**

| Pattern Type | Examples | Issue |
|--------------|----------|-------|
| Vague | "should work", "properly", "correctly" | Subjective, no measurable outcome |
| Unmeasurable | "fast", "performant", "responsive" | No threshold defined |
| Incomplete | "handle errors", "edge cases" | Specific scenarios not enumerated |
| Open-ended | "etc.", "and more", "such as" | Scope is undefined |

**Example Output:**

```markdown
## AC Quality Check

⚠️ **AC-2:** "System should handle errors gracefully"
   → Incomplete: error types not specified
   → Suggest: List specific error types and expected responses (e.g., 400 for invalid input, 503 for service unavailable)

⚠️ **AC-4:** "Page loads quickly"
   → Unmeasurable: "quickly" has no threshold
   → Suggest: Specify time limit (e.g., completes in <5 seconds)

✅ AC-1, AC-3, AC-5: Clear and testable

**Summary:** 2/5 AC items flagged for review
```

**Behavior:**
- **Warning-only**: AC Quality Check does NOT block planning
- Issues are surfaced in the output but plan generation continues
- Include flagged AC in the issue comment draft with suggestions
- Recommend refining vague AC before implementation

**If `--skip-ac-lint` flag is set:**
- Output: `AC Quality Check: Skipped (--skip-ac-lint flag set)`
- Continue directly to plan generation

### Scope Assessment — REQUIRED (unless --skip-scope-check)

**After AC Quality Check**, run scope assessment to detect overscoped issues:

```bash
# Run scope assessment (skip if --skip-scope-check flag is set)
npx tsx -e "
import { parseAcceptanceCriteria } from './src/lib/ac-parser.js';
import { performScopeAssessment, formatScopeAssessment } from './src/lib/scope/index.js';

const issueBody = \`<ISSUE_BODY_HERE>\`;
const issueTitle = '<ISSUE_TITLE>';

const criteria = parseAcceptanceCriteria(issueBody);
const assessment = performScopeAssessment(criteria, issueBody, issueTitle);
console.log(formatScopeAssessment(assessment));
"
```

**Why this matters:**
- Bundled features (3+ distinct features) should be separate issues
- Missing non-goals lead to scope creep during implementation
- High AC counts increase complexity and error rates

**Scope Metrics:**

| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Feature count | 1 | 2 | 3+ |
| AC items | 1-5 | 6-8 | 9+ |
| Directory spread | 1-2 | 3-4 | 5+ |

**Non-Goals Section:**

Every `/spec` output MUST include a Non-Goals section. If the issue lacks one, output a warning:

```markdown
## Non-Goals

⚠️ **Non-Goals section not found.** Consider adding scope boundaries.

Example format:
- [ ] [Adjacent feature we're deferring]
- [ ] [Scope boundary we're respecting]
- [ ] [Future work that's out of scope]
```

**Scope Verdicts:**

| Verdict | Meaning | Action |
|---------|---------|--------|
| ✅ SCOPE_OK | Single focused feature | Proceed normally |
| ⚠️ SCOPE_WARNING | Moderate complexity | Consider narrowing; quality loop auto-enabled |
| ❌ SCOPE_SPLIT_RECOMMENDED | Multiple features bundled | Strongly recommend splitting |

**Quality Loop Auto-Enable:**

If scope verdict is SCOPE_WARNING or SCOPE_SPLIT_RECOMMENDED:
- Quality loop is automatically enabled
- Include note in Recommended Workflow section:
  ```markdown
  **Quality Loop:** enabled (auto-enabled due to scope concerns)
  ```

**If `--skip-scope-check` flag is set:**
- Output: `Scope Assessment: Skipped (--skip-scope-check flag set)`
- Continue to plan generation

**Store in State:**

After assessment, store results in workflow state for analytics:

```bash
npx tsx -e "
import { StateManager } from './src/lib/workflow/state-manager.js';
import { performScopeAssessment } from './src/lib/scope/index.js';

// ... perform assessment ...

const manager = new StateManager();
await manager.updateScopeAssessment(issueNumber, assessment);
"
```

### Feature Worktree Workflow

**Planning Phase:** No worktree needed. Planning happens in the main repository directory. The worktree will be created during the execution phase (`/exec`).

### Parallel Context Gathering — REQUIRED

**You MUST spawn sub-agents for context gathering.** Do NOT explore the codebase inline with Glob/Grep commands. Sub-agents provide parallel execution, better context isolation, and consistent reporting.

**Check agent execution mode first:**
```bash
parallel=$(cat .sequant/settings.json 2>/dev/null | jq -r '.agents.parallel // false')
```

#### If parallel mode enabled:

**Spawn ALL THREE agents in a SINGLE message:**

1. `Task(subagent_type="Explore", model="haiku", prompt="Find similar features for [FEATURE]. Check components/admin/, lib/queries/, docs/patterns/. Report: file paths, patterns, recommendations.")`

2. `Task(subagent_type="Explore", model="haiku", prompt="Explore [CODEBASE AREA] for [FEATURE]. Find: main components, data flow, key files. Report structure.")`

3. `Task(subagent_type="Explore", model="haiku", prompt="Inspect database for [FEATURE]. Check: table schema, RLS policies, existing queries. Report findings.")`

#### If sequential mode (default):

**Spawn each agent ONE AT A TIME, waiting for each to complete:**

1. **First:** `Task(subagent_type="Explore", model="haiku", prompt="Find similar features for [FEATURE]. Check components/admin/, lib/queries/, docs/patterns/. Report: file paths, patterns, recommendations.")`

2. **After #1 completes:** `Task(subagent_type="Explore", model="haiku", prompt="Explore [CODEBASE AREA] for [FEATURE]. Find: main components, data flow, key files. Report structure.")`

3. **After #2 completes:** `Task(subagent_type="Explore", model="haiku", prompt="Inspect database for [FEATURE]. Check: table schema, RLS policies, existing queries. Report findings.")`

### Feature Branch Context Detection

Before creating the implementation plan, check if a custom base branch should be recommended:

1. **Check for feature branch references in issue body**:
   ```bash
   gh issue view <issue> --json body --jq '.body' | grep -iE "(feature/|branch from|based on|part of.*feature)"
   ```

2. **Check issue labels for feature context**:
   ```bash
   gh issue view <issue> --json labels --jq '.labels[].name' | grep -iE "(dashboard|feature-|epic-)"
   ```

3. **Check if project has defaultBase configured**:
   ```bash
   cat .sequant/settings.json 2>/dev/null | jq -r '.run.defaultBase // empty'
   ```

4. **If feature branch context detected**, include in plan output:
   ```markdown
   ## Feature Branch Context

   **Detected base branch**: `feature/dashboard`
   **Source**: Issue body mentions "Part of dashboard feature" / Project config / Label

   **Recommended workflow**:
   \`\`\`bash
   npx sequant run <issue> --base feature/dashboard
   \`\`\`
   ```

### In-Flight Work Analysis (Conflict Detection)

Before creating the implementation plan, scan for potential conflicts with in-flight work:

1. **List open worktrees**:
   ```bash
   git worktree list --porcelain
   ```

2. **For each worktree, get changed files** (use detected base branch or default to main):
   ```bash
   git -C <worktree-path> diff --name-only <base-branch>...HEAD
   ```

3. **Analyze this issue's likely file touches** based on:
   - Issue description and AC
   - Similar past issues
   - Codebase structure

4. **If overlap detected**, include in plan output:
   ```markdown
   ## Conflict Risk Analysis

   **In-flight work detected**: Issue #<N> (feature/<branch-name>)
   **Overlapping files**:
   - `<file-path>`

   **Recommended approach**:
   - [ ] Option A: Use alternative file/approach (no conflict)
   - [ ] Option B: Wait for #<N> to merge, then rebase
   - [ ] Option C: Coordinate unified implementation via /merger

   **Selected**: [To be decided during spec review]
   ```

5. **Check for explicit dependencies**:
   ```bash
   # Look for "Depends on" or "depends-on" labels
   gh issue view <issue> --json body,labels
   ```

   If dependencies found:
   ```markdown
   ## Dependencies

   **Depends on**: #<N>
   **Reason**: [Why this issue depends on the other]
   **Status**: [Open/Merged/Closed]
   ```

### Using MCP Tools (Optional)

- **Sequential Thinking:** For complex analysis with multiple dependencies
- **Context7:** For understanding existing patterns and architecture

## Context Gathering Strategy

1. **Check the Patterns Catalog first**
   - Read `docs/patterns/README.md` for quick lookup
   - Check HELPERS.md, COMPONENTS.md, TYPES.md
   - **Do NOT propose creating new utilities if similar ones exist**

2. **Look for similar features**
   - Use `ls components/admin/[area]/` for existing components
   - Read 1-2 examples to understand patterns
   - Propose solutions matching established architecture

3. **Check existing dependencies**
   - Review `package.json` for libraries
   - Prefer existing dependencies over new ones
   - For "solved problem" domains, recommend established packages in the plan:
     | Domain | Recommended Packages |
     |--------|---------------------|
     | Date/time | `date-fns`, `dayjs` |
     | Validation | `zod`, `yup`, `valibot` |
     | HTTP with retry | `ky`, `got`, `axios` |
     | Form state | `react-hook-form` |
     | State management | `zustand`, `jotai` |

4. **For database-heavy features**
   - Verify table schemas against TypeScript types
   - Check proposed types match database columns

5. **For complex features (>5 AC items)**
   - Use Sequential Thinking to break down systematically
   - Document key decision points and trade-offs

## Output Structure

### 1. AC Checklist with Verification Criteria (REQUIRED)

**Every AC MUST have an explicit Verification Method.** Restate AC as a checklist with verification for each:

```markdown
### AC-1: [Description]

**Verification Method:** Unit Test | Integration Test | Manual Test | Browser Test

**Test Scenario:**
- Given: [Initial state]
- When: [Action taken]
- Then: [Expected outcome]

**Integration Points:**
- [External system or component]

**Assumptions to Validate:**
- [ ] [Assumption that must be true]
```

#### Verification Method Decision Framework

**REQUIRED:** Choose the most appropriate verification method for each AC:

| AC Type | Verification Method | When to Use |
|---------|---------------------|-------------|
| Pure logic/calculation | **Unit Test** | Functions with clear input/output, no side effects |
| API endpoint | **Integration Test** | HTTP handlers, database queries, external service calls |
| User workflow | **Browser Test** | Multi-step UI interactions, form submissions |
| Visual appearance | **Manual Test** | Styling, layout, animations (hard to automate) |
| CLI command | **Integration Test** | Script execution, file operations, stdout verification |
| Error handling | **Unit Test** + **Integration Test** | Both isolated behavior and realistic scenarios |
| Performance | **Manual Test** + **Integration Test** | Timing thresholds, load testing |

#### Verification Method Examples

**Good (specific and testable):**
```markdown
**AC-1:** User can submit the registration form
**Verification Method:** Browser Test
**Test Scenario:**
- Given: User on /register page
- When: Fill form fields, click Submit
- Then: Redirect to /dashboard, success toast appears
```

**Bad (vague, no clear verification):**
```markdown
**AC-1:** Registration should work properly
**Verification Method:** ??? (cannot determine)
```

#### Flags for Missing Verification Methods

If you cannot determine a verification method for an AC:

1. **Flag the AC as unclear:**
   ```markdown
   **AC-3:** System handles errors gracefully
   **Verification Method:** ⚠️ UNCLEAR - needs specific error scenarios
   **Suggested Refinement:** List specific error types and expected responses
   ```

2. **Include in Open Questions:**
   ```markdown
   ## Open Questions

   1. **AC-3 verification method unclear**
      - Question: What specific error scenarios should be tested?
      - Recommendation: Define 3-5 error types with expected behavior
      - Impact: Without this, QA cannot objectively validate
   ```

**Why this matters:** AC without verification methods:
- Cannot be objectively validated in `/qa`
- Lead to subjective "does it work?" assessments
- Cause rework when expectations don't match implementation

See [verification-criteria.md](references/verification-criteria.md) for detailed examples including the #452 hooks failure case.

### 2. Implementation Plan

Propose a concrete plan in 3–7 steps that:
- References specific codebase areas
- Respects existing architecture
- Groups related work into phases
- Identifies dependencies between steps

For each major decision:
- Present 2-3 options when relevant
- Recommend a default with rationale
- Note if decision should be deferred

**Open Questions Format:**
- Question: [Clear question]
- Recommendation: [Your suggested default]
- Impact: [What happens if we get this wrong]

See [parallel-groups.md](references/parallel-groups.md) for parallelization format.

### 3. Feature Quality Planning (REQUIRED)

**Purpose:** Systematically consider professional implementation requirements beyond the minimum AC. This prevents gaps that slip through exec and QA because they were never planned.

**Why this matters:** Spec currently plans the "minimum to satisfy AC" rather than "complete professional implementation." Gaps found in manual review are omissions from incomplete planning, not failures.

**Complexity Scaling:**
- **Simple issues** (`simple-fix`, `typo`, `docs-only` labels): Use abbreviated checklist (Completeness + one relevant section)
- **Standard issues**: Complete all applicable sections
- **Complex issues** (`complex`, `refactor`, `breaking` labels): Complete all sections with detailed items

```markdown
## Feature Quality Planning

### Completeness Check
- [ ] All AC items have corresponding implementation steps
- [ ] Integration points with existing features identified
- [ ] No partial implementations or TODOs planned
- [ ] State management considered (if applicable)
- [ ] Data flow is complete end-to-end

### Error Handling
- [ ] Invalid input scenarios identified
- [ ] API/external service failures handled
- [ ] Edge cases documented (empty, null, max values)
- [ ] Error messages are user-friendly
- [ ] Graceful degradation planned

### Code Quality
- [ ] Types fully defined (no `any` planned)
- [ ] Follows existing patterns in codebase
- [ ] Error boundaries where needed
- [ ] No magic strings/numbers
- [ ] Consistent naming conventions

### Test Coverage Plan
- [ ] Unit tests for business logic
- [ ] Integration tests for data flow
- [ ] Edge case tests identified
- [ ] Mocking strategy appropriate
- [ ] Critical paths have test coverage

### Best Practices
- [ ] Logging for debugging/observability
- [ ] Accessibility considerations (if UI)
- [ ] Performance implications considered
- [ ] Security reviewed (auth, validation, sanitization)
- [ ] Documentation updated (if behavior changes)

### Polish (UI features only)
- [ ] Loading states planned
- [ ] Error states have UI
- [ ] Empty states handled
- [ ] Responsive design considered
- [ ] Keyboard navigation works

### Derived ACs

Based on quality planning, identify additional ACs needed:

| Source | Derived AC | Priority |
|--------|-----------|----------|
| Error Handling | AC-N: Handle [specific error] with [specific response] | High/Medium/Low |
| Test Coverage | AC-N+1: Add tests for [specific scenario] | High/Medium/Low |
| Best Practices | AC-N+2: Add logging for [specific operation] | High/Medium/Low |

**Note:** Derived ACs are numbered sequentially after original ACs and follow the same format.
```

**Section Applicability:**

| Issue Type | Sections Required |
|------------|-------------------|
| Bug fix | Completeness, Error Handling, Test Coverage |
| New feature | All sections |
| Refactor | Completeness, Code Quality, Test Coverage |
| UI change | All sections including Polish |
| Backend/API | Completeness, Error Handling, Code Quality, Test Coverage, Best Practices |
| CLI/Script | Completeness, Error Handling, Test Coverage, Best Practices |
| Docs only | Completeness only |

**Example (API endpoint feature):**

```markdown
## Feature Quality Planning

### Completeness Check
- [x] All AC items have corresponding implementation steps
- [x] Integration points: Auth middleware, database queries, response serializer
- [x] No partial implementations planned
- [ ] State management: N/A (stateless API)
- [x] Data flow: Request → Validate → Query → Transform → Response

### Error Handling
- [x] Invalid input: Return 400 with validation errors
- [x] Auth failure: Return 401 with "Unauthorized" message
- [x] Not found: Return 404 with resource ID
- [x] Server error: Return 500, log full error, return generic message
- [x] Rate limit: Return 429 with retry-after header

### Code Quality
- [x] Types: Define RequestDTO, ResponseDTO, ErrorResponse
- [x] Patterns: Follow existing controller pattern in `src/api/`
- [ ] Error boundaries: N/A (API, not UI)
- [x] No magic strings: Use constants for error messages

### Test Coverage Plan
- [x] Unit: Validation logic, data transformation
- [x] Integration: Full request/response cycle
- [x] Edge cases: Empty results, max pagination, invalid IDs
- [x] Mocking: Mock database, not HTTP layer

### Best Practices
- [x] Logging: Log request ID, duration, status code
- [ ] Accessibility: N/A (API)
- [x] Performance: Add database index for query field
- [x] Security: Validate input, sanitize output, check auth

### Derived ACs

| Source | Derived AC | Priority |
|--------|-----------|----------|
| Error Handling | AC-6: Return 429 with retry-after header on rate limit | Medium |
| Best Practices | AC-7: Log request ID and duration for observability | High |
| Test Coverage | AC-8: Add integration test for auth failure path | High |
```

### 4. Plan Review

Ask the user to confirm or adjust:
- The AC checklist (with verification criteria)
- The implementation plan
- The assumptions to validate

**Do NOT start implementation** - this is planning-only.

### 5. Recommended Workflow

Analyze the issue and recommend the optimal workflow phases:

```markdown
## Recommended Workflow

**Phases:** spec → exec → qa
**Quality Loop:** disabled
**Reasoning:** [Brief explanation of why these phases were chosen]
```

**Phase Selection Logic:**
- **UI/Frontend changes** → Add `test` phase (browser testing)
- **Bug fixes** → Skip `spec` if already well-defined
- **Complex refactors** → Enable quality loop
- **Security-sensitive** → Add `security-review` phase
- **Documentation only** → Skip `spec`, just `exec → qa`
- **New features with testable ACs** → Add `testgen` phase after spec
- **Refactors needing regression tests** → Add `testgen` phase

#### Testgen Phase Auto-Detection

**When to recommend `testgen` phase:**

| Condition | Recommend testgen? | Reasoning |
|-----------|-------------------|-----------|
| ACs have "Unit Test" verification method | ✅ Yes | Tests should be stubbed before implementation |
| ACs have "Integration Test" verification method | ✅ Yes | Complex integration tests benefit from early structure |
| Issue is a new feature (not bug fix) with >2 AC items | ✅ Yes | Features need test coverage |
| Issue has `enhancement` or `feature` label | ✅ Yes | New functionality needs tests |
| Project has test framework (Jest, Vitest, etc.) | ✅ Yes | Infrastructure exists to run tests |
| Issue is a simple bug fix (`bug` label only) | ❌ No | Bug fixes typically have targeted tests |
| Issue is docs-only (`docs` label) | ❌ No | Documentation doesn't need unit tests |
| All ACs have "Manual Test" or "Browser Test" verification | ❌ No | These don't generate code stubs |

**Detection Logic:**

1. **Check verification methods in AC items:**
   - Count ACs with "Unit Test" → If >0, recommend testgen
   - Count ACs with "Integration Test" → If >0, recommend testgen

2. **Check issue labels:**
   ```bash
   gh issue view <issue> --json labels --jq '.labels[].name'
   ```
   - If `bug` or `fix` is the ONLY label → Skip testgen
   - If `docs` is present → Skip testgen
   - If `enhancement`, `feature`, `refactor` → Consider testgen

3. **Check project test infrastructure:**
   ```bash
   # Check for test framework in package.json
   grep -E "jest|vitest|mocha" package.json
   ```
   - If no test framework detected → Skip testgen (no infrastructure)

**Example output when testgen is recommended:**

```markdown
## Recommended Workflow

**Phases:** spec → testgen → exec → qa
**Quality Loop:** disabled
**Reasoning:** ACs include Unit Test verification methods; testgen will create stubs before implementation
```

**Example output when testgen is NOT recommended:**

```markdown
## Recommended Workflow

**Phases:** spec → exec → qa
**Quality Loop:** disabled
**Reasoning:** Bug fix with targeted scope; existing tests sufficient
```

### 6. Label Review

Analyze current labels vs implementation plan and suggest updates:

```markdown
## Label Review

**Current:** enhancement
**Recommended:** enhancement, refactor
**Reason:** Implementation plan involves structural changes to 5+ files
**Quality Loop:** Will auto-enable due to `refactor` label

→ `gh issue edit <N> --add-label refactor`
```

**Plan-Based Detection Logic:**
- If plan has 5+ file changes → suggest `refactor`
- If plan touches UI components → suggest `ui` or `frontend`
- If plan has breaking API changes → suggest `breaking`
- If plan involves database migrations → suggest `backend`, `complex`
- If plan involves CLI/scripts → suggest `cli`
- If plan is documentation-only → suggest `docs`
- If recommended workflow includes quality loop → ensure matching label exists (`complex`, `refactor`, or `breaking`)

**Label Inference from Plan Analysis:**
- Count files in implementation plan steps
- Identify component types being modified
- Check if API contracts are changing
- Match against quality loop trigger labels

### 7. Issue Comment Draft

Generate a Markdown snippet with:
- AC checklist with verification criteria
- Verification methods summary
- Consolidated assumptions checklist
- Implementation plan with phases
- Key decisions and rationale
- Open questions with recommendations
- Effort breakdown

Label clearly as:
```md
--- DRAFT GITHUB ISSUE COMMENT (PLAN) ---
```

### 8. Update GitHub Issue

Post the draft comment to GitHub:
```bash
gh issue comment <issue-number> --body "..."
gh issue edit <issue-number> --add-label "planned"
```

---

## State Tracking

**IMPORTANT:** Update workflow state when running standalone (not orchestrated).

### Check Orchestration Mode

At the start of the skill, check if running orchestrated:
```bash
# Check if orchestrated - if so, skip state updates
if [[ -n "$SEQUANT_ORCHESTRATOR" ]]; then
  echo "Running orchestrated - state managed by orchestrator"
fi
```

### State Updates (Standalone Only)

When NOT orchestrated (`SEQUANT_ORCHESTRATOR` is not set):

**At skill start:**
```bash
npx tsx scripts/state/update.ts start <issue-number> spec
```

**On successful completion:**
```bash
npx tsx scripts/state/update.ts complete <issue-number> spec
```

**On failure:**
```bash
npx tsx scripts/state/update.ts fail <issue-number> spec "Error description"
```

**Why this matters:** State tracking enables dashboard visibility, resume capability, and workflow orchestration. Skills update state when standalone; orchestrators handle state when running workflows.

---

## Output Verification

**Before responding, verify your output includes ALL of these:**

- [ ] **AC Quality Check** - Lint results (or "Skipped" if --skip-ac-lint)
- [ ] **Scope Assessment** - Verdict and metrics (or "Skipped" if --skip-scope-check)
- [ ] **Non-Goals Section** - Listed or warning if missing
- [ ] **AC Checklist** - Numbered AC items (AC-1, AC-2, etc.) with descriptions
- [ ] **Verification Criteria (REQUIRED)** - Each AC MUST have:
  - Explicit Verification Method (Unit Test, Integration Test, Browser Test, or Manual Test)
  - Test Scenario with Given/When/Then format
  - If unclear, flag as "⚠️ UNCLEAR" and add to Open Questions
- [ ] **Conflict Risk Analysis** - Check for in-flight work, include if conflicts found
- [ ] **Implementation Plan** - 3-7 concrete steps with codebase references
- [ ] **Feature Quality Planning** - Quality dimensions checklist completed (abbreviated for simple-fix/typo/docs-only labels)
- [ ] **Recommended Workflow** - Phases, Quality Loop setting, and Reasoning (auto-enable quality loop if scope is yellow/red)
- [ ] **Label Review** - Current vs recommended labels based on plan analysis
- [ ] **Open Questions** - Any ambiguities with recommended defaults (including unclear verification methods)
- [ ] **Issue Comment Draft** - Formatted for GitHub posting

**CRITICAL:** Do NOT output AC items without verification methods. Either:
1. Assign a verification method from the decision framework, or
2. Flag as "⚠️ UNCLEAR" and include in Open Questions

**DO NOT respond until all items are verified.**

## Output Template

You MUST include these sections in order:

```markdown
## AC Quality Check

[Output from AC linter, or "Skipped (--skip-ac-lint flag set)"]

---

## Scope Assessment

### Non-Goals (Required)

[List non-goals from issue, or warning if missing]

### Scope Metrics

| Metric | Value | Status |
|--------|-------|--------|
| Feature count | [N] | [✅/⚠️/❌] |
| AC items | [N] | [✅/⚠️/❌] |
| Directory spread | [N] | [✅/⚠️/❌] |

### Scope Verdict

[✅/⚠️/❌] **[SCOPE_OK/SCOPE_WARNING/SCOPE_SPLIT_RECOMMENDED]** - [Recommendation]

---

## Acceptance Criteria

### AC-1: [Description]

**Verification Method:** [Unit Test | Integration Test | Browser Test | Manual Test]

**Test Scenario:**
- Given: [Initial state]
- When: [Action]
- Then: [Expected outcome]

### AC-2: [Description]

**Verification Method:** [Choose from decision framework]

**Test Scenario:**
- Given: [Initial state]
- When: [Action]
- Then: [Expected outcome]

### AC-N: [Unclear AC example]

**Verification Method:** ⚠️ UNCLEAR - [reason why verification is unclear]

**Suggested Refinement:** [How to make this AC testable]

<!-- Continue for all AC items -->

---

## Implementation Plan

### Phase 1: [Phase Name]
1. [Step with specific file/component references]
2. [Step]

### Phase 2: [Phase Name]
<!-- Continue for all phases -->

---

## Feature Quality Planning

### Completeness Check
- [ ] All AC items have corresponding implementation steps
- [ ] Integration points identified
- [ ] No partial implementations planned

### Error Handling
- [ ] Invalid input scenarios identified
- [ ] External service failures handled
- [ ] Edge cases documented

### Code Quality
- [ ] Types fully defined (no `any`)
- [ ] Follows existing patterns
- [ ] No magic strings/numbers

### Test Coverage Plan
- [ ] Unit tests for business logic
- [ ] Edge case tests identified
- [ ] Critical paths covered

### Best Practices
- [ ] Logging for observability
- [ ] Security reviewed
- [ ] Documentation updated

### Polish (UI only)
- [ ] Loading/error/empty states
- [ ] Responsive design

### Derived ACs
| Source | Derived AC | Priority |
|--------|-----------|----------|
| [Section] | AC-N: [Description] | High/Medium/Low |

---

## Open Questions

1. **[Question]**
   - Recommendation: [Default choice]
   - Impact: [What happens if wrong]

---

## Recommended Workflow

**Phases:** exec → qa
**Quality Loop:** disabled
**Reasoning:** [Why these phases based on issue analysis]

---

## Label Review

**Current:** [current labels]
**Recommended:** [recommended labels]
**Reason:** [Why these labels based on plan analysis]
**Quality Loop:** [Will/Won't auto-enable and why]

→ `gh issue edit <N> --add-label [label]`

---

--- DRAFT GITHUB ISSUE COMMENT (PLAN) ---

[Complete formatted comment for GitHub]
```
