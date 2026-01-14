# Prerequisites

Before using Sequant, ensure you have the following tools installed and configured.

## Required

### Claude Code

Sequant is built for [Claude Code](https://claude.ai/code), Anthropic's AI coding assistant.

```bash
# Verify installation
claude --version
```

### GitHub CLI

The GitHub CLI (`gh`) is required for issue integration. You must be authenticated.

```bash
# Install (macOS)
brew install gh

# Install (Linux)
apt install gh

# Authenticate
gh auth login

# Verify
gh auth status
```

### Node.js 18+

Node.js 18 or higher is required for the CLI.

```bash
# Check version
node --version
# Should output v18.x.x or higher
```

### Git

Git is required for worktree support.

```bash
# Check version
git --version
```

## Optional

### jq

[jq](https://jqlang.github.io/jq/) improves hook performance but is not required. Sequant falls back to grep if jq is not installed.

```bash
# Install (macOS)
brew install jq

# Install (Linux)
apt install jq

# Verify
jq --version
```

### MCP Servers

Sequant works fully without MCP servers, but these optional integrations enhance specific workflows:

- **Chrome DevTools MCP** — Browser automation for `/test` and `/testgen`
- **Context7 MCP** — Library documentation lookup during `/exec`
- **Sequential Thinking MCP** — Complex reasoning for `/fullsolve`

See [MCP Integrations](../mcp-integrations.md) for setup instructions.

## Platform Notes

| Platform | Status | Notes |
|----------|--------|-------|
| macOS | ✅ Full support | All features work |
| Linux | ✅ Full support | Bash required |
| Windows WSL | ✅ Full support | Use WSL2 |
| Windows Native | ⚠️ Limited | CLI works, shell scripts require WSL |

For Windows users, we recommend using [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) for the full Sequant experience.

## Verification

Run the doctor command to check all prerequisites:

```bash
npx sequant doctor
```

This command verifies:
- Node.js version
- GitHub CLI authentication
- Git availability
- Optional MCP configurations
