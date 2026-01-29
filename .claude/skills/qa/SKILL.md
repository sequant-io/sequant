---
name: qa
description: "Code review + QA vs Acceptance Criteria, including A+ status suggestions and review comment draft."
license: MIT
metadata:
  author: sequant
  version: "1.0"
allowed-tools:
  - Bash(npm test:*)
  - Bash(npm run build:*)
  - Bash(git diff:*)
  - Bash(git status:*)
  - Bash(gh issue view:*)
  - Bash(gh issue comment:*)
  - Bash(gh issue edit:*)
  - Bash(gh pr view:*)
  - Bash(gh pr diff:*)
  - Bash(gh pr comment:*)
  - Bash(semgrep:*)
  - Bash(npx semgrep:*)
  - Bash(npx tsx scripts/semgrep-scan.ts:*)
  - Task
  - AgentOutputTool
---

# QA & Code Review

You are the Phase 3 "QA & Code Review Agent" for the current repository.

## Purpose

When invoked as `/qa`, your job is to:

1. Review the current state of the implementation for a single issue.
2. Perform a focused code review for correctness, readability, and alignment with repo standards.
3. Validate behavior against the Acceptance Criteria (AC).
4. Assess whether the change is "A+ status" or needs more work.
5. Draft a GitHub review/QA comment summarizing findings and recommendations.

## Orchestration Context

When running as part of an orchestrated workflow (e.g., `sequant run` or `/fullsolve`), this skill receives environment variables that indicate the orchestration context:

| Environment Variable | Description | Example Value |
|---------------------|-------------|---------------|
| `SEQUANT_ORCHESTRATOR` | The orchestrator invoking this skill | `sequant-run` |
| `SEQUANT_PHASE` | Current phase in the workflow | `qa` |
| `SEQUANT_ISSUE` | Issue number being processed | `123` |
| `SEQUANT_WORKTREE` | Path to the feature worktree | `/path/to/worktrees/feature/...` |

**Behavior when orchestrated (SEQUANT_ORCHESTRATOR is set):**

1. **Skip pre-flight sync check** - Orchestrator has already synced
2. **Use provided worktree** - Work in `SEQUANT_WORKTREE` path directly
3. **Skip issue fetch** - Use `SEQUANT_ISSUE`, orchestrator has context
4. **Reduce GitHub comment frequency** - Defer updates to orchestrator
5. **Trust git state** - Orchestrator verified branch status

**Behavior when standalone (SEQUANT_ORCHESTRATOR is NOT set):**

- Perform pre-flight sync check
- Locate worktree or work from main
- Fetch fresh issue context from GitHub
- Post QA comment directly to GitHub

## Behavior

Invocation:

- `/qa 123`: Treat `123` as the GitHub issue/PR identifier in context.
- `/qa <freeform description>`: Treat the text as context about the change to review.
- `/qa 123 --parallel`: Force parallel agent execution (faster, higher token usage).
- `/qa 123 --sequential`: Force sequential agent execution (slower, lower token usage).

### Agent Execution Mode

Before spawning quality check agents, determine the execution mode:

1. **Check for CLI flag override:**
   - `--parallel` → Use parallel execution
   - `--sequential` → Use sequential execution

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

### Pre-flight Sync Check

**Skip this section if `SEQUANT_ORCHESTRATOR` is set** - the orchestrator has already verified sync status.

Before starting QA (standalone mode), verify the local branch is in sync with remote:

```bash
git fetch origin 2>/dev/null || echo "Network unavailable - proceeding with local state"
git status -sb | head -1  # Shows ahead/behind status
```

**Status interpretation:**
- `[ahead N]` - Local has commits not on remote (OK to proceed)
- `[behind N]` - Remote has commits not pulled locally (recommend sync first)
- `[ahead N, behind M]` - Branches diverged (recommend sync before QA)

If diverged, recommend:
```bash
git pull origin main  # Or merge origin/main if pull fails
```

