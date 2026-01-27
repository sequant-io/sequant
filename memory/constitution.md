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

### Core Workflow
| Command | Purpose |
|---------|---------|
| `/fullsolve` | Complete issue resolution with integrated quality loops |
| `/spec` | Plan implementation against acceptance criteria |
| `/exec` | Implement a planned feature in worktree |
| `/qa` | Code review and quality verification |

### Supporting Commands
| Command | Purpose |
|---------|---------|
| `/solve` | Generate recommended workflow for GitHub issues |
| `/assess` | Issue triage and status assessment |
| `/test` | Browser-based UI testing (requires chrome-devtools MCP) |
| `/verify` | CLI/script execution verification |
| `/testgen` | Generate test stubs from spec criteria |
| `/loop` | Quality loop - iterate until tests pass |
| `/docs` | Generate feature documentation |

### Utility Commands
| Command | Purpose |
|---------|---------|
| `/setup` | Initialize Sequant in a project |
| `/clean` | Repository cleanup |
| `/improve` | Codebase analysis and improvement discovery |
| `/reflect` | Strategic reflection on workflow effectiveness |
| `/security-review` | Deep security analysis for sensitive features |

## Project-Specific Notes

<!--
Customize this section for your project:

- Tech stack (framework, language, database)
- Architecture patterns and conventions
- Important file locations
- Testing approach and tools
- Build and deployment notes
-->

