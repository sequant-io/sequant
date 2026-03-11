# Sequant Documentation

**Solve issues with confidence.**

From GitHub issue to merge-ready PR — verified at every step.

---

## Quick Navigation

### Getting Started

- [Quickstart](guides/quickstart.md) — Zero to first solved issue in 5 minutes
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
| **Integration** | `/testgen` · `/verify` · `/merger` |
| **Utilities** | `/assess` · `/docs` · `/clean` · `/improve` · `/security-review` · `/reflect` |

> Command documentation is in `.claude/skills/<command>/SKILL.md`. Individual reference pages coming soon.

### Guides

- [Complete Workflow](guides/workflow.md) — Full workflow including post-QA patterns
- [Customization](guides/customization.md) — Override templates safely
- [MCP Integrations](guides/mcp-integrations.md) — Optional MCP server setup
- [Git Workflows](guides/git-workflows.md) — Worktree and merge workflows

### Reference

- [Cheat Sheet](reference/cheat-sheet.md) — Quick reference for all commands, flags, and workflows
- [Run Command](reference/run-command.md) — Batch execution and CLI options
- [State Command](reference/state-command.md) — Workflow state management
- [Analytics](reference/analytics.md) — Usage tracking and metrics
- [Logging](reference/logging.md) — Log configuration
- [Telemetry](reference/telemetry.md) — Telemetry settings
- [Permissions](reference/permissions.md) — Permission precedence and configuration
- [Platform Requirements](reference/platform-requirements.md) — GitHub dependency and alternatives

### Stack-Specific Guides

- [Next.js](stacks/nextjs.md)
- [Rust](stacks/rust.md)
- [Python](stacks/python.md)
- [Go](stacks/go.md)

### Troubleshooting

- [Common Issues](troubleshooting.md) — Solutions to frequent problems

### Internal

- [What We've Built](internal/what-weve-built.md) — Project changelog and history
- [Release Checklist](internal/release-checklist.md) — Release process

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
