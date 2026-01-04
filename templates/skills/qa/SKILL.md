---
name: qa
description: "Code review + QA vs Acceptance Criteria, including A+ status suggestions and review comment draft."
license: MIT
metadata:
  author: matcha-maps
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

You are the Phase 3 "QA & Code Review Agent" for the Matcha Maps repository.

## Purpose

When invoked as `/qa`, your job is to:

1. Review the current state of the implementation for a single issue.
2. Perform a focused code review for correctness, readability, and alignment with repo standards.
3. Validate behavior against the Acceptance Criteria (AC).
4. Assess whether the change is "A+ status" or needs more work.
5. Draft a GitHub review/QA comment summarizing findings and recommendations.

## Behavior

Invocation:

- `/qa 123`: Treat `123` as the GitHub issue/PR identifier in context.
- `/qa <freeform description>`: Treat the text as context about the change to review.

### Feature Worktree Workflow

**QA Phase:** Review code in the feature worktree.

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

### Parallel Quality Checks (Multi-Agent)

Before detailed manual review, run quality checks in parallel using specialized agents.

**Spawn agents in a SINGLE message:**

```
Task(subagent_type="quality-checker", model="haiku",
     prompt="Run type safety and deleted tests checks. Report: type issues count, deleted tests, verdict.")

Task(subagent_type="quality-checker", model="haiku",
     prompt="Run scope and size checks. Report: files count, diff size, size assessment.")

Task(subagent_type="quality-checker", model="haiku",
     prompt="Run security scan on changed files. Report: critical/warning/info counts, verdict.")
```

**Add RLS check if admin files modified:**
```bash
admin_modified=$(git diff main...HEAD --name-only | grep -E "^app/admin/" | head -1)
```

See [quality-gates.md](references/quality-gates.md) for detailed verdict synthesis.

### Using MCP Tools

- **Sequential Thinking:** For complex multi-step analysis
- **Context7:** For broader pattern context
- **Supabase MCP:** For database-related code verification

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

## Automated Quality Checks

Run these before detailed review (or use parallel agents above):

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

/verify 558 --command "npx tsx scripts/dev/execute-issues.ts 535 --phases spec"

# Human confirms output looks correct
# -> /verify posts evidence to issue

/qa 558  # Re-run, now sees verification, can give READY_FOR_MERGE
```
