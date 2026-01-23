# Claude Code Subagent Types

Reference for valid subagent types when spawning agents via the `Task` tool.

## Valid Types

Claude Code supports exactly **4 subagent types**:

| Type | Purpose | Tools Available |
|------|---------|-----------------|
| `Bash` | Command execution, git operations, terminal tasks | Bash only |
| `general-purpose` | Multi-step tasks needing file access + commands | All tools |
| `Explore` | Codebase exploration, file search, pattern finding | Read-only tools |
| `Plan` | Architecture planning, implementation design | Read-only tools |

## When to Use Each

### `Bash`
Best for: Single command execution, git operations, build commands

```
Task(subagent_type="Bash", prompt="Run npm test and report results")
```

### `general-purpose`
Best for: Implementation tasks, quality checks, multi-file operations

```
Task(subagent_type="general-purpose",
     prompt="Run type safety checks on the diff. Report: type issues, verdict.")
```

**Use cases:**
- Quality checks (type safety, security scan, scope analysis)
- Implementation tasks requiring edits
- Tasks needing both file reading and command execution

### `Explore`
Best for: Codebase search, pattern discovery, schema inspection

```
Task(subagent_type="Explore",
     prompt="Find similar components in components/admin/. Report patterns.")
```

**Use cases:**
- Finding existing patterns before implementing new features
- Searching for file locations
- Understanding codebase structure
- Schema and database inspection

### `Plan`
Best for: Designing implementation approaches, architectural decisions

```
Task(subagent_type="Plan",
     prompt="Design the implementation approach for adding user auth.")
```

**Use cases:**
- Creating implementation plans
- Evaluating architectural trade-offs
- Breaking down complex features

## Model Selection

| Model | When to Use | Cost |
|-------|-------------|------|
| `haiku` | Quick tasks, exploration, quality checks | Low |
| `sonnet` | Complex implementation, nuanced decisions | Medium |
| `opus` | Critical analysis, complex architecture | High |

**Default:** Use `haiku` unless the task requires deep reasoning.

```
Task(subagent_type="general-purpose",
     model="haiku",
     prompt="...")
```

## Common Patterns

### Parallel Quality Checks
```
Task(subagent_type="general-purpose", model="haiku",
     prompt="Check type safety on diff vs main. Report issues count.")

Task(subagent_type="general-purpose", model="haiku",
     prompt="Check for deleted tests in diff. Report count.")

Task(subagent_type="general-purpose", model="haiku",
     prompt="Run security scan on changed files. Report findings.")
```

### Context Gathering (Spec Phase)
```
Task(subagent_type="Explore", model="haiku",
     prompt="Find similar features in components/. Report patterns.")

Task(subagent_type="Explore", model="haiku",
     prompt="Explore database schema for user tables. Report structure.")
```

### Background Execution
```
Task(subagent_type="general-purpose",
     model="haiku",
     run_in_background=true,
     prompt="Implement the UserCard component...")
```

Use `TaskOutput(task_id="...", block=true)` to wait for completion.

## Invalid Types (Do Not Use)

These types do **not exist** and will cause silent failures:

- ~~`quality-checker`~~ → Use `general-purpose`
- ~~`pattern-scout`~~ → Use `Explore`
- ~~`schema-inspector`~~ → Use `Explore`
- ~~`code-reviewer`~~ → Use `general-purpose`
- ~~`implementation`~~ → Use `general-purpose`

See issue #170 for context on this fix.

## References

- [Claude Code Task Tool Documentation](https://docs.anthropic.com/claude-code)
- `/exec` skill parallel execution: `templates/skills/exec/SKILL.md`
- `/qa` skill quality checks: `templates/skills/qa/SKILL.md`
