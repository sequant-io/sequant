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
| **Automation** | `/fullsolve` · `/assess` · `/loop` |
| **Integration** | `/testgen` · `/verify` · `/merger` |
| **Utilities** | `/docs` · `/clean` · `/improve` · `/security-review` · `/reflect` |

> Command documentation is in `.claude/skills/<command>/SKILL.md`. Individual reference pages coming soon.

### Guides

- [Write Issues Sequant Can Execute](guides/writing-issues.md) — The issue format Sequant plans and checks against, with a copy-paste template
- [Complete Workflow](guides/workflow.md) — Full workflow including post-QA patterns
- [Customization](guides/customization.md) — Override templates safely
- [MCP Integrations](guides/mcp-integrations.md) — Optional MCP server setup
- [Git Workflows](guides/git-workflows.md) — Worktree and merge workflows
- [Writing an Agent Driver](guides/writing-an-agent-driver.md) — The driver contract and the conformance suite that enforces it

### Features: when to use what

Running issues
- [Parallel Execution](features/parallel-execution.md) — Running several issues at once, and when to use `--sequential` or `--chain` instead
- [Stacked PRs](features/stacked-prs.md) — Chained issues that build on each other, one PR per issue
- [Spec Phase by Default](features/spec-by-default.md) — Which issues get a planning phase, and how to skip it
- [Automatic PR Creation](features/run-pr-creation.md) — When `sequant run` opens and updates the PR
- [Run Ready Gate](features/run-ready-gate.md) — Extra QA rounds before you merge (`--ready-gate`)

Reading results and recovering
- [QA Verdicts → Workflow States](features/qa-verdict-workflow-states.md) — What each QA verdict means and what happens next
- [QA Incremental Re-Runs](features/qa-incremental-rerun.md) — Faster QA re-runs that skip checks whose inputs haven't changed
- [Error Capture](features/error-capture.md) — Where a failed phase's error output goes

Other ways to run Sequant
- [MCP Server](features/mcp-server.md) — Driving runs from inside Claude Code or another MCP client
- [GitHub Actions Integration](features/github-actions-integration.md) — Running Sequant in CI from labels, comments or manual dispatch
- [Plugin Distribution](features/plugin-distribution.md) — Installing as a Claude Code plugin

Design decisions behind these behaviours are recorded in [docs/adr/](adr/README.md).

### Reference

- [Cheat Sheet](reference/cheat-sheet.md) — Quick reference for all commands, flags, and workflows
- [Run Command](reference/run-command.md) — Batch execution and CLI options
- [Checkout Modes](reference/checkout-modes.md) — Orchestrated, standalone and in-place (`SEQUANT_CHECKOUT=in-place`) checkouts for phase skills
- [Ready Command](reference/ready-command.md) — Post-resolve A+ QA gate (`sequant ready`)
- [Merge Command](reference/merge-command.md) — Post-QA integration and merge
- [Halt and Resume](reference/halt-and-resume.md) — Durable rate-limit recovery (`sequant resume`)
- [State Command](reference/state-command.md) — Workflow state management
- [Conventions Command](reference/conventions-command.md) — Codebase convention detection and overrides
- [Analytics](reference/analytics.md) — Usage tracking and metrics
- [Logging](reference/logging.md) — Log configuration
- [Telemetry](reference/telemetry.md) — Telemetry settings
- [Permissions](reference/permissions.md) — Permission precedence and configuration
- [Security: Trust Model](reference/security-trust-model.md) — Untrusted issue/PR text and prompt-injection hardening for public-repo runs
- [Threat Model](THREAT-MODEL.md) — Untrusted-input surfaces, deterministic vs model-dependent defenses, OWASP Agentic Top 10 mapping (CI-checked citations)
- [Security Policy](../SECURITY.md) — Vulnerability disclosure, response expectations, supported versions
- [Platform Requirements](reference/platform-requirements.md) — GitHub dependency and alternatives

### Stack-Specific Guides

- [Next.js](stacks/nextjs.md)
- [Rust](stacks/rust.md)
- [Python](stacks/python.md)
- [Go](stacks/go.md)

### Troubleshooting

- [Common Issues](troubleshooting.md) — Solutions to frequent problems


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
