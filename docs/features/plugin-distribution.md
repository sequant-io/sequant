# Plugin Distribution

Sequant is available as a Claude Code plugin — install it directly from Claude Code without npm, and get skills, hooks, and MCP tools with zero configuration.

## Prerequisites

1. **Claude Code** — [claude.ai/code](https://claude.ai/code)
2. **GitHub CLI** — `gh auth status` (authenticated)
3. **Git** — any recent version
4. **Node.js 20+** — `node --version` (for MCP server via `npx`)

## Setup

### Install the plugin

In Claude Code:

```
/plugin install sequant@sequant-io/sequant
```

This loads:
- 17 workflow skills (`/assess`, `/spec`, `/exec`, `/qa`, `/fullsolve`, etc.)
- Pre/post-tool hooks (security guardrails, timing, smart tests)
- MCP server (`sequant_status`, `sequant_run`, `sequant_logs`)

### Configure your project

```
/sequant:setup
```

The setup skill:
- Checks prerequisites (git, gh, node)
- Creates `.sequant/settings.json` with defaults
- Detects your package manager and dev server URL
- Creates `../worktrees/feature/` directory
- Copies the constitution template to `.claude/memory/`
- Creates `.sequant-manifest.json` with stack info

## What You Can Do

After setup, all sequant workflows are available:

```
/assess 123        # Analyze issue, get recommended workflow
/fullsolve 123     # End-to-end: spec → exec → qa → PR
/spec 123          # Plan implementation
/exec 123          # Implement in isolated worktree
/qa 123            # Code review and AC validation
```

MCP tools are also available for programmatic access:

```
sequant_status     # Check issue progress
sequant_run        # Execute workflow phases
sequant_logs       # Review past run results
```

## What to Expect

- **Plugin install:** Instant — skills and hooks load immediately
- **`/sequant:setup`:** ~10 seconds — creates config and detects stack
- **MCP server:** Starts automatically via `npx sequant@latest serve` (stdio transport)
- **First `/fullsolve`:** 10–30 minutes depending on issue complexity

## Plugin vs npm

| Capability | Plugin | npm |
|-----------|--------|-----|
| Skills (17 slash commands) | Yes | Yes (via `sequant init`) |
| Hooks (guardrails, timing) | Yes | Yes (via `sequant init`) |
| MCP tools | Yes (auto) | Yes (via `.mcp.json`) |
| CLI (`sequant run`, `sequant doctor`) | No | Yes |
| CI/headless mode | No | Yes |
| TypeScript library exports | No | Yes |

**Plugin** is for interactive Claude Code users. **npm** is for power users, CI pipelines, and programmatic access.

## Configuration

After `/sequant:setup`, edit `.sequant/settings.json` to customize:

| Setting | Description | Default |
|---------|-------------|---------|
| `run.timeout` | Max phase duration (seconds) | `1800` |
| `run.qualityLoop` | Auto-iterate on QA failures | `false` |
| `run.maxIterations` | Max quality loop iterations | `3` |
| `run.smartTests` | Auto-run tests after edits | `true` |
| `run.pmRun` | Package manager run command | auto-detected |
| `run.devUrl` | Dev server URL for `/test` | auto-detected |
| `agents.parallel` | Parallel sub-agent execution | `false` |
| `agents.model` | Sub-agent model | `"haiku"` |

## MCP Server Details

The plugin bundles an MCP server that starts automatically:

```json
{
  "sequant": {
    "command": "npx",
    "args": ["-y", "sequant@latest", "serve"]
  }
}
```

**Tools:** `sequant_status`, `sequant_run`, `sequant_logs`
**Resources:** `sequant://state`, `sequant://config`
**Transport:** stdio (default, most compatible)

## Log Storage

Hook logs are stored in:
- **Plugin users:** `${CLAUDE_PLUGIN_DATA}/logs/` (persistent across updates)
- **npm/CI users:** `${TMPDIR:-/tmp}/` (session-scoped)

Log files: `claude-timing.log`, `claude-hook.log`, `claude-quality.log`, `claude-tests.log`

## Troubleshooting

### MCP tools not available after install

**Symptoms:** Skills work but `sequant_status` / `sequant_run` don't appear.

**Solution:** Verify Node.js 20+ is installed (`node --version`). The MCP server requires `npx` which ships with Node.js. Restart Claude Code after installing Node.

### `/sequant:setup` says "gh auth: not authenticated"

**Symptoms:** Prerequisites check fails on GitHub CLI.

**Solution:** Run `gh auth login` in your terminal, then re-run `/sequant:setup`.

### Settings not being picked up

**Symptoms:** Changed `.sequant/settings.json` but behavior doesn't change.

**Solution:** Verify the file is valid JSON (`cat .sequant/settings.json | jq .`). Settings are read fresh on each skill invocation — no restart needed.

### Plugin install says "not found"

**Symptoms:** `claude plugin install sequant@sequant-io/sequant` fails.

**Solution:** Verify you're using Claude Code v2.1+. Try the full path: `claude plugin install sequant@sequant-io/sequant`.

---

*Generated for Issue #476 on 2026-03-27*
