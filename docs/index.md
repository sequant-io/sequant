# Sequant Documentation

**Solve issues with confidence.**

From GitHub issue to merge-ready PR — verified at every step.

---

## Quick Navigation

### Getting Started

- [Installation](getting-started/installation.md) — Install and configure Sequant
- [Your First Workflow](getting-started/first-workflow.md) — Solve your first issue
- [Prerequisites](getting-started/prerequisites.md) — Required tools and setup

### Core Concepts

- [Workflow Phases](concepts/workflow-phases.md) — How spec → exec → qa works
- [Quality Gates](concepts/quality-gates.md) — What gets checked and why
- [Two Modes](concepts/two-modes.md) — Interactive vs autonomous execution
- [Worktree Isolation](concepts/worktree-isolation.md) — Git worktree strategy

### Command Reference

| Category | Commands |
|----------|----------|
| **Core Workflow** | `/spec` · `/exec` · `/test` · `/qa` |
| **Automation** | `/fullsolve` · `/solve` · `/loop` |
| **Integration** | `/merger` · `/testgen` · `/verify` |
| **Utilities** | `/assess` · `/docs` · `/release` · `/clean` · `/security-review` · `/reflect` |

> Command documentation is in `.claude/skills/<command>/SKILL.md`. Individual reference pages coming soon.

### Guides

- [Run Command Options](run-command.md) — Batch execution and CLI options
- [Customization](customization.md) — Override templates safely
- [MCP Integrations](mcp-integrations.md) — Optional MCP server setup
- [Git Patterns](git-patterns.md) — Worktree and merge workflows

### Stack-Specific Guides

- [Next.js](stacks/nextjs.md)
- [Rust](stacks/rust.md)
- [Python](stacks/python.md)
- [Go](stacks/go.md)

### Troubleshooting

- [Common Issues](troubleshooting.md) — Solutions to frequent problems
- [Platform Requirements](platform-requirements.md) — GitHub dependency and alternatives

---

## Why Sequant?

When using AI coding assistants, work can become scattered and quality inconsistent. Sequant solves this by:

- **Consistent quality** — Every issue goes through the same review gates
- **Traceable decisions** — Plans and progress documented in GitHub issues
- **Isolated work** — Git worktrees prevent half-finished features from polluting main
- **AI-assisted** — Claude Code handles implementation while you review and approve

---

## Get Started

```bash
# Install and initialize
npx sequant init

# Verify setup
npx sequant doctor

# Start with any issue
/spec 123
```

See [Your First Workflow](getting-started/first-workflow.md) for a complete walkthrough.