### Feature Worktree Workflow

**QA Phase:** Review code in the feature worktree.

**If orchestrated (SEQUANT_WORKTREE is set):**
- Use the provided worktree path directly: `cd $SEQUANT_WORKTREE`
- Skip step 1 below (worktree location provided by orchestrator)

**If standalone:**

1. **Locate the worktree:**
   - The worktree should already exist from the execution phase (`/exec`)
   - Find the worktree: `git worktree list` or check `../worktrees/feature/` for directories matching the issue number
   - The worktree path will be: `../worktrees/feature/<issue-number>-<issue-title-slug>/`

2. **Check implementation status:**
   - Navigate to worktree: `cd <worktree-path>`
   - Check for uncommitted changes: `git status`
   - Check for committed changes: `git log --oneline main..HEAD`

   **Status interpretation:**
   - **No commits AND no uncommitted changes:** Implementation may not be started
   - **Uncommitted changes exist:** Implementation done but not committed
   - **Commits exist:** Implementation committed and ready for review

3. **Review in the worktree:**
   - Navigate to the worktree directory to review the implementation
   - Use `git diff main...HEAD` to see all changes made in the feature branch
   - Run `npm test` and `npm run build` in the worktree to verify everything works
   - Review the code changes against the AC checklist

4. **Pre-merge cleanup check:**
   - Check for untracked files in main that match PR files: `git status --short`
   - If found, compare versions and remove older local copies

**Important:** Review the actual implementation in the worktree, not the main branch.

### No Worktree Found

If no feature worktree exists (work was done directly on main):

1. **Identify relevant commits:**
   ```bash
   git log --oneline -10
   ```

2. **Find the base commit** (before the implementation started):
   ```bash
   # Look for the last commit before the feature work
   git log --oneline --before="<date>" -1
   ```

3. **Review changes from base:**
   ```bash
   git diff <base-commit>...HEAD --name-only
   git diff <base-commit>...HEAD
   ```

4. **Run quality checks** on the current branch instead of comparing to a worktree.

### Phase 0: Implementation Status Check — REQUIRED

**Before spawning quality check agents**, verify that implementation actually exists. Running full QA on an unimplemented issue wastes tokens and produces confusing output.

**Detection Logic:**

```bash
# 1. Check for worktree (indicates work may have started)
worktree_path=$(git worktree list | grep -i "<issue-number>" | awk '{print $1}' | head -1)

# 2. Check for commits on feature branch (vs main)
commits_exist=$(git log --oneline main..HEAD 2>/dev/null | head -1)

# 3. Check for uncommitted changes
uncommitted_changes=$(git status --porcelain | head -1)

# 4. Check for open PR linked to this issue
pr_exists=$(gh pr list --search "<issue-number>" --state open --json number -q '.[0].number' 2>/dev/null)
```

**Implementation Status Matrix:**

| Worktree | Commits | Uncommitted | PR | Status | Action |
|----------|---------|-------------|-----|--------|--------|
| ❌ | ❌ | ❌ | ❌ | No implementation | Early exit |
| ✅ | ❌ | ❌ | ❌ | Worktree created but no work | Early exit |
| ✅ | ❌ | ✅ | ❌ | Work in progress (uncommitted) | Proceed with QA |
| ✅ | ✅ | * | * | Implementation exists | Proceed with QA |
| * | ✅ | * | * | Commits exist | Proceed with QA |
| * | * | * | ✅ | PR exists | Proceed with QA |

**Early Exit Condition:**
- No commits on feature branch AND no uncommitted changes AND no open PR

**If early exit triggered:**
1. **Skip** sub-agent spawning (nothing to check)
2. **Skip** code review (no code to review)
3. **Skip** quality metrics collection
4. Use the **Early Exit Output Template** below
5. Verdict: `AC_NOT_MET`

---

### Early Exit Output Template

When no implementation is detected, use this streamlined output:

