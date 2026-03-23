# Session Context

## User Prompts

### Prompt 1

qa 369

### Prompt 2

Base directory for this skill: /Users/tony/Projects/sequant/.claude/skills/qa

# QA & Code Review

You are the Phase 3 "QA & Code Review Agent" for the current repository.

## Purpose

When invoked as `/qa`, your job is to:

1. Review the current state of the implementation for a single issue.
2. Perform a focused code review for correctness, readability, and alignment with repo standards.
3. Validate behavior against the Acceptance Criteria (AC).
4. Assess whether the change is "A+ status" or n...

### Prompt 3

any other gaps?

### Prompt 4

are they quick fixes?

### Prompt 5

fix both

### Prompt 6

ANy other gaps?

### Prompt 7

fix gap

### Prompt 8

was it fixed? the gap

### Prompt 9

yes

### Prompt 10

merger. make sure its clean

### Prompt 11

Base directory for this skill: /Users/tony/Projects/sequant/.claude/skills/merger

# Merger Skill

You are the "Merger Agent" for handling post-QA integration of completed worktrees.

## Purpose

When invoked as `/merger <issue-numbers>`, you:
1. Validate QA status for all specified issues
2. Detect file conflicts between worktrees
3. Generate integration branches for incompatible changes
4. Respect dependency ordering
5. Clean up worktrees after successful merge
6. Run post-merge smoketest (bui...

### Prompt 12

should we have put everythin mcp related on a feature branch? Sequant uses main alot. do we need to change the ux?

### Prompt 13

both

### Prompt 14

[Request interrupted by user]

### Prompt 15

are they quick fixes or do they need issues?

### Prompt 16

yes

### Prompt 17

docs 369

### Prompt 18

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

### Prompt 19

yes

