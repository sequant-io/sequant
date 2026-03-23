# Session Context

## User Prompts

### Prompt 1

qa 370

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

any gaps?

### Prompt 4

fix all gaps

### Prompt 5

any other gaps?

### Prompt 6

are the best practice design choices. be honest

### Prompt 7

docs 370

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

merger

### Prompt 10

Base directory for this skill: /Users/tony/Projects/sequant/.claude/skills/merger

# Merger Skill

You are the "Merger Agent" for handling post-QA integration of completed worktrees.

## Purpose

When invoked as `/merger <issue-numbers>`, you:
1. Capture baseline metrics on main (build errors, test counts)
2. Validate QA status for all specified issues
3. Detect file conflicts between worktrees
4. Generate integration branches for incompatible changes
5. Respect dependency ordering
6. Clean up w...

### Prompt 11

git push origin feature/370-github-actions-integration-for-ci-cd-driven-workfl --force-with-lease
Enumerating objects: 61, done.
Counting objects: 100% (61/61), done.
Delta compression using up to 8 threads
Compressing objects: 100% (55/55), done.
Writing objects: 100% (55/55), 29.79 KiB | 7.45 MiB/s, done.
Total 55 (delta 24), reused 0 (delta 0), pack-reused 0 (from 0)
remote: Resolving deltas: 100% (24/24), completed with 5 local objects.
To https://github.com/sequant-io/sequant.git
 + a3b87ec...

### Prompt 12

Base directory for this skill: /Users/tony/Projects/sequant/.claude/skills/reflect

# Reflection Agent

You are the "Reflection Agent" for the current repository.

## Purpose

When invoked as `/reflect`, your job is to:

1. Analyze the recent work session for workflow effectiveness
2. Identify friction points, inefficiencies, or missing context
3. Propose targeted improvements to commands, docs, or processes
4. Balance documentation completeness with actionability (avoid bloat)

## Behavior

Whe...

### Prompt 13

action items completed?

### Prompt 14

commit push