```markdown
## QA Review for Issue #<N>

### Implementation Status: NOT FOUND

No implementation detected for this issue:
- Commits on feature branch: None
- Uncommitted changes: None
- Open PR: None

**Verdict: AC_NOT_MET**

No code changes found to review. The acceptance criteria cannot be evaluated without an implementation.

### Next Steps

1. Run `/exec <issue-number>` to implement the feature
2. Re-run `/qa <issue-number>` after implementation is complete

---

*QA skipped: No implementation to review*
```

**Important:** Do NOT spawn sub-agents when using early exit. This saves tokens and avoids confusing "no changes found" outputs from quality checkers.

---

### Quality Checks (Multi-Agent) — REQUIRED

**You MUST spawn sub-agents for quality checks.** Do NOT run these checks inline with bash commands. Sub-agents provide parallel execution, better context isolation, and consistent reporting.

**Execution mode:** Respect the agent execution mode determined above (see "Agent Execution Mode" section).

#### If parallel mode enabled:

**Spawn ALL THREE agents in a SINGLE message (one Tool call per agent, all in same response):**

1. `Task(subagent_type="general-purpose", model="haiku", prompt="Run type safety and deleted tests checks on the current branch vs main. Report: type issues count, deleted tests, verdict.")`

2. `Task(subagent_type="general-purpose", model="haiku", prompt="Run scope and size checks on the current branch vs main. Report: files count, diff size, size assessment.")`

3. `Task(subagent_type="general-purpose", model="haiku", prompt="Run security scan on changed files in current branch vs main. Report: critical/warning/info counts, verdict.")`

#### If sequential mode (default):

**Spawn each agent ONE AT A TIME, waiting for each to complete before the next:**

1. **First:** `Task(subagent_type="general-purpose", model="haiku", prompt="Run type safety and deleted tests checks on the current branch vs main. Report: type issues count, deleted tests, verdict.")`

2. **After #1 completes:** `Task(subagent_type="general-purpose", model="haiku", prompt="Run scope and size checks on the current branch vs main. Report: files count, diff size, size assessment.")`

3. **After #2 completes:** `Task(subagent_type="general-purpose", model="haiku", prompt="Run security scan on changed files in current branch vs main. Report: critical/warning/info counts, verdict.")`

**Add RLS check if admin files modified:**
```bash
admin_modified=$(git diff main...HEAD --name-only | grep -E "^app/admin/" | head -1)
```

See [quality-gates.md](references/quality-gates.md) for detailed verdict synthesis.

### Using MCP Tools (Optional)

- **Sequential Thinking:** For complex multi-step analysis
- **Context7:** For broader pattern context and library documentation

### 1. Context and AC Alignment

- **Read all GitHub issue comments** for complete context
- Reconstruct the AC checklist (AC-1, AC-2, ...)
- If AC unclear, state assumptions explicitly

### 2. Code Review

Perform a code review focusing on:

- Correctness and potential bugs
- Readability and maintainability
- Alignment with existing patterns (see CLAUDE.md)
- TypeScript strictness and type safety
- **Duplicate utility check:** Verify new utilities don't duplicate existing ones in `docs/patterns/`

See [code-review-checklist.md](references/code-review-checklist.md) for integration verification steps.

### 2a. Test Coverage Transparency (REQUIRED)

**Purpose:** Report which changed files have corresponding tests, not just "N tests passed."

**After running `npm test`, you MUST analyze test coverage for changed files:**

```bash
# Get changed source files (excluding tests)
changed=$(git diff main...HEAD --name-only | grep -E '\.(ts|tsx|js|jsx)$' | grep -v -E '\.test\.|\.spec\.|__tests__')

# Check for corresponding test files
for file in $changed; do
  base=$(basename "$file" .ts | sed 's/\.tsx$//')
  # Look for test files in __tests__/ or co-located
  if ! find . -name "${base}.test.*" -o -name "${base}.spec.*" 2>/dev/null | grep -q .; then
    echo "NO TEST: $file"
  fi
done
```

