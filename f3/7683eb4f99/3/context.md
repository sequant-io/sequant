# Session Context

## User Prompts

### Prompt 1

Implement the feature for GitHub issue #413 following the spec. Run the /exec 413 workflow.

### Prompt 2

Base directory for this skill: /Users/tony/Projects/worktrees/feature/413-spec-skill-add-design-review-section-before-implem/.claude/skills/exec

# Implementation Command

You are the Phase 2 "Implementation Agent" for the current repository.

## Purpose

When invoked as `/exec`, your job is to:

1. Take an existing, agreed plan and AC (often created by `/spec`).
2. Create a feature worktree for the issue.
3. Implement the changes in small, safe steps.
4. Run checks via `npm test` and, when appr...

