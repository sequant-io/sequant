# Quickstart

Get from zero to your first solved issue in 5 minutes.

## Prerequisites

- [Claude Code](https://claude.ai/code) installed
- [GitHub CLI](https://cli.github.com/) authenticated (`gh auth login`)
- A GitHub repository with at least one open issue

## Install Sequant

```bash
npx sequant init
npx sequant doctor  # Verify setup
```

## Solve Your First Issue

### The Fast Way

```
/fullsolve 123
```

This runs the complete pipeline: plan → implement → test → review → fix iterations.

### The Step-by-Step Way

```
/spec 123    # Plan implementation, draft ACs
/exec 123    # Build in isolated worktree
/qa 123      # Review against ACs
```

If QA finds issues, run `/loop 123` to auto-fix.

## After QA Passes

```
/docs 123              # Generate documentation (if needed)
gh pr merge --squash   # Merge the PR
```

## Batch Multiple Issues

```bash
npx sequant run 1 2 3         # Solve issues in parallel
npx sequant run 123 --quality-loop  # Auto-fix until QA passes
```

After batch completion, verify integration before merging:

```bash
npx sequant merge --check     # Detect conflicts, mirroring gaps, overlaps
/merger 1 2 3                 # Merge all issues
```

## Quick Reference

| Command | Purpose |
|---------|---------|
| `/fullsolve 123` | Complete pipeline in one command |
| `/spec 123` | Plan implementation |
| `/exec 123` | Implement in isolated worktree |
| `/qa 123` | Code review + quality gates |
| `/loop 123` | Auto-fix QA failures |
| `/docs 123` | Generate documentation |

## Next Steps

- [Complete Workflow Guide](./workflow.md) - Post-QA patterns, gap analysis, merge process
- [Workflow Phases](../concepts/workflow-phases.md) - Deep dive on each phase
- [Quality Gates](../concepts/quality-gates.md) - What QA checks for