**Required reporting format:**

| Scenario | Report |
|----------|--------|
| Tests cover changed files | `Tests: N passed (covers changed files)` |
| Tests don't cover changed files | `Tests: N passed (⚠️ 0 cover changed files)` |
| No tests for specific files | `Tests: N passed (⚠️ NO TESTS: file1.ts, file2.ts)` |

**Include in output template:**

```markdown
### Test Coverage Analysis

| Changed File | Has Tests? | Test File |
|--------------|------------|-----------|
| `lib/foo.ts` | ✅ Yes | `__tests__/foo.test.ts` |
| `lib/bar.ts` | ⚠️ No | - |

**Coverage:** X/Y changed files have tests
```

### 2b. Change Tier Classification

**Purpose:** Flag coverage gaps based on criticality, not just presence/absence.

**Tier definitions:**

| Tier | Change Type | Coverage Requirement |
|------|-------------|---------------------|
| **Critical** | Auth, payments, security, server-actions, middleware, admin | Flag prominently if missing |
| **Standard** | Business logic, API handlers, utilities | Note if missing |
| **Optional** | Config, types-only, UI tweaks | No flag needed |

**Detection heuristic:**

```bash
# Detect critical paths in changed files
changed=$(git diff main...HEAD --name-only | grep -E '\.(ts|tsx|js|jsx)$')
critical=$(echo "$changed" | grep -E 'auth|payment|security|server-action|middleware|admin' || true)

if [[ -n "$critical" ]]; then
  echo "⚠️ CRITICAL PATH CHANGES (test coverage strongly recommended):"
  echo "$critical"
fi
```

**Reporting format:**

```markdown
### Change Tiers

| Tier | Files | Coverage Status |
|------|-------|-----------------|
| Critical | `auth/login.ts` | ⚠️ NO TESTS - Flag prominently |
| Standard | `lib/utils.ts` | Note: No tests |
| Optional | `types/index.ts` | OK - Types only |
```

### 2c. Test Quality Review

**When to apply:** Test files were added or modified.

Evaluate test quality using the checklist:
- **Behavior vs Implementation:** Tests assert on outputs, not internals
- **Coverage Depth:** Error paths and edge cases covered
- **Mock Hygiene:** Only external dependencies mocked
- **Test Reliability:** No timing dependencies, deterministic

See [test-quality-checklist.md](references/test-quality-checklist.md) for detailed evaluation criteria.

**Flag common issues:**
- Over-mocking (4+ modules mocked in single test)
- Missing error path tests
- Snapshot abuse (>50 line snapshots)
- Implementation mirroring

### 2b. Anti-Pattern Detection

**Always run** code pattern checks on changed files:

```bash
# Get changed TypeScript/JavaScript files
changed_files=$(git diff main...HEAD --name-only | grep -E '\.(ts|tsx|js|jsx)$')
```

**Check for:**

| Category | Pattern | Risk |
|----------|---------|------|
| Performance | N+1 query (`await` in loop) | ⚠️ Medium |
| Error Handling | Empty catch block | ⚠️ Medium |
| Security | Hardcoded secrets | ❌ High |
| Security | SQL concatenation | ❌ High |
| Memory | Uncleared interval/timeout | ⚠️ Medium |
| A11y | Image without alt | ⚠️ Low |

**Dependency audit** (when `package.json` modified):

| Flag | Threshold |
|------|-----------|
| Low downloads | <1,000/week |
| Stale | No updates 12+ months |
| License risk | UNLICENSED, GPL in MIT |
| Security | Known vulnerabilities |

See [anti-pattern-detection.md](references/anti-pattern-detection.md) for detection commands and full criteria.

### 3. QA vs AC

For each AC item, mark as:
- `MET`
- `PARTIALLY_MET`
- `NOT_MET`

