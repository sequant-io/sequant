# Claude Code Subagent Types

Reference for valid subagent types when spawning agents via the `Agent` tool.

## Built-in Types

Claude Code supports exactly **4 built-in subagent types**:

| Type | Purpose | Tools Available |
|------|---------|-----------------|
| `Bash` | Command execution, git operations, terminal tasks | Bash only |
| `general-purpose` | Multi-step tasks needing file access + commands | All tools |
| `Explore` | Codebase exploration, file search, pattern finding | Read-only tools |
| `Plan` | Architecture planning, implementation design | Read-only tools |

## Custom Agents (Sequant)

Sequant defines **4 custom agents** in `.claude/agents/`. These centralize model, permissions, effort, and tool restrictions that were previously duplicated inline.

| Agent Name | Based On | Model | Permission Mode | Used By |
|------------|----------|-------|-----------------|---------|
| `sequant-explorer` | Explore | haiku | (default) | `/spec` |
| `sequant-qa-checker` | general-purpose | haiku | bypassPermissions | `/qa` |
| `sequant-implementer` | general-purpose | (inherits) | bypassPermissions | `/exec` |
| `sequant-testgen` | general-purpose | haiku | (default) | `/testgen` |

### sequant-explorer

Read-only codebase exploration for the `/spec` phase. No Bash, Edit, or Write access.

```
Agent(subagent_type="sequant-explorer",
     prompt="Find similar features in components/. Report patterns.")
```

### sequant-qa-checker

Quality check agent for the `/qa` phase. Has `bypassPermissions` for Bash access (git diff, npm test). Effort: low.

```
Agent(subagent_type="sequant-qa-checker",
     prompt="Run type safety checks on the diff. Report: type issues, verdict.")
```

### sequant-implementer

Implementation agent for `/exec` parallel groups. Inherits model from parent (user-configurable). Has `bypassPermissions` for full tool access.

```
Agent(subagent_type="sequant-implementer",
     prompt="Implement the UserCard component in components/admin/...")
```

### sequant-testgen

Test stub generator for the `/testgen` phase. Has Write access but no Bash access.

```
Agent(subagent_type="sequant-testgen",
     prompt="Generate test stubs for AC-1: User authentication...")
```

### Agent Definition Location

Custom agents are defined in `.claude/agents/*.md` with YAML frontmatter:

```markdown
---
name: sequant-qa-checker
description: Quality check agent for sequant QA phase.
model: haiku
permissionMode: bypassPermissions
effort: low
maxTurns: 15
tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Edit
---

[Agent behavioral instructions here]
```

### Agent Resolution Priority

Claude Code resolves agent names in this order:
1. Managed settings
2. `--agents` CLI flag
3. `.claude/agents/` (project-level) — sequant's agents live here
4. `~/.claude/agents/` (user-level) — users can override here
5. Plugin agents

## When to Use Each

### Built-in `Bash`
Best for: Single command execution, git operations, build commands

```
Agent(subagent_type="Bash", prompt="Run npm test and report results")
```

### Built-in `general-purpose`
Best for: Custom tasks that don't fit a sequant agent profile

```
Agent(subagent_type="general-purpose",
     prompt="Analyze the error logs and suggest fixes.")
```

**Use cases:**
- One-off tasks outside the sequant workflow
- Tasks needing a specific model/permission combination

### Built-in `Explore`
Best for: Ad-hoc codebase search outside the `/spec` workflow

```
Agent(subagent_type="Explore",
     prompt="Find all API routes in the project.")
```

### Built-in `Plan`
Best for: Designing implementation approaches, architectural decisions

```
Agent(subagent_type="Plan",
     prompt="Design the implementation approach for adding user auth.")
```

## Model Selection

| Model | When to Use | Cost |
|-------|-------------|------|
| `haiku` | Quick tasks, exploration, quality checks | Low |
| `sonnet` | Complex implementation, nuanced decisions | Medium |
| `opus` | Critical analysis, complex architecture | High |

**Default:** Use `haiku` unless the task requires deep reasoning.

