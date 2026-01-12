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

### Quality Checks (Multi-Agent) — REQUIRED

**You MUST spawn sub-agents for quality checks.** Do NOT run these checks inline with bash commands. Sub-agents provide parallel execution, better context isolation, and consistent reporting.

**Execution mode:** Respect the agent execution mode determined above (see "Agent Execution Mode" section).

#### If parallel mode enabled:

**Spawn ALL THREE agents in a SINGLE message (one Tool call per agent, all in same response):**

1. `Task(subagent_type="quality-checker", model="haiku", prompt="Run type safety and deleted tests checks on the current branch vs main. Report: type issues count, deleted tests, verdict.")`

2. `Task(subagent_type="quality-checker", model="haiku", prompt="Run scope and size checks on the current branch vs main. Report: files count, diff size, size assessment.")`

3. `Task(subagent_type="quality-checker", model="haiku", prompt="Run security scan on changed files in current branch vs main. Report: critical/warning/info counts, verdict.")`

#### If sequential mode (default):

**Spawn each agent ONE AT A TIME, waiting for each to complete before the next:**

1. **First:** `Task(subagent_type="quality-checker", model="haiku", prompt="Run type safety and deleted tests checks on the current branch vs main. Report: type issues count, deleted tests, verdict.")`

2. **After #1 completes:** `Task(subagent_type="quality-checker", model="haiku", prompt="Run scope and size checks on the current branch vs main. Report: files count, diff size, size assessment.")`

3. **After #2 completes:** `Task(subagent_type="quality-checker", model="haiku", prompt="Run security scan on changed files in current branch vs main. Report: critical/warning/info counts, verdict.")`

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

### 3. QA vs AC

For each AC item, mark as:
- `MET`
- `PARTIALLY_MET`
- `NOT_MET`

Provide a sentence or two explaining why.

### 4. Failure Path & Edge Case Testing (REQUIRED)

Before any READY_FOR_MERGE verdict, complete the adversarial thinking checklist:

1. **"What would break this?"** - Identify and test at least 2 failure scenarios
2. **"What assumptions am I making?"** - List and validate key assumptions
3. **"What's the unhappy path?"** - Test invalid inputs, failed dependencies
4. **"Did I test the feature's PRIMARY PURPOSE?"** - If it handles errors, trigger an error

See [testing-requirements.md](references/testing-requirements.md) for edge case checklists.

### 5. A+ Status Verdict

Provide an overall verdict:

- `READY_FOR_MERGE` — AC met and code quality is high ("A+")
- `AC_MET_BUT_NOT_A_PLUS` — AC met, but meaningful improvements recommended
- `AC_NOT_MET` — AC not fully met; additional implementation needed

See [quality-gates.md](references/quality-gates.md) for detailed verdict criteria.

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

### 6. Draft Review/QA Comment

Produce a Markdown snippet for the PR/issue:
- Short summary of the change
- AC coverage status (bullet list)
- Key strengths and issues
- Clear, actionable next steps

### 7. Update GitHub Issue

**If orchestrated (SEQUANT_ORCHESTRATOR is set):**
- Skip posting GitHub comment (orchestrator handles aggregated summary)
- Include verdict and AC coverage in output for orchestrator to capture
- Let orchestrator update labels based on final workflow status

**If standalone:**

Post the draft comment to GitHub and update labels:
- `AC_NOT_MET`: add `needs-work` label
- `READY_FOR_MERGE`: add `ready-for-review` label
- `AC_MET_BUT_NOT_A_PLUS`: add `needs-improvement` label

### 8. Documentation Reminder

If verdict is `READY_FOR_MERGE` or `AC_MET_BUT_NOT_A_PLUS`:

```md
**Documentation:** Before merging, run `/docs <issue>` to generate feature documentation.
```

### 9. Script/CLI Execution Verification

**REQUIRED for CLI/script features:** When `scripts/` files are modified, execution verification is required before `READY_FOR_MERGE`.

**Detection:**
```bash
scripts_changed=$(git diff main...HEAD --name-only | grep "^scripts/" | wc -l | xargs)
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
# QA detects scripts/ changes
# -> Prompt: "Run /verify before READY_FOR_MERGE"

/verify 558 --command "npx tsx scripts/migrate.ts --dry-run"

# Human confirms output looks correct
# -> /verify posts evidence to issue

/qa 558  # Re-run, now sees verification, can give READY_FOR_MERGE
```

---

## Output Verification

**Before responding, verify your output includes ALL of these:**

- [ ] **AC Coverage** - Each AC item marked as MET, PARTIALLY_MET, or NOT_MET
- [ ] **Verdict** - One of: READY_FOR_MERGE, AC_MET_BUT_NOT_A_PLUS, AC_NOT_MET
- [ ] **Quality Metrics** - Type issues, deleted tests, files changed, additions/deletions
- [ ] **Code Review Findings** - Strengths, issues, suggestions
- [ ] **Documentation Check** - README/docs updated if feature adds new functionality
- [ ] **Next Steps** - Clear, actionable recommendations

**DO NOT respond until all items are verified.**

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

### Code Review

**Strengths:**
- [Positive findings]

**Issues:**
- [Problems found]

**Suggestions:**
- [Improvements recommended]

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
