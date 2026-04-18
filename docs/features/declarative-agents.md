# Declarative Agent Definitions

Sequant defines reusable agent profiles in `.claude/agents/*.md` instead of duplicating configuration inline in skill files. Each agent centralizes model, permissions, effort, maxTurns, and tool restrictions.

## Prerequisites

1. **Claude Code v2.1.63+** — custom agents require the `Agent()` syntax (replaces `Task()`)
2. **Sequant initialized** — run `sequant init` to copy agent definitions to `.claude/agents/`

Verify agents are in place:

```bash
ls .claude/agents/sequant-*.md
```

Expected: `sequant-explorer.md`, `sequant-implementer.md`, `sequant-qa-checker.md`, `sequant-testgen.md`

## Setup

Agent definitions are automatically copied during `sequant init` from `templates/agents/` to `.claude/agents/`. No manual setup is needed.

To verify the init copied them correctly:

```bash
diff .claude/agents/sequant-qa-checker.md templates/agents/sequant-qa-checker.md
```

## What You Can Do

Agents are invoked automatically by sequant skills — you don't call them directly. Each skill references agents by name:

- `/spec` spawns `sequant-explorer` for codebase exploration
- `/qa` spawns `sequant-qa-checker` for type safety, scope, and security checks
- `/exec` spawns `sequant-implementer` for parallel implementation tasks
- `/testgen` spawns `sequant-testgen` for test stub generation

### Customize an Agent

Edit the agent definition in `.claude/agents/` to change behavior project-wide. For example, to increase the QA checker's turn limit:

```yaml
# .claude/agents/sequant-qa-checker.md (frontmatter)
maxTurns: 25  # was 15
```

All `/qa` runs will use the new limit without touching any skill files.

### Override Per-User

Place a same-named file in `~/.claude/agents/` to override the project-level definition. Claude Code resolves agents in this order:

1. Managed settings
2. `--agents` CLI flag
3. `.claude/agents/` (project-level)
4. `~/.claude/agents/` (user-level)
5. Plugin agents

## Agent Reference

| Agent | Used By | Model | Permission Mode | Tools |
|-------|---------|-------|-----------------|-------|
| `sequant-explorer` | `/spec` | haiku | default | Read, Grep, Glob |
| `sequant-qa-checker` | `/qa` | haiku | bypassPermissions | Read, Grep, Glob, Bash |
| `sequant-implementer` | `/exec` | inherits | bypassPermissions | all |
| `sequant-testgen` | `/testgen` | haiku | default | Read, Grep, Glob, Write |

### sequant-explorer

Read-only codebase exploration for the `/spec` phase. Searches for existing patterns, components, and file structures before planning.

- **No Bash access** — cannot run commands
- **No Edit/Write** — cannot modify files
- **maxTurns:** 15

### sequant-qa-checker

Quality check agent for `/qa`. Runs type safety, scope/size, security, and documentation checks on diffs.

- **bypassPermissions** — needs Bash for `git diff`, `npm test`, etc.
- **effort: low** — optimized for fast, focused checks
- **maxTurns:** 15

### sequant-implementer

Implementation agent for `/exec` parallel groups. Handles component creation, type definitions, and refactoring.

- **No model set** — inherits from parent, so the skill can override per-invocation (e.g., `model="haiku"` for subtasks)
- **bypassPermissions** — needs full tool access for implementation
- **maxTurns:** 25

### sequant-testgen

Test stub generator for `/testgen`. Parses verification criteria and generates Jest/Vitest stubs.

- **No Bash access** — cannot run commands
- **Has Write** — needs to output test file content
- **maxTurns:** 25

## Agent Definition Format

Each agent is a Markdown file with YAML frontmatter:

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
---

System prompt for the agent goes here.
```

**Key fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Must match filename (without `.md`) |
| `description` | Yes | Tells Claude when to delegate to this agent |
| `model` | No | Defaults to inheriting from parent |
| `permissionMode` | No | `bypassPermissions` for agents needing Bash |
| `effort` | No | `low` for fast, focused tasks |
| `maxTurns` | No | Limits agent execution length |
| `tools` | No | Restricts available tools |

## What to Expect

Agent behavior is identical to the previous inline `Task()` pattern — same permissions, same models, same tool access. The only change is where the configuration lives.

- `/qa` quality checks still run without permission prompts (bypassPermissions)
- `/spec` exploration is still read-only (no Bash/Edit/Write)
- `/exec` parallel/sequential mode is still controlled by the skill, not the agent definition

## Troubleshooting

### Agent not found at runtime

**Symptoms:** Claude Code falls back to a generic agent or fails to spawn.

**Solution:** Verify the agent file exists and the name matches:

```bash
ls .claude/agents/sequant-*.md
# Should list 4 files

# Check name field matches filename
head -2 .claude/agents/sequant-qa-checker.md
# Should show: name: sequant-qa-checker
```

If files are missing, re-run `sequant init` to copy from templates.

### Permission prompts appearing for /qa checks

**Symptoms:** QA quality check agents ask for Bash approval instead of running automatically.

**Solution:** Verify `permissionMode: bypassPermissions` is set in `.claude/agents/sequant-qa-checker.md`. This was the fix for #352.

### Skill still shows old Task() syntax

**Symptoms:** A skill file references `Task(subagent_type=...)` instead of `Agent(...)`.

**Solution:** Re-run `sequant init` to update skill files from templates, or manually update the `allowed-tools` header and spawn site references in the affected SKILL.md.

---

*Generated for Issue #484 on 2026-04-07*
