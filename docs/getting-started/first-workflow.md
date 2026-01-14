# Your First Workflow

Walk through solving a GitHub issue with Sequant.

## Overview

Sequant transforms GitHub issues into working code through sequential phases:

1. **Spec** — Plan the implementation
2. **Exec** — Build in an isolated worktree
3. **QA** — Review against acceptance criteria

## Step 1: Choose an Issue

Pick a GitHub issue from your repository. For your first workflow, choose something small like a bug fix or simple feature.

```bash
# List open issues
gh issue list

# View issue details
gh issue view 123
```

## Step 2: Plan with `/spec`

Open Claude Code in your project, then run:

```bash
/spec 123
```

This command:
- Reads the issue description and comments
- Analyzes the codebase
- Drafts an implementation plan with acceptance criteria
- Posts the plan as a GitHub issue comment for your review

**Review the plan** before proceeding. Comment on the issue if you want changes.

## Step 3: Implement with `/exec`

Once you're satisfied with the plan:

```bash
/exec 123
```

This command:
- Creates an isolated git worktree (`feature/123-issue-title`)
- Implements the changes according to the plan
- Runs tests (`npm test`)
- Creates commits with progress updates

## Step 4: Review with `/qa`

After implementation:

```bash
/qa 123
```

This command:
- Reviews code against acceptance criteria
- Checks for type safety issues
- Scans for security vulnerabilities
- Flags scope creep (changes outside the issue)
- Suggests fixes if issues are found

## Step 5: Merge

If QA passes, merge the feature branch:

```bash
# Create a pull request
gh pr create --fill

# Or merge directly (if your workflow allows)
git checkout main
git merge feature/123-issue-title
```

## One-Command Alternative

For simpler issues, use `/fullsolve` to run all phases:

```bash
/fullsolve 123
```

This runs spec → exec → qa with automatic fix iterations.

## Tips

### Start Small

Your first workflow should be a simple issue. Complex refactors can wait until you're familiar with the phases.

### Review the Spec

The `/spec` phase is your opportunity to shape the implementation. Review the plan carefully before `/exec`.

### Trust the Worktree

Sequant creates isolated worktrees so your main branch stays clean. If something goes wrong, you can safely delete the worktree.

### Iterate with Quality Loop

If QA finds issues:

```bash
/loop 123
```

This automatically fixes issues found during QA and re-runs checks.

## Next Steps

- [Workflow Phases](../concepts/workflow-phases.md) — Understand each phase in depth
- [Two Modes](../concepts/two-modes.md) — Interactive vs autonomous execution
- [Run Command](../run-command.md) — Batch execution for multiple issues