Custom agents set their model in the agent definition, so you don't need to specify it inline:

```
# Model comes from .claude/agents/sequant-qa-checker.md (haiku)
Agent(subagent_type="sequant-qa-checker",
     prompt="...")
```

## Common Patterns

### Parallel Quality Checks (via /qa)
```
Agent(subagent_type="sequant-qa-checker",
     prompt="Check type safety on diff vs main. Report issues count.")

Agent(subagent_type="sequant-qa-checker",
     prompt="Check for deleted tests in diff. Report count.")

Agent(subagent_type="sequant-qa-checker",
     prompt="Run security scan on changed files. Report findings.")
```

### Context Gathering (via /spec)
```
Agent(subagent_type="sequant-explorer",
     prompt="Find similar features in components/. Report patterns.")

Agent(subagent_type="sequant-explorer",
     prompt="Explore database schema for user tables. Report structure.")
```

### Background Execution (via /exec)
```
Agent(subagent_type="sequant-implementer",
     run_in_background=true,
     prompt="Implement the UserCard component...")
```

Use `TaskOutput(task_id="...", block=true)` to wait for completion.

**IMPORTANT: Background agents and permissions**

Background agents cannot prompt for permission interactively. Custom agents with
`permissionMode: bypassPermissions` in their definition handle this automatically.
For built-in types, set `mode` explicitly when spawning background agents.

### Permission Mode Reference

| Mode | Edit/Write | Bash | When to Use |
|------|------------|------|-------------|
| `"acceptEdits"` | ✅ Auto-approved | ❌ **Denied** (prompts) | File-editing agents that don't need Bash |
| `"bypassPermissions"` | ✅ Auto-approved | ✅ Auto-approved | **Agents that need Bash** (quality checks, git commands) |
| (omitted) | ❌ Prompts | ❌ Prompts | Only if parent already auto-approves |

**Note:** Sequant's custom agents (`sequant-qa-checker`, `sequant-implementer`) have
`permissionMode` set in their agent definitions, so you don't need to specify `mode`
inline when spawning them.

### Choosing the Right Agent

| Task | Recommended Agent | Why |
|------|-------------------|-----|
| Quality checks (git diff, npm test) | `sequant-qa-checker` | bypassPermissions + haiku + effort:low |
| Codebase exploration | `sequant-explorer` | Read-only, haiku, focused tools |
| Implementation subtask | `sequant-implementer` | Full access, inherits model |
| Test stub generation | `sequant-testgen` | Write access, no Bash, haiku |
| One-off custom task | `general-purpose` | Flexible, specify model/mode inline |

**CRITICAL:** If your background agent runs `git diff`, `npm test`, `git status`, or any shell command, use `sequant-qa-checker` or `sequant-implementer` (both have bypassPermissions). Do NOT use `general-purpose` without `mode="bypassPermissions"` — Bash calls will silently fail.

### Security Considerations

`bypassPermissions` is safe when:
- Agent only reads/analyzes (quality checks, security scans)
- Agent runs in an isolated worktree
- Agent output is reviewed before any further action

`bypassPermissions` requires caution when:
- Agent could write to production files
- Agent could push to remote repositories
- Agent has access to secrets or credentials

## Invalid Types (Do Not Use)

These types do **not exist** and will cause silent failures:

- ~~`quality-checker`~~ → Use `sequant-qa-checker` or `general-purpose`
- ~~`pattern-scout`~~ → Use `sequant-explorer` or `Explore`
- ~~`schema-inspector`~~ → Use `sequant-explorer` or `Explore`
- ~~`code-reviewer`~~ → Use `sequant-qa-checker` or `general-purpose`
- ~~`implementation`~~ → Use `sequant-implementer` or `general-purpose`

See issue #170 for context on this fix.

## References

- [Claude Code Custom Subagents](https://code.claude.com/docs/en/sub-agents)
- Agent definitions: `.claude/agents/*.md`
- `/exec` skill parallel execution: `templates/skills/exec/SKILL.md`
- `/qa` skill quality checks: `templates/skills/qa/SKILL.md`
