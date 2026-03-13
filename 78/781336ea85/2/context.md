# Session Context

## User Prompts

### Prompt 1

fullsolve 233

### Prompt 2

Base directory for this skill: /Users/tony/Projects/sequant/.claude/skills/fullsolve

# Full Solve Command

You are the "Full Solve Agent" for the current repository.

## Purpose

When invoked as `/fullsolve <issue-number>`, execute the complete issue resolution workflow with integrated quality loops. This command orchestrates all phases and automatically iterates until quality gates pass.

## CRITICAL: Auto-Progression Between Phases

**DO NOT wait for user confirmation between phases.** This i...

### Prompt 3

Base directory for this skill: /Users/tony/Projects/sequant/.claude/skills/qa

# QA & Code Review

You are the Phase 3 "QA & Code Review Agent" for the current repository.

## Purpose

When invoked as `/qa`, your job is to:

1. Review the current state of the implementation for a single issue.
2. Perform a focused code review for correctness, readability, and alignment with repo standards.
3. Validate behavior against the Acceptance Criteria (AC).
4. Assess whether the change is "A+ status" or n...

### Prompt 4

yes

### Prompt 5

any gaps?

### Prompt 6

merge

### Prompt 7

docs

### Prompt 8

Base directory for this skill: /Users/tony/Projects/sequant/.claude/skills/docs

# Documentation Generator

You are the Phase 4 "Documentation Agent" for the current repository.

## Purpose

When invoked as `/docs`, your job is to:

1. Analyze the implemented feature (from PR diff or git diff).
2. Generate operational documentation (how to use, not how it works).
3. Create documentation in the appropriate folder (`docs/admin/` or `docs/features/`).
4. Post a summary comment to the GitHub issue.
...

### Prompt 9

yes

