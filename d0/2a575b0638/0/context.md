# Session Context

## User Prompts

### Prompt 1

Project context (from AGENTS.md):

# AGENTS.md

## Project Overview

**sequant** is built with **Generic**.

## Development Commands

| Command | Purpose |
|---------|---------|
| `npm run build` | Build the project |
| `npm test` | Run tests |
| `npm run lint` | Lint the codebase |

## Code Conventions

- **testFilePattern**: *.test.ts
- **exportStyle**: named
- **asyncPattern**: async/await
- **typescriptStrict**: enabled
- **sourceStructure**: src/
- **packageManager**: npm
- **indentation**:...

### Prompt 2

Base directory for this skill: /Users/tony/Projects/worktrees/feature/421-mcp-server-add-progress-notifications-for-sequant-/.claude/skills/testgen

# Test Generation Command

You are the "Test Generation Agent" for the current repository.

## Purpose

When invoked as `/testgen <issue-number>`, your job is to:

1. Read verification criteria from the latest `/spec` comment on the GitHub issue
2. Parse each AC's verification method and test scenario
3. Generate appropriate test stubs based on veri...

