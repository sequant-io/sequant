# MCP Integrations

**Quick Start:** Sequant works fully without any MCP servers, but optional integrations enhance browser testing, library documentation lookup, and complex reasoning capabilities.

## Overview

MCP (Model Context Protocol) servers extend Claude's capabilities with specialized tools. Sequant supports three optional MCP integrations that enhance specific workflows.

> **Looking for Sequant's own MCP server?** This guide covers the *optional third-party* MCPs below. Sequant also ships its **own** MCP server (`sequant serve`, tools `sequant_status`/`sequant_run`/`sequant_logs`), configured in `.mcp.json`. It's pinned to your installed version rather than `@latest` so reconnects don't reinstall on every release (#793) — `sequant init` writes the pin and `sequant update` refreshes it. See [MCP Server → Version pinning](../features/mcp-server.md#add-the-mcp-config), and [Troubleshooting → MCP Server Issues](../troubleshooting.md#mcp-server-issues) if a reconnect fails with `-32000`.

## Supported MCPs

| MCP Server | Skills Enhanced | Purpose |
|------------|-----------------|---------|
| [Chrome DevTools](https://github.com/anthropics/anthropic-quickstarts/tree/main/mcp-chrome-devtools) | `/test`, `/testgen`, `/loop` | Browser automation for UI testing |
| [Context7](https://github.com/upstash/context7) | `/exec`, `/fullsolve` | External library documentation lookup |
| [Sequential Thinking](https://github.com/anthropics/anthropic-quickstarts/tree/main/mcp-sequential-thinking) | `/fullsolve` | Complex multi-step reasoning |

## Checking MCP Status

Run the doctor command to see which MCPs are configured:

```bash
npx sequant doctor
```

Example output:
```
✓ MCP Servers: Some MCPs configured: sequential-thinking
⚠ MCP: chrome-devtools: Not configured (optional, enhances /test, /testgen, /loop)
⚠ MCP: context7: Not configured (optional, enhances /exec, /fullsolve)
```

**Note:** This check currently detects MCPs from your Claude Desktop config, which is a different source than the `.mcp.json` phase agents actually use for `sequant run` (#936) — a server present here may still be unavailable headlessly, and vice versa. To see what a phase will actually get, check the project's `.mcp.json` directly.

## Installation

Add these to the project's `.mcp.json` (the same file `sequant init` already writes a `sequant` entry into) — not your Claude Desktop config. `sequant run` phase agents read only `.mcp.json` and never pass through your Claude Desktop config (#936), so a server configured only in Claude Desktop is invisible to `/test`, `/exec`, and `/fullsolve` when they run headlessly.

### Chrome DevTools MCP

Enables automated browser testing with snapshots, screenshots, and interaction recording.

1. Follow the [setup guide](https://github.com/anthropics/anthropic-quickstarts/tree/main/mcp-chrome-devtools#setup) for the exact `command`/`args`
2. Add the resulting entry to `.mcp.json`'s `mcpServers` object at the project root

**Without this MCP:** The `/test` skill falls back to generating manual test checklists instead of automated browser tests.

### Context7 MCP

Provides up-to-date library documentation during implementation.

Add an entry to `.mcp.json`:

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    }
  }
}
```

**Without this MCP:** The `/exec` skill uses codebase search and general knowledge instead of fetching current library docs.

### Sequential Thinking MCP

Enables extended reasoning for complex multi-step problems.

1. Follow the [setup guide](https://github.com/anthropics/anthropic-quickstarts/tree/main/mcp-sequential-thinking#setup) for the exact `command`/`args`
2. Add the resulting entry to `.mcp.json`'s `mcpServers` object at the project root

**Without this MCP:** The `/fullsolve` skill uses standard reasoning without extended thinking chains.

**`.mcp.json` is committed to git** — don't put literal secrets in an entry's `env`. An MCP that needs a credential isn't a good fit for phase-agent use; keep it in your interactive Claude Code / Claude Desktop config instead.

## Behavior Without MCPs

Sequant is designed to work without any MCPs. Here's what changes:

| Scenario | With MCP | Without MCP |
|----------|----------|-------------|
| `/test` command | Automated browser snapshots and interactions | Manual test checklist generated |
| `/exec` library lookup | Fetches current docs from Context7 | Uses codebase patterns and general knowledge |
| `/fullsolve` reasoning | Extended thinking for complex problems | Standard reasoning approach |

## Troubleshooting

### MCP not detected by doctor command

**Symptoms:** You installed an MCP but `sequant doctor` still shows it as not configured.

**Solution:**
1. Verify the MCP is in your Claude Desktop config file
2. Check the server name matches expected patterns (e.g., contains "chrome-devtools", "context7", or "sequential-thinking")
3. Restart Claude Desktop after config changes

### Skills fail with MCP errors

**Symptoms:** Error messages about missing MCP tools when running skills.

**Solution:**
1. Run `sequant doctor` to check MCP status
2. If MCP is optional for your use case, the skill should fall back gracefully
3. If you need MCP functionality, install following the guides above

### Claude Desktop config location

| Platform | Config Path |
|----------|-------------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/claude/claude_desktop_config.json` |

---

*Generated for Issue #15 on 2025-01-10*