Provide a sentence or two explaining why.

### 3a. AC Status Persistence — REQUIRED

**After evaluating each AC item**, update the status in workflow state:

```bash
# Update AC status in state
npx tsx -e "
import { StateManager } from './src/lib/workflow/state-manager.js';

const issueNumber = <ISSUE_NUMBER>;
const manager = new StateManager();

// Update each AC item's status
// Repeat for each AC (AC-1, AC-2, etc.)
await manager.updateACStatus(issueNumber, 'AC-1', 'met', 'Verified: tests pass and feature works');
await manager.updateACStatus(issueNumber, 'AC-2', 'not_met', 'Missing error handling for edge case');

console.log('AC status updated for issue #' + issueNumber);
"
```

**Status mapping:**
- `MET` → `'met'`
- `PARTIALLY_MET` → `'not_met'` (with notes explaining what's missing)
- `NOT_MET` → `'not_met'`
- `BLOCKED` → `'blocked'` (external dependency issue)

**Why this matters:** Updating AC status in state enables:
- Dashboard shows real-time AC progress per issue
- Cross-skill tracking of which AC items need work
- Summary badges show "X/Y met" status

**If issue has no stored AC:**
- Log a warning: "Issue #N has no stored AC - run /spec to extract AC first"
- Continue with QA but note the gap

### 4. Failure Path & Edge Case Testing (REQUIRED)

Before any READY_FOR_MERGE verdict, complete the adversarial thinking checklist:

1. **"What would break this?"** - Identify and test at least 2 failure scenarios
2. **"What assumptions am I making?"** - List and validate key assumptions
3. **"What's the unhappy path?"** - Test invalid inputs, failed dependencies
4. **"Did I test the feature's PRIMARY PURPOSE?"** - If it handles errors, trigger an error

See [testing-requirements.md](references/testing-requirements.md) for edge case checklists.

### 5. Adversarial Self-Evaluation (REQUIRED)

**Before issuing your verdict**, you MUST complete this adversarial self-evaluation to catch issues that automated quality checks miss.

**Why this matters:** QA automation catches type issues, deleted tests, and scope creep - but misses:
- Features that don't actually work as expected
- Tests that pass but don't test the right things
- Edge cases only apparent when actually using the feature

**Answer these questions honestly:**
1. "Did the implementation actually work when I reviewed it, or am I assuming it works?"
2. "Do the tests actually test the feature's primary purpose, or just pass?"
3. "What's the most likely way this feature could break in production?"
4. "Am I giving a positive verdict because the code looks clean, or because I verified it works?"

**Include this section in your output:**

```markdown
### Self-Evaluation

- **Verified working:** [Yes/No - did you actually verify the feature works, or assume it does?]
- **Test efficacy:** [High/Medium/Low - do tests catch the feature breaking?]
- **Likely failure mode:** [What would most likely break this in production?]
- **Verdict confidence:** [High/Medium/Low - explain any uncertainty]
```

**If any answer reveals concerns:**
- Factor the concerns into your verdict
- If significant, change verdict to `AC_NOT_MET` or `AC_MET_BUT_NOT_A_PLUS`
- Document the concerns in the QA comment

**Do NOT skip this self-evaluation.** Honest reflection catches issues that code review cannot.

---

### 6. Execution Evidence (REQUIRED for scripts/CLI)

**When to apply:** `scripts/` or CLI files were modified.

**Detect change type:**
```bash
scripts_changed=$(git diff main...HEAD --name-only | grep -E "^scripts/" | wc -l | xargs)
cli_changed=$(git diff main...HEAD --name-only | grep -E "(cli|commands?)" | wc -l | xargs)
```

**If scripts/CLI changed, execute at least one smoke command:**

| Change Type | Required Command |
|-------------|------------------|
| `scripts/` | `npx tsx scripts/<file>.ts --help` |
| CLI commands | `npx sequant <cmd> --help` or `--dry-run` |
| Tests only | `npm test -- --grep "feature"` |
| Types/config only | Waiver with reason |

**Capture evidence:**
```bash
# Execute and capture
npx tsx scripts/example.ts --help 2>&1
echo "Exit code: $?"
```

**Evidence status:**
- **Complete:** All required commands executed successfully
- **Incomplete:** Some commands not run or failed
- **Waived:** Explicit reason documented (types-only, config-only)
- **Not Required:** No executable changes

**Verdict gating:**
- `READY_FOR_MERGE` requires evidence status: Complete, Waived, or Not Required
- `AC_MET_BUT_NOT_A_PLUS` if evidence is Incomplete

See [quality-gates.md](references/quality-gates.md) for detailed evidence requirements.

---

### 7. A+ Status Verdict

Provide an overall verdict:

- `READY_FOR_MERGE` — ALL ACs are `MET` and code quality is high ("A+")
- `AC_MET_BUT_NOT_A_PLUS` — ALL ACs are `MET`, but meaningful improvements recommended
- `NEEDS_VERIFICATION` — ALL ACs are `MET` or `PENDING`, at least one requires external verification
- `AC_NOT_MET` — One or more ACs are `NOT_MET` or `PARTIALLY_MET`

**Verdict Determination Algorithm (REQUIRED):**

```text
1. Count AC statuses:
   - met_count = ACs with status MET
   - partial_count = ACs with status PARTIALLY_MET
   - pending_count = ACs with status PENDING
   - not_met_count = ACs with status NOT_MET

2. Determine verdict (in order):
   - IF not_met_count > 0 OR partial_count > 0:
       → AC_NOT_MET (block merge)
   - ELSE IF pending_count > 0:
       → NEEDS_VERIFICATION (wait for verification)
   - ELSE IF improvement_suggestions.length > 0:
       → AC_MET_BUT_NOT_A_PLUS (can merge with notes)
   - ELSE:
       → READY_FOR_MERGE (A+ implementation)
```

**CRITICAL:** `PARTIALLY_MET` is NOT sufficient for merge. It MUST be treated as `NOT_MET` for verdict purposes.

See [quality-gates.md](references/quality-gates.md) for detailed verdict criteria.

---

## Automated Quality Checks (Reference)

**Note:** These commands are what the sub-agents execute internally. You do NOT run these directly — the sub-agents spawned above handle this. This section is reference documentation only.

```bash
# Type safety
type_issues=$(git diff main...HEAD | grep -E ":\s*any[,)]|as any" | wc -l | xargs)

# Deleted tests
deleted_tests=$(git diff main...HEAD --diff-filter=D --name-only | grep -E "\\.test\\.|\\spec\\." | wc -l | xargs)

# Scope check
files_changed=$(git diff main...HEAD --name-only | wc -l | xargs)

# Size check
additions=$(git diff main...HEAD --numstat | awk '{sum+=$1} END {print sum+0}')
deletions=$(git diff main...HEAD --numstat | awk '{sum+=$2} END {print sum+0}')

# Security scan
npx tsx scripts/lib/__tests__/run-security-scan.ts 2>/dev/null
```

See [scripts/quality-checks.sh](scripts/quality-checks.sh) for the complete automation script.

### 8. Draft Review/QA Comment

Produce a Markdown snippet for the PR/issue:
- Short summary of the change
- AC coverage status (bullet list)
- Key strengths and issues
- Clear, actionable next steps

### 9. Update GitHub Issue

**If orchestrated (SEQUANT_ORCHESTRATOR is set):**
- Skip posting GitHub comment (orchestrator handles aggregated summary)
- Include verdict and AC coverage in output for orchestrator to capture
- Let orchestrator update labels based on final workflow status

**If standalone:**

Post the draft comment to GitHub and update labels:

- `AC_NOT_MET`: add `needs-work` label
- `READY_FOR_MERGE`: add `ready-for-review` label
- `AC_MET_BUT_NOT_A_PLUS`: add `needs-improvement` label
- `NEEDS_VERIFICATION`: add `needs-verification` label

### 10. Documentation Reminder

If verdict is `READY_FOR_MERGE` or `AC_MET_BUT_NOT_A_PLUS`:

```md
**Documentation:** Before merging, run `/docs <issue>` to generate feature documentation.
```

### 11. Script/CLI Execution Verification

**REQUIRED for CLI/script features:** When `scripts/` files are modified, execution verification is required before `READY_FOR_MERGE`.

**Detection:**
```bash
scripts_changed=$(git diff main...HEAD --name-only | grep -E "^(scripts/|templates/scripts/)" | wc -l | xargs)
if [[ $scripts_changed -gt 0 ]]; then
  echo "Script changes detected. Run /verify before READY_FOR_MERGE"
fi
```

**Verification evidence:** Look for "Execution Verification" section in issue comments. This section is posted by the `/verify` skill and includes:
- Command executed
- Exit code and duration
- Output sample (truncated)
- Human confirmation of expected behavior

**If no verification evidence exists:**
1. Prompt: "Script changes detected but no execution verification found. Run `/verify <issue> --command \"<test command>\"` before READY_FOR_MERGE verdict."
2. Do NOT give `READY_FOR_MERGE` verdict until verification is complete
3. Verdict should be `AC_MET_BUT_NOT_A_PLUS` with note about missing verification

**Why this matters:**
- Code review + unit tests miss integration issues
- CLI features must be executed at least once to verify end-to-end behavior

**Example workflow:**
```bash
# QA detects scripts/ or templates/scripts/ changes
# -> Prompt: "Run /verify before READY_FOR_MERGE"

/verify 558 --command "npx tsx scripts/migrate.ts --dry-run"

# Human confirms output looks correct
# -> /verify posts evidence to issue

/qa 558  # Re-run, now sees verification, can give READY_FOR_MERGE
```

---

## State Tracking

**IMPORTANT:** Update workflow state when running standalone (not orchestrated).

### State Updates (Standalone Only)

When NOT orchestrated (`SEQUANT_ORCHESTRATOR` is not set):

**At skill start:**
```bash
npx tsx scripts/state/update.ts start <issue-number> qa
```

**On successful completion (READY_FOR_MERGE or AC_MET_BUT_NOT_A_PLUS):**
```bash
npx tsx scripts/state/update.ts complete <issue-number> qa
npx tsx scripts/state/update.ts status <issue-number> ready_for_merge
```

**On failure (AC_NOT_MET):**
```bash
npx tsx scripts/state/update.ts fail <issue-number> qa "AC not met"
```

**Why this matters:** State tracking enables dashboard visibility, resume capability, and workflow orchestration. Skills update state when standalone; orchestrators handle state when running workflows.

---

## Output Verification

**Before responding, verify your output includes ALL of these:**

### Standard QA (Implementation Exists)

- [ ] **Self-Evaluation Completed** - Adversarial self-evaluation section included in output
- [ ] **AC Coverage** - Each AC item marked as MET, PARTIALLY_MET, or NOT_MET
- [ ] **Verdict** - One of: READY_FOR_MERGE, AC_MET_BUT_NOT_A_PLUS, AC_NOT_MET
- [ ] **Quality Metrics** - Type issues, deleted tests, files changed, additions/deletions
- [ ] **Test Coverage Analysis** - Changed files with/without tests, critical paths flagged
- [ ] **Code Review Findings** - Strengths, issues, suggestions
- [ ] **Test Quality Review** - Included if test files modified (or marked N/A)
- [ ] **Anti-Pattern Detection** - Dependency audit (if package.json changed) + code patterns
- [ ] **Execution Evidence** - Included if scripts/CLI modified (or marked N/A)
- [ ] **Documentation Check** - README/docs updated if feature adds new functionality
- [ ] **Next Steps** - Clear, actionable recommendations

### Early Exit (No Implementation)

When early exit is triggered (no commits, no uncommitted changes, no PR):

- [ ] **Implementation Status** - Clearly states "NOT FOUND"
- [ ] **Verdict** - Must be `AC_NOT_MET`
- [ ] **Next Steps** - Directs user to run `/exec` first
- [ ] **Sub-agents NOT spawned** - Quality check agents were skipped

**DO NOT respond until all applicable items are verified.**

## Output Template

You MUST include these sections:

```markdown
## QA Review for Issue #<N>

### AC Coverage

| AC | Description | Status | Notes |
|----|-------------|--------|-------|
| AC-1 | [description] | MET/PARTIALLY_MET/NOT_MET | [explanation] |
| AC-2 | [description] | MET/PARTIALLY_MET/NOT_MET | [explanation] |

**Coverage:** X/Y AC items fully met

---

### Quality Metrics

| Metric | Value | Status |
|--------|-------|--------|
| Type issues (`any`) | X | OK/WARN |
| Deleted tests | X | OK/WARN |
| Files changed | X | OK/WARN |
| Lines added | +X | - |
| Lines deleted | -X | - |

---

### Test Coverage Analysis

| Changed File | Tier | Has Tests? | Test File |
|--------------|------|------------|-----------|
| `[file]` | Critical/Standard/Optional | ✅ Yes / ⚠️ No | `[test file or -]` |

**Coverage:** X/Y changed source files have corresponding tests
**Critical paths without tests:** [list or "None"]

---

### Code Review

**Strengths:**
- [Positive findings]

**Issues:**
- [Problems found]

**Suggestions:**
- [Improvements recommended]

---

### Test Quality Review

[Include if test files were added/modified, otherwise: "N/A - No test files modified"]

| Category | Status | Notes |
|----------|--------|-------|
| Behavior vs Implementation | ✅ OK / ⚠️ WARN | [notes] |
| Coverage Depth | ✅ OK / ⚠️ WARN | [notes] |
| Mock Hygiene | ✅ OK / ⚠️ WARN | [notes] |
| Test Reliability | ✅ OK / ⚠️ WARN | [notes] |

**Issues Found:**
- [file:line - description]

---

### Anti-Pattern Detection

#### Dependency Audit
[Include if package.json modified, otherwise: "N/A - No dependency changes"]

| Package | Downloads/wk | Last Update | Flags |
|---------|--------------|-------------|-------|
| [pkg] | [count] | [date] | [flags] |

#### Code Patterns

| File:Line | Category | Pattern | Suggestion |
|-----------|----------|---------|------------|
| [location] | [category] | [pattern] | [fix] |

**Critical Issues:** X
**Warnings:** Y

---

### Execution Evidence

[Include if scripts/CLI modified, otherwise: "N/A - No executable changes"]

| Test Type | Command | Exit Code | Result |
|-----------|---------|-----------|--------|
| Smoke test | `[command]` | [code] | [result] |

**Evidence status:** Complete / Incomplete / Waived (reason) / Not Required

---

### Self-Evaluation

- **Verified working:** [Yes/No - did you actually verify the feature works?]
- **Test efficacy:** [High/Medium/Low - do tests catch the feature breaking?]
- **Likely failure mode:** [What would most likely break this in production?]
- **Verdict confidence:** [High/Medium/Low - explain any uncertainty]

---

### Verdict: [READY_FOR_MERGE | AC_MET_BUT_NOT_A_PLUS | AC_NOT_MET]

[Explanation of verdict]

### Documentation

- [ ] README updated (if new feature/flag)
- [ ] docs/ updated (if behavior changed)
- [ ] CHANGELOG entry added (for user-facing changes)
- [ ] N/A - No documentation needed (bug fix, internal refactor)

### Next Steps

1. [Action item 1]
2. [Action item 2]
```
