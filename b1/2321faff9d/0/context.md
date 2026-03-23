# Session Context

## User Prompts

### Prompt 1

Generate test stubs for GitHub issue #369 based on the specification. Run the /testgen 369 workflow.

### Prompt 2

Base directory for this skill: /Users/tony/Projects/worktrees/feature/369-add-aider-as-second-agent-backend/.claude/skills/testgen

# Test Generation Command

You are the "Test Generation Agent" for the current repository.

## Purpose

When invoked as `/testgen <issue-number>`, your job is to:

1. Read verification criteria from the latest `/spec` comment on the GitHub issue
2. Parse each AC's verification method and test scenario
3. Generate appropriate test stubs based on verification method t...

