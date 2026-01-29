# {{PROJECT_NAME}} Constitution

This document defines the core principles and patterns for AI-assisted development in this project.

## Core Principles

1. **Quality First** - Never sacrifice code quality for speed
2. **Test Everything** - All features must have appropriate test coverage
3. **Document Decisions** - Important decisions should be captured in issue comments
4. **Incremental Progress** - Break large tasks into small, reviewable chunks
5. **Respect Existing Patterns** - Follow established project conventions

## Workflow Phases

### Phase 1: Planning (`/spec`)
- Understand requirements and acceptance criteria
- Identify potential risks and dependencies
- Draft implementation plan for approval

### Phase 2: Implementation (`/exec`)
- Work in feature worktree
- Follow established patterns
- Keep commits atomic and well-described

### Phase 3: Quality (`/qa`)
- Review against acceptance criteria
- Run all quality checks
- Address feedback before merge

## Code Standards

### Naming Conventions
- Use descriptive variable and function names
- Follow language-specific conventions (camelCase, snake_case, etc.)

### Error Handling
- Handle errors gracefully
- Log meaningful error messages
- Don't swallow exceptions silently

### Testing
- Write tests for new features
- Update tests when modifying existing code
- Test edge cases and error paths

## Commands Available

| Command | Purpose |
|---------|---------|
| `/spec` | Plan implementation for an issue |
| `/exec` | Implement a planned feature |
| `/test` | Run browser-based UI tests |
| `/qa` | Quality review before merge |
| `/loop` | Fix iteration when tests fail |
| `/docs` | Generate feature documentation |

## Stack-Specific Notes

{{STACK_NOTES}}

## Project-Specific Notes

<!-- Add your project-specific guidelines below -->

