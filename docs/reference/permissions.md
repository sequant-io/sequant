# Permission Precedence

Claude Code uses a layered permission system. Understanding how these layers interact prevents unexpected behavior when combining `allow`, `ask`, and `deny` rules.

## Permission Layers

Permissions are defined at three levels:

| Layer | Location | Scope |
|-------|----------|-------|
| **Tool-level** | `permissions.allow`, `permissions.ask`, `permissions.deny` | Entire tool (e.g., `Bash`) |
| **Content-level** | `permissions.allow`, `permissions.ask`, `permissions.deny` | Specific tool invocations (e.g., `Bash(rm *)`) |
| **Skill frontmatter** | `allowed-tools:` in `SKILL.md` | Tools available within a skill |

## Precedence Rules

**Content-level rules override tool-level rules.** More specific patterns take priority over less specific ones.

The evaluation order is:

```
1. deny   (content-level)  ← highest priority
2. ask    (content-level)
3. allow  (content-level)
4. deny   (tool-level)
5. ask    (tool-level)
6. allow  (tool-level)     ← lowest priority
```

## Example: allow + ask Interaction

Consider this configuration in `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Bash"],
    "ask": ["Bash(rm *)"]
  }
}
```

**Behavior:** All Bash commands run without prompting, **except** commands matching `rm *`, which trigger a permission prompt.

| Command | Rule Matched | Result |
|---------|-------------|--------|
| `Bash(ls -la)` | `allow: ["Bash"]` (tool-level) | Runs automatically |
| `Bash(npm test)` | `allow: ["Bash"]` (tool-level) | Runs automatically |
| `Bash(rm -rf dist/)` | `ask: ["Bash(rm *)"]` (content-level) | Prompts for approval |
| `Bash(rm temp.txt)` | `ask: ["Bash(rm *)"]` (content-level) | Prompts for approval |

The content-level `ask` for `Bash(rm *)` overrides the tool-level `allow` for `Bash` because content-level rules are more specific.

> **Note:** Prior to Claude Code v2.1.27, `allow: ["Bash"]` would allow all Bash commands regardless of content-level `ask` rules. This was fixed so that content-level rules always take precedence.

## Configuration Locations

| File | Applies To | Managed By |
|------|-----------|------------|
| `~/.claude/settings.json` | All projects (user-level) | User |
| `.claude/settings.json` | This project | sequant (package-managed) |
| `.claude/.local/settings.json` | This project (overrides) | User |
| `SKILL.md` frontmatter | Within a specific skill | Skill author |

### Project settings (`.claude/settings.json`)

```json
{
  "permissions": {
    "deny": ["Read(./.entire/metadata/**)"]
  }
}
```

### Skill frontmatter (`allowed-tools:`)

```yaml
---
allowed-tools:
  - Bash(npm run deploy:*)
  - Bash(gh workflow run:*)
---
```

Skill `allowed-tools` restrict which tools a skill can use. They do not override project or user-level `deny` rules.

## Common Patterns

### Allow a tool but restrict dangerous operations

```json
{
  "permissions": {
    "allow": ["Bash"],
    "ask": ["Bash(rm *)", "Bash(git push *)"],
    "deny": ["Bash(rm -rf /)"]
  }
}
```

### Deny specific file reads

```json
{
  "permissions": {
    "deny": ["Read(.env)", "Read(.env.local)", "Read(**/credentials.*)"]
  }
}
```

## Orchestrator-only guards

Some `pre-tool.sh` refusals apply only when a phase agent runs under `sequant run` (the `SEQUANT_ORCHESTRATOR` environment variable is set); interactive sessions are untouched.

- **Background tasks are refused** — a `Monitor` tool call, or a Bash call with `run_in_background: true`, is blocked with `HOOK_BLOCKED: Background tasks never notify a phase agent`. Inside a phase the completion notification never arrives: the phase ends the moment the agent's turn ends, and any work still uncommitted is stranded. Run long commands in the foreground with a timeout instead (`timeout 600 npm test 2>&1 | tail -80`), after a WIP commit. If an exec phase still ends with uncommitted changes, sequant commits them as `chore(#N): wip checkpoint …` before reporting the failure.

## See Also

- [Customization Guide](../guides/customization.md) -- overriding settings safely
- [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code) -- upstream permission reference
