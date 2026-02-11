# Sequant

**Workflow automation for [Claude Code](https://claude.ai/code).**

Solve GitHub issues with structured phases and quality gates — from issue to merge-ready PR.

[![npm version](https://img.shields.io/npm/v/sequant.svg)](https://www.npmjs.com/package/sequant)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

## Quick Start

### Install

```bash
# In your project directory
npm install sequant
npx sequant init     # Install skills to your project
npx sequant doctor   # Verify setup
```

To update:
```bash
npm update sequant
```

### Start Using

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

**Required:**
- [Claude Code](https://claude.ai/code) — AI coding assistant
- [GitHub CLI](https://cli.github.com/) — run `gh auth login`
- Git (for worktree-based isolation)

**For npm installation:**
- Node.js 18+

**Optional MCP servers (enhanced features):**
- `chrome-devtools` — enables `/test` for browser-based UI testing
- `sequential-thinking` — enhanced reasoning for complex decisions
- `context7` — library documentation lookup

> **Note:** Sequant is optimized for Node.js/TypeScript projects. The worktree workflow works with any git repository.

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

### Worktree Isolation

Sequant uses Git worktrees to isolate each issue's work:

```
your-project/           # Main repo (stays on main branch)
../worktrees/
  feature/
    123-add-login/     # Issue #123 worktree (feature branch)
    456-fix-bug/       # Issue #456 worktree (feature branch)
```

**Why worktrees?**
- Work on multiple issues simultaneously
- Never pollute your main branch
- Each issue has its own dependencies and build
- Safe to discard failed experiments

### Quality Gates

Every `/qa` runs automated checks:

- **AC Adherence** — Code verified against acceptance criteria
- **Type Safety** — Detects `any`, `as any`, missing types
- **Security Scans** — OWASP-style vulnerability detection
- **Semgrep Static Analysis** — Stack-aware rulesets, custom rules via `.sequant/semgrep-rules.yaml`
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
| `/testgen` | Generate test stubs from spec |
| `/verify` | CLI/script execution verification |
| `/setup` | Initialize Sequant in a project |

### Utilities

| Command | Purpose |
|---------|---------|
| `/assess` | Issue triage and status assessment |
| `/docs` | Generate feature documentation |
| `/clean` | Repository cleanup |
| `/improve` | Codebase analysis and improvement discovery |
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
npx sequant dashboard         # Launch real-time workflow dashboard
```

See [Run Command Options](docs/reference/run-command.md), [State Command](docs/reference/state-command.md), and [Analytics](docs/reference/analytics.md) for details.

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

See [Customization Guide](docs/guides/customization.md) for all options.

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

- [Quickstart](docs/guides/quickstart.md) — 5-minute guide
- [Complete Workflow](docs/guides/workflow.md) — Full workflow including post-QA patterns
- [Getting Started](docs/getting-started/installation.md)
- [What We've Built](docs/internal/what-weve-built.md) — Comprehensive project overview
- [What Is Sequant](docs/concepts/what-is-sequant.md) — Elevator pitch, pipeline diagram, architecture
- [Workflow Concepts](docs/concepts/workflow-phases.md)
- [Run Command](docs/reference/run-command.md)
- [Git Workflows](docs/guides/git-workflows.md)
- [Customization](docs/guides/customization.md)
- [Troubleshooting](docs/troubleshooting.md)

Stack guides: [Next.js](docs/stacks/nextjs.md) · [Rust](docs/stacks/rust.md) · [Python](docs/stacks/python.md) · [Go](docs/stacks/go.md)

---

## Feedback & Contributing

### Reporting Issues

- **Bug reports:** [Bug template](https://github.com/admarble/sequant/issues/new?template=bug.yml)
- **Feature requests:** [Feature template](https://github.com/admarble/sequant/issues/new?template=feature.yml)
- **Questions:** [GitHub Discussions](https://github.com/admarble/sequant/discussions)

### Using `/improve` for Feedback

Run `/improve` in Claude Code to analyze your codebase and create structured issues:

```
/improve              # Analyze entire codebase
/improve security     # Focus on security concerns
/improve tests        # Find test coverage gaps
```

The skill will present findings and offer to create GitHub issues automatically.

### Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

### Telemetry

Sequant does not collect any usage telemetry. See [docs/reference/telemetry.md](docs/reference/telemetry.md) for details.

---

## License

MIT
