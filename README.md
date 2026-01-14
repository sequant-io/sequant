# Sequant

**Solve issues with confidence.**

From GitHub issue to merge-ready PR — verified at every step.

[![npm version](https://img.shields.io/npm/v/sequant.svg)](https://www.npmjs.com/package/sequant)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

## The Problem

AI coding assistants are powerful but unpredictable. Code quality varies, acceptance criteria get ignored, and half-finished features pollute your branches.

## The Solution

Sequant enforces a structured workflow with quality gates at every phase:

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│  /spec  │───▶│  /exec  │───▶│  /test  │───▶│   /qa   │───▶ Merge
└─────────┘    └─────────┘    └─────────┘    └─────────┘
     │              │              │              │
     ▼              ▼              ▼              ▼
   Plan          Build          Verify        Review
```

## Two Ways to Work

### Interactive (Claude Code Chat)

```bash
/fullsolve 123    # Complete pipeline with auto-fix loops

# Or individual phases
/spec 123         # Plan implementation
/exec 123         # Build in isolated worktree
/qa 123           # Quality review before merge
```

### Autonomous (Headless CLI)

```bash
npx sequant run 123              # Single issue
npx sequant run 1 2 3            # Parallel batch
npx sequant run 123 --quality-loop  # Auto-iterate until gates pass
```

## Quality Guardrails

Every `/qa` phase runs automated checks:

- **AC Adherence** — Code verified against issue's acceptance criteria
- **Type Safety** — Detects `any`, `as any`, missing types
- **Security Scans** — OWASP-style vulnerability detection
- **Scope Analysis** — Flags changes outside issue scope

When checks fail, the **quality loop** automatically:
1. Parses failure reasons
2. Applies targeted fixes
3. Re-runs verification
4. Iterates up to 3x

## Quick Start

### Prerequisites

- [Claude Code](https://claude.ai/code) — AI assistant
- [GitHub CLI](https://cli.github.com/) — `gh auth login` required
- Node.js 18+ and Git

### Setup

```bash
npx sequant init     # Initialize in your project
npx sequant doctor   # Verify installation
```

### First Workflow

```bash
/spec 123    # Plan implementation for issue #123
/exec 123    # Implement in isolated worktree
/qa 123      # Review before merge
```

## Commands

### Core Workflow

| Command | Purpose |
|---------|---------|
| `/spec` | Plan implementation, draft acceptance criteria |
| `/exec` | Implement in isolated git worktree |
| `/test` | Browser-based UI testing |
| `/qa` | Code review and quality gate |

### Automation

| Command | Purpose |
|---------|---------|
| `/fullsolve` | Complete pipeline in one command |
| `/solve` | Recommend optimal workflow for issue |
| `/loop` | Fix iteration when checks fail |

### Integration

| Command | Purpose |
|---------|---------|
| `/merger` | Multi-issue integration and merge |
| `/testgen` | Generate test stubs from spec |
| `/verify` | CLI/script execution verification |

### Utilities

| Command | Purpose |
|---------|---------|
| `/assess` | Issue triage and status assessment |
| `/docs` | Generate feature documentation |
| `/release` | Automated release workflow |
| `/clean` | Repository cleanup |
| `/security-review` | Deep security analysis |
| `/reflect` | Workflow improvement analysis |

## CLI Commands

```bash
npx sequant init              # Initialize in your project
npx sequant update            # Update templates from package
npx sequant doctor            # Check installation health
npx sequant status            # Show version and config
npx sequant run <issues...>   # Execute workflow for issues
```

See [Run Command Options](docs/run-command.md) for advanced usage.

## Optional MCP Integrations

Sequant works fully without MCP servers. These enhance specific workflows:

| MCP Server | Purpose |
|------------|---------|
| [Chrome DevTools](https://github.com/anthropics/anthropic-quickstarts/tree/main/mcp-chrome-devtools) | Browser automation for `/test` |
| [Context7](https://github.com/upstash/context7) | Library documentation lookup |
| [Sequential Thinking](https://github.com/anthropics/anthropic-quickstarts/tree/main/mcp-sequential-thinking) | Complex multi-step reasoning |

## Configuration

Configure defaults in `.sequant/settings.json`:

```json
{
  "run": {
    "qualityLoop": false,
    "maxIterations": 3,
    "timeout": 300
  }
}
```

See [Customization Guide](docs/customization.md) for full options.

## Platform Support

| Platform | Status |
|----------|--------|
| macOS | ✅ Full support |
| Linux | ✅ Full support |
| Windows WSL | ✅ Full support |
| Windows Native | ⚠️ CLI only |

## Documentation

- [Full Documentation](docs/index.md)
- [Run Command Options](docs/run-command.md)
- [Customization Guide](docs/customization.md)
- [MCP Integrations](docs/mcp-integrations.md)
- [Troubleshooting](docs/troubleshooting.md)
- Stack Guides: [Next.js](docs/stacks/nextjs.md) · [Rust](docs/stacks/rust.md) · [Python](docs/stacks/python.md) · [Go](docs/stacks/go.md)

## License

MIT
