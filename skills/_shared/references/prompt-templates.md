# Sub-Agent Prompt Templates

Reference for task-specific prompt templates when spawning sub-agents via the `Task` tool during parallel execution.

## Overview

When spawning sub-agents for implementation tasks, use these templates to provide structured, task-specific guidance. Templates include:
- Task-specific requirements and constraints
- Best practices for that task type
- Expected deliverables and reporting format

## Template Selection

### Automatic Selection (Keywords)

The template is selected based on keywords in the task description:

| Keywords | Template |
|----------|----------|
| `component`, `Component`, `React` | [Component Template](#component-template) |
| `type`, `interface`, `types/` | [Type Definition Template](#type-definition-template) |
| `CLI`, `command`, `script`, `bin/` | [CLI/Script Template](#cliscript-template) |
| `test`, `spec`, `.test.` | [Test Template](#test-template) |
| `refactor`, `restructure`, `migrate` | [Refactor Template](#refactor-template) |
| (none matched) | [Generic Template](#generic-template) |

### Explicit Annotation Override

You can force a specific template using the `[template: X]` annotation at the start of the task:

```
[template: component] Create UserCard in components/admin/
[template: cli] Add export command to scripts/
[template: type] Define MetricEvent interface
```

**Annotation takes precedence** over keyword detection.

---

## Task Templates

### Component Template

**Use for:** React components, UI elements, admin panels

```markdown
## Task: Create React Component

**Component:** [name]
**Location:** [path]

**Requirements:**
- [ ] TypeScript with proper prop types (interface or type)
- [ ] Follow existing component patterns in the codebase
- [ ] Include displayName for debugging: `Component.displayName = 'ComponentName'`
- [ ] No inline styles - use existing CSS/Tailwind patterns
- [ ] Export component as named export

**Best Practices:**
- Check `components/` for similar components to follow patterns
- Use existing hooks from `lib/hooks/` if applicable
- Prefer composition over prop drilling
- Keep components focused - single responsibility

**Constraints:**
- Working directory: [worktree path]
- Do NOT create test files (handled separately)
- Do NOT add new dependencies without explicit approval

**Deliverable:**
Report: files created, component name, props interface
```

---

### Type Definition Template

**Use for:** TypeScript types, interfaces, enums, type utilities

```markdown
## Task: Create Type Definitions

**File:** [path]
**Types needed:** [list]

**Requirements:**
- [ ] Export all types (no internal-only types)
- [ ] Use strict types - avoid `any`, prefer `unknown` if needed
- [ ] Add JSDoc comments for complex types explaining purpose
- [ ] Match database schema if types represent DB entities
- [ ] Use consistent naming: `PascalCase` for types/interfaces

**Best Practices:**
- Check `types/` for existing type patterns
- Prefer interfaces for object shapes (extendable)
- Use type aliases for unions, intersections, utilities
- Export from index file if creating new type module

**Constraints:**
- Working directory: [worktree path]
- Verify types compile: `npx tsc --noEmit [file]`

**Deliverable:**
Report: types created, file path, any dependencies on other types
```

---

### CLI/Script Template

**Use for:** CLI commands, scripts, automation tools

```markdown
## Task: Implement CLI Command/Script

**Command:** [name]
**File:** [path]

**Requirements:**
- [ ] Use commander.js patterns from existing commands (if CLI)
- [ ] Include descriptive --help text
- [ ] Handle errors gracefully with appropriate exit codes
- [ ] Add to command index if this is a new CLI command
- [ ] Support both programmatic and CLI usage if applicable

**Best Practices:**
- Check `scripts/` or `src/cli/` for existing patterns
- Use `process.exit(0)` for success, `process.exit(1)` for errors
- Log errors to stderr: `console.error()`
- Provide progress feedback for long-running operations

**Constraints:**
- Working directory: [worktree path]
- Scripts should be executable: `chmod +x [file]`
- Add shebang for shell scripts: `#!/usr/bin/env bash` or `#!/usr/bin/env node`

**Deliverable:**
Report: script created, command usage, exit codes
```

---

### Test Template

**Use for:** Unit tests, integration tests, test utilities

```markdown
## Task: Create Tests

**Test file:** [path]
**Testing:** [component/module being tested]

**Requirements:**
- [ ] Use existing test framework patterns (vitest/jest)
- [ ] Include setup and teardown if needed
- [ ] Test both success and error cases
- [ ] Use descriptive test names: `it('should X when Y')`
- [ ] Mock external dependencies appropriately

**Best Practices:**
- Check `__tests__/` or `*.test.ts` files for patterns
- Group related tests with `describe()` blocks
- Test behavior, not implementation details
- Aim for meaningful coverage, not 100% line coverage

**Constraints:**
- Working directory: [worktree path]
- Run tests after creation: `npm test [file]`
- Do NOT skip or disable existing tests

**Deliverable:**
Report: test file created, number of test cases, pass/fail status
```

---

### Refactor Template

**Use for:** Code restructuring, file reorganization, pattern migrations

```markdown
## Task: Refactor Code

**Target:** [file or module]
**Goal:** [what the refactor achieves]

**Requirements:**
- [ ] Preserve all existing functionality (no behavior changes)
- [ ] Maintain or improve type safety
- [ ] Update all imports/exports affected by moves
- [ ] Ensure tests still pass after refactor

**Best Practices:**
- Make incremental changes, verify after each step
- Use IDE rename features when available
- Update barrel exports (index.ts) if file locations change
- Check for circular dependencies after restructuring

**Constraints:**
- Working directory: [worktree path]
- Run full test suite after refactor: `npm test`
- Run type check: `npx tsc --noEmit`

**Deliverable:**
Report: files changed, imports updated, test results
```

---

### Generic Template

**Use for:** Tasks that don't fit other categories

```markdown
## Task: [Task Description]

**Goal:** [what needs to be accomplished]
**Files involved:** [expected files]

**Requirements:**
- [ ] Complete the task as specified
- [ ] Follow existing codebase patterns
- [ ] Maintain type safety
- [ ] Do not break existing functionality

**Constraints:**
- Working directory: [worktree path]
- Run relevant checks after completion

**Deliverable:**
Report: files created/modified, summary of changes
```

---

## Error Recovery Template

**Use for:** Retrying failed tasks with enhanced context

When a task fails, use this template to provide diagnostic context for the retry:

```markdown
## RETRY: Previous Attempt Failed

**Original Task:** [task description]
**Attempt:** [N] of [max]
**Previous Error:**
```
[error message from TaskOutput]
```

**Diagnosis Checklist:**
- [ ] Check imports are correct and files exist
- [ ] Verify file paths use the worktree directory
- [ ] Confirm types match expected signatures
- [ ] Look for typos in identifiers
- [ ] Check for missing dependencies

**Fix Strategy:**
1. Read the failing file to understand current state
2. Identify the specific error location (line number if available)
3. Apply minimal, targeted fix
4. Verify fix compiles: `npx tsc --noEmit [file]`

**Critical Constraints (re-emphasized):**
- You MUST use the worktree path: [worktree path]
- Do NOT edit files outside the worktree
- Complete the task with fewer tool calls than previous attempt
- If the same error occurs, report it clearly rather than retrying

**Deliverable:**
Report: fix applied, verification result, files changed
```

---

## Template Customization

### Adding New Templates

To add a custom template:

1. Define the template in this file following the structure above
2. Add keywords for automatic selection to the keyword table
3. Document the use case and best practices

### Overriding Templates

Projects can override templates by:

1. Creating `.claude/skills/_shared/references/prompt-templates.local.md`
2. Defining custom templates with the same headers
3. Local templates take precedence over defaults

### Template Variables

Templates support these placeholders:

| Variable | Description |
|----------|-------------|
| `[name]` | Component/module name from task |
| `[path]` | File path from task |
| `[worktree path]` | Current worktree directory |
| `[task description]` | Original task text |

---

## Usage Example

**Task:** "Create MetricsCard component in components/admin/metrics/"

**Keyword detected:** "component" → Component Template

**Rendered prompt:**
```markdown
## Task: Create React Component

**Component:** MetricsCard
**Location:** components/admin/metrics/MetricsCard.tsx

**Requirements:**
- [ ] TypeScript with proper prop types (interface or type)
- [ ] Follow existing component patterns in the codebase
- [ ] Include displayName for debugging: `MetricsCard.displayName = 'MetricsCard'`
- [ ] No inline styles - use existing CSS/Tailwind patterns
- [ ] Export component as named export

**Best Practices:**
- Check `components/` for similar components to follow patterns
- Use existing hooks from `lib/hooks/` if applicable
- Prefer composition over prop drilling
- Keep components focused - single responsibility

**Constraints:**
- Working directory: /path/to/worktrees/feature/123-metrics/
- Do NOT create test files (handled separately)
- Do NOT add new dependencies without explicit approval

**Deliverable:**
Report: files created, component name, props interface
```

---

## References

- [Subagent Types](./subagent-types.md) - Valid subagent types for Task tool
- `/exec` skill - Parallel execution documentation
- `/spec` skill - Parallel groups format
