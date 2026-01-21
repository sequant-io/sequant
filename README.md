# Sequant

**Workflow automation for [Claude Code](https://claude.ai/code).**

Solve GitHub issues with structured phases and quality gates — from issue to merge-ready PR.

[![npm version](https://img.shields.io/npm/v/sequant.svg)](https://www.npmjs.com/package/sequant)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

## Quick Start

```bash
# In your project directory
npx sequant init
npx sequant doctor   # Verify setup
```

Then in Claude Code:

```
/fullsolve 123    # Solve issue #123 end-to-end
```

Or step-by-step:

```
/spec 123    # Plan implementation
/exec 123    # Build in isolated worktree
/qa 123      # Review before merge
```

### Prerequisites

- [Claude Code](https://claude.ai/code) — AI coding assistant
- [GitHub CLI](https://cli.github.com/) — run `gh auth login`
- Node.js 18+ and Git

---

## How It Works

Sequant adds slash commands to Claude Code that enforce a structured workflow:

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│  /spec  │───▶│  /exec  │───▶│  /test  │───▶│   /qa   │───▶ Merge
└─────────┘    └─────────┘    └─────────┘    └─────────┘
     │              │              │              │
     ▼              ▼              ▼              ▼
   Plan          Build        Verify (UI)     Review
```

> `/test` is optional — used for UI features when Chrome DevTools MCP is available.

### Quality Gates

Every `/qa` runs automated checks:

- **AC Adherence** — Code verified against acceptance criteria
- **Type Safety** — Detects `any`, `as any`, missing types
- **Security Scans** — OWASP-style vulnerability detection
- **Scope Analysis** — Flags changes outside issue scope
- **Execution Evidence** — Scripts/CLI must pass smoke tests
- **Test Quality** — Validates test coverage and mock hygiene
- **Anti-Pattern Detection** — Catches N+1 queries, empty catch blocks, stale dependencies

When checks fail, `/loop` automatically fixes and re-runs (up to 3x).

---

## Two Ways to Use

### Interactive (Claude Code)

Type commands directly in Claude Code chat:

```
/fullsolve 123              # Complete pipeline
/spec 123 → /exec → /qa     # Step by step
```

### Headless (CLI)

Run without Claude Code UI:

```bash
npx sequant run 123              # Single issue
npx sequant run 1 2 3            # Batch (parallel)
npx sequant run 123 --quality-loop
npx sequant run 123 --base feature/dashboard  # Custom base branch
```

---

## Commands

### Core Workflow

| Command | Purpose |
|---------|---------|
| `/spec` | Plan implementation, draft acceptance criteria |
| `/exec` | Implement in isolated git worktree |
| `/test` | Browser-based UI testing (optional) |
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
| `/clean` | Repository cleanup |
| `/security-review` | Deep security analysis |
| `/reflect` | Workflow improvement analysis |

---

## CLI Commands

```bash
npx sequant init              # Initialize in project
npx sequant update            # Update skill templates
npx sequant doctor            # Check installation
npx sequant status            # Show version and config
npx sequant run <issues...>   # Execute workflow
npx sequant state <cmd>       # Manage workflow state (init/rebuild/clean)
npx sequant stats             # View local workflow analytics
```

See [Run Command Options](docs/run-command.md), [State Command](docs/state-command.md), and [Analytics](docs/analytics.md) for details.

---

## Configuration

```json
// .sequant/settings.json
{
  "run": {
    "qualityLoop": false,
    "maxIterations": 3,
    "defaultBase": "feature/dashboard"  // Optional: custom default base branch
  }
}
```

See [Customization Guide](docs/customization.md) for all options.

---

## Platform Support

| Platform | Status |
|----------|--------|
| macOS | ✅ Full support |
| Linux | ✅ Full support |
| Windows WSL | ✅ Full support |
| Windows Native | ⚠️ CLI only |

---

## Documentation

- [Getting Started](docs/getting-started/installation.md)
- [Workflow Concepts](docs/concepts/workflow-phases.md)
- [Run Command](docs/run-command.md)
- [Feature Branch Workflows](docs/feature-branch-workflow.md)
- [Customization](docs/customization.md)
- [Troubleshooting](docs/troubleshooting.md)

Stack guides: [Next.js](docs/stacks/nextjs.md) · [Rust](docs/stacks/rust.md) · [Python](docs/stacks/python.md) · [Go](docs/stacks/go.md)

---

## License

MIT
